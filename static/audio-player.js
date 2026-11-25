/**
 * Low-latency 24kHz mono streaming player for Gemini Live API & Mode 2 congregation broadcast.
 * Supports:
 *   - Lossless 24kHz 16-bit signed LE PCM (`enqueuePcm16`)
 *   - Compressed 24kHz 8-bit G.711 μ-law (`enqueueUlaw24k`)
 *   - Native device AudioContext sampleRate (prevents iOS Safari / AirPods pitch & timbre mismatch)
 *   - Smooth jitter buffering + soft overflow drop (zero hard mid-word cutouts)
 *   - Hysteresis-stabilized speaking turn tracking (zero subtitle flickering)
 *   - Mobile lock-screen audio keepalive (silent WAV <audio> + MediaSession) & iOS "interrupted" resume
 */

// Precomputed ITU-T G.711 μ-law -> Float32 [-1, 1] lookup table
const ULAW_DECODE_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  if (sign) sample = -sample;
  ULAW_DECODE_LUT[i] = sample / 32768;
}

/** Generate a standard 16-bit 44.1kHz mono silent WAV Data URI (100% Apple CoreAudio compatible). */
function createSilentWavDataUri() {
  const sampleRate = 44100;
  const numSamples = 4410; // 100ms loop of 16-bit signed silence (0x0000) -> ~8.8 KB
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align (16-bit mono)
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  v.setUint32(40, dataBytes, true);
  // ArrayBuffer is zero-initialized (16-bit signed silence = 0)
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export class Pcm24kPlayer {
  constructor({
    onActiveTurnChange,
    onAudioLevel,
    onStateChange,
    lookaheadSeconds = 0.08,
    maxBufferSeconds = 2.2,
    turnClearHoldMs = 950,
    enableKeepAlive = false,
  } = {}) {
    this.sampleRate = 24000;
    this.ctx = null;
    this.gainNode = null;
    this.nextStartTime = 0;
    this.activeSources = new Set();
    this.volume = 1.0;
    this.muted = false;
    this.sinkId = "";
    this.lookaheadSeconds = lookaheadSeconds;
    this.maxBufferSeconds = maxBufferSeconds;
    this.turnClearHoldMs = turnClearHoldMs;
    this.enableKeepAlive = Boolean(enableKeepAlive);

    // Background / lock-screen keepalive <audio> for iOS Safari & Android Chrome
    this._keepAliveAudio = null;
    if (this.enableKeepAlive && typeof document !== "undefined") {
      this._prepareKeepAliveElement();
    }

    // Stabilized audio playback timeline tracking for subtitle highlighting
    this.onActiveTurnChange = typeof onActiveTurnChange === "function" ? onActiveTurnChange : null;
    this.onAudioLevel = typeof onAudioLevel === "function" ? onAudioLevel : null;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.segments = []; // { turnId, startTime, endTime }
    this.currentSpeakingTurnId = null;
    this._lastActiveAudioMs = 0;
    this._rafId = null;
    this._holdTimer = null;
  }

  _prepareKeepAliveElement() {
    if (this._keepAliveAudio || typeof document === "undefined") return;
    const audio = document.createElement("audio");
    audio.src = createSilentWavDataUri();
    audio.loop = true;
    audio.playsInline = true;
    audio.setAttribute("playsinline", "");
    audio.setAttribute("webkit-playsinline", "");
    audio.setAttribute("x-webkit-airplay", "deny");
    audio.preload = "auto";
    audio.style.display = "none";
    if (document.body) {
      document.body.appendChild(audio);
    }
    this._keepAliveAudio = audio;
  }

  _activatePlaybackAudioSession() {
    // Official Safari 17+ Web AudioSession API: plays Web Audio even with iPhone silent switch ON
    if (typeof navigator !== "undefined" && navigator.audioSession) {
      try {
        navigator.audioSession.type = "playback";
      } catch {
        // Ignore on browsers where audioSession is read-only
      }
    }
  }

  _startKeepAlive() {
    if (!this.enableKeepAlive) return;
    this._activatePlaybackAudioSession();
    this._prepareKeepAliveElement();
    if (this._keepAliveAudio) {
      if (!this._keepAliveAudio.isConnected && document.body) {
        document.body.appendChild(this._keepAliveAudio);
      }
      this._keepAliveAudio.play().catch(() => {});
    }

    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: "Live Sermon Interpretation · 实时同声传译",
          artist: "Sermon Live Translator",
          album: "Church Broadcast",
        });
        navigator.mediaSession.playbackState = this.muted ? "paused" : "playing";
      } catch {
        // MediaSession optional
      }
    }
  }

  _stopKeepAlive() {
    if (this._keepAliveAudio) {
      try {
        this._keepAliveAudio.pause();
      } catch {
        // Ignore
      }
    }
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "paused";
      } catch {
        // Ignore
      }
    }
  }

  async ensureReady() {
    // CRITICAL FOR iOS / macOS SAFARI:
    // Perform AudioSession switch, AudioContext creation, silent buffer start, ctx.resume(),
    // and keepalive <audio>.play() ALL SYNCHRONOUSLY inside the user tap before ANY `await`!
    this._activatePlaybackAudioSession();

    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
      this.gainNode.connect(this.ctx.destination);

      this.ctx.onstatechange = () => {
        const st = this.ctx ? this.ctx.state : "closed";
        this.onStateChange?.(st);
      };
    }

    // 1. Synchronous silent Web Audio unlock (required by WebKit)
    try {
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate || 44100);
      const src = this.ctx.createBufferSource();
      src.buffer = silent;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch {
      // Ignore
    }

    // 2. Synchronous ctx.resume() (do NOT await yet!)
    let resumePromise = null;
    if (this.ctx.state !== "running") {
      resumePromise = this.ctx.resume().catch(() => {});
    }

    // 3. Synchronous <audio>.play() while still inside Safari's user-gesture call stack
    if (!this.muted) {
      this._startKeepAlive();
    }

    // 4. Now safe to await asynchronous state transitions
    if (resumePromise) {
      await resumePromise;
    }

    if (this.sinkId && typeof this.ctx.setSinkId === "function") {
      try {
        await this.ctx.setSinkId(this.sinkId);
      } catch (err) {
        console.warn("Failed to set initial audio output device:", err);
      }
    }

    this.onStateChange?.(this.ctx.state);
    return this.ctx.state === "running";
  }

  async resumeIfNeeded() {
    if (!this.ctx) return false;
    // Handle BOTH "suspended" AND iOS Safari's "interrupted" state after screen lock!
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // iOS may require a fresh user tap if hard-interrupted
      }
    }
    if (this.ctx.state === "running") {
      // Reset stale playout cursor so resumed packets play immediately with no frozen delay
      if (this.nextStartTime < this.ctx.currentTime || this.nextStartTime - this.ctx.currentTime > this.maxBufferSeconds) {
        this.nextStartTime = this.ctx.currentTime + this.lookaheadSeconds;
      }
      if (!this.muted) {
        this._startKeepAlive();
      }
    }
    this.onStateChange?.(this.ctx.state);
    return this.ctx.state === "running";
  }

  isRunning() {
    return Boolean(this.ctx && this.ctx.state === "running");
  }

  async setOutputDevice(deviceId) {
    this.sinkId = deviceId || "";
    if (this.ctx && typeof this.ctx.setSinkId === "function") {
      await this.ctx.setSinkId(this.sinkId);
      return true;
    }
    return false;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1.5, Number(value)));
    if (this.gainNode && !this.muted && this.ctx) {
      const now = this.ctx.currentTime;
      if (now > 0) {
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setTargetAtTime(this.volume, now, 0.015);
      } else {
        this.gainNode.gain.value = this.volume;
      }
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.gainNode && this.ctx) {
      const target = this.muted ? 0 : this.volume;
      const now = this.ctx.currentTime;
      if (now > 0) {
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setTargetAtTime(target, now, 0.015);
      } else {
        this.gainNode.gain.value = target;
      }
    }
    if (this.muted) {
      this._stopKeepAlive();
    } else if (this.ctx && this.ctx.state === "running") {
      this._startKeepAlive();
    }
  }

  _emitTurn(turnId) {
    if (this.currentSpeakingTurnId !== turnId) {
      this.currentSpeakingTurnId = turnId;
      this.onActiveTurnChange?.(turnId);
    }
  }

  _scheduleHoldClear() {
    if (this._holdTimer !== null || this.currentSpeakingTurnId === null) return;
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null;
      const elapsed = performance.now() - this._lastActiveAudioMs;
      if (elapsed >= this.turnClearHoldMs - 40 && this.segments.length === 0) {
        this._emitTurn(null);
      }
    }, this.turnClearHoldMs);
  }

  _cancelHoldClear() {
    if (this._holdTimer !== null) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
  }

  _startMonitor() {
    if (this._rafId !== null) return;
    const tick = () => {
      if (!this.ctx || this.segments.length === 0) {
        this._rafId = null;
        this._scheduleHoldClear();
        return;
      }

      const now = this.ctx.currentTime;
      // Drop finished segments
      while (this.segments.length > 0 && this.segments[0].endTime <= now - 0.02) {
        this.segments.shift();
      }

      let activeTurn = null;
      for (const seg of this.segments) {
        if (seg.startTime <= now + 0.06 && now < seg.endTime) {
          activeTurn = seg.turnId;
          break;
        }
      }

      if (activeTurn !== null) {
        this._lastActiveAudioMs = performance.now();
        this._cancelHoldClear();
        this._emitTurn(activeTurn);
      } else {
        // Keep current speaking turn steady across brief Wi-Fi jitter / breath pauses
        this._scheduleHoldClear();
      }

      if (this.segments.length > 0) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = null;
        this._scheduleHoldClear();
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopMonitor() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._cancelHoldClear();
    this.segments = [];
    this._emitTurn(null);
  }

  _scheduleFloat32(float32, turnId = null, sampleRate = null) {
    if (!this.ctx || !float32 || float32.length === 0) {
      return;
    }
    if (this.ctx.state !== "running") {
      // Attempt silent recovery if OS briefly suspended/interrupted the context
      this.ctx.resume().catch(() => {});
      return;
    }

    const rate =
      Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000
        ? sampleRate
        : this.sampleRate;

    if (this.onAudioLevel) {
      let sum = 0;
      const step = Math.max(1, Math.floor(float32.length / 96));
      let count = 0;
      for (let i = 0; i < float32.length; i += step) {
        sum += float32[i] * float32[i];
        count++;
      }
      this.onAudioLevel(count > 0 ? Math.sqrt(sum / count) : 0);
    }

    const now = this.ctx.currentTime;
    // Soft catch-up guard: if mobile backlog exceeds maxBufferSeconds, skip this packet cleanly
    // instead of stopping currently playing words mid-syllable!
    if (this.nextStartTime - now > this.maxBufferSeconds) {
      return;
    }

    let isReanchor = false;
    if (this.nextStartTime < now + 0.008) {
      this.nextStartTime = now + this.lookaheadSeconds;
      isReanchor = true;
    }

    // Apply tiny 3ms fade-in when re-anchoring after a pause/underrun to eliminate clicks
    const fadeSamples = Math.min(float32.length, Math.round(rate * 0.003));
    if (isReanchor && fadeSamples > 4) {
      for (let i = 0; i < fadeSamples; i++) {
        float32[i] *= i / fadeSamples;
      }
    }

    const audioBuffer = this.ctx.createBuffer(1, float32.length, rate);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const startTime = this.nextStartTime;
    const endTime = startTime + audioBuffer.duration;
    source.start(startTime);
    this.nextStartTime = endTime;

    if (turnId !== null && turnId !== undefined && turnId > 0) {
      this._lastActiveAudioMs = performance.now();
      this._cancelHoldClear();
      const last = this.segments[this.segments.length - 1];
      if (last && last.turnId === turnId && startTime <= last.endTime + 0.25) {
        last.endTime = Math.max(last.endTime, endTime);
      } else {
        this.segments.push({ turnId, startTime, endTime });
      }
      this._startMonitor();
    }

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  enqueuePcm16(arrayBuffer, turnId = null, sampleRate = null) {
    if (!this.ctx || !arrayBuffer || arrayBuffer.byteLength < 2) {
      return;
    }
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    this._scheduleFloat32(float32, turnId, sampleRate);
  }

  enqueueUlaw24k(uint8View, turnId = null, sampleRate = null) {
    if (!this.ctx || !uint8View || uint8View.byteLength < 1) {
      return;
    }
    const float32 = new Float32Array(uint8View.length);
    for (let i = 0; i < uint8View.length; i++) {
      float32[i] = ULAW_DECODE_LUT[uint8View[i]];
    }
    this._scheduleFloat32(float32, turnId, sampleRate);
  }

  clearQueue() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // Source already stopped
      }
    }
    this.activeSources.clear();
    this._stopMonitor();
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    }
  }

  async close() {
    this.clearQueue();
    this._stopKeepAlive();
    if (this._keepAliveAudio) {
      this._keepAliveAudio.remove();
      this._keepAliveAudio = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.gainNode = null;
      this.nextStartTime = 0;
    }
  }
}
