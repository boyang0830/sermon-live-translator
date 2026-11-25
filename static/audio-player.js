/**
 * Low-latency 24kHz mono streaming player for Gemini Live API & Mode 2 congregation broadcast.
 * Supports:
 *   - Raw 24kHz 16-bit signed LE PCM (`enqueuePcm16`)
 *   - Compressed 24kHz 8-bit G.711 μ-law (`enqueueUlaw24k`, 2x smaller for church Wi-Fi fan-out)
 *   - Smooth jitter buffering + drift catch-up guard (`maxBufferSeconds`) so mobile phones never lag behind
 *   - Output device routing (`AudioContext.setSinkId`) and real-time playback tracking by turnId
 */

// Precomputed ITU-T G.711 μ-law -> Float32 [-1, 1] lookup table (zero GC overhead)
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

export class Pcm24kPlayer {
  constructor({ onActiveTurnChange, onAudioLevel, lookaheadSeconds = 0.06, maxBufferSeconds = 1.4 } = {}) {
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

    // Exact audio playback timeline tracking for subtitle highlighting
    this.onActiveTurnChange = typeof onActiveTurnChange === "function" ? onActiveTurnChange : null;
    this.onAudioLevel = typeof onAudioLevel === "function" ? onAudioLevel : null;
    this.segments = []; // { turnId, startTime, endTime }
    this.currentSpeakingTurnId = null;
    this.lastReportedProgress = -1;
    this._rafId = null;
  }

  async ensureReady() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ sampleRate: this.sampleRate });
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
      this.gainNode.connect(this.ctx.destination);
      if (this.sinkId && typeof this.ctx.setSinkId === "function") {
        try {
          await this.ctx.setSinkId(this.sinkId);
        } catch (err) {
          console.warn("Failed to set initial audio output device:", err);
        }
      }
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
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
    if (this.gainNode && !this.muted) {
      this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime,
        0.015
      );
    }
  }

  _notifyTurn(turnId, elapsedSec = 0, durationSec = 0) {
    const quantized = Math.round(elapsedSec * 20); // ~50ms granularity
    if (this.currentSpeakingTurnId !== turnId || this.lastReportedProgress !== quantized) {
      this.currentSpeakingTurnId = turnId;
      this.lastReportedProgress = turnId === null ? -1 : quantized;
      if (this.onActiveTurnChange) {
        this.onActiveTurnChange(turnId, elapsedSec, durationSec);
      }
    }
  }

  _startMonitor() {
    if (this._rafId !== null) return;
    const tick = () => {
      if (!this.ctx || this.segments.length === 0) {
        this._rafId = null;
        this._notifyTurn(null, 0, 0);
        return;
      }

      const now = this.ctx.currentTime;
      // Drop finished segments
      while (this.segments.length > 0 && this.segments[0].endTime <= now - 0.02) {
        this.segments.shift();
      }

      let activeTurn = null;
      let elapsedSec = 0;
      let durationSec = 0;
      for (const seg of this.segments) {
        if (seg.startTime <= now + 0.03 && now < seg.endTime) {
          activeTurn = seg.turnId;
          elapsedSec = Math.max(0, now - seg.startTime);
          durationSec = Math.max(0.15, seg.endTime - seg.startTime);
          break;
        }
      }
      this._notifyTurn(activeTurn, elapsedSec, durationSec);

      if (this.segments.length > 0) {
        this._rafId = requestAnimationFrame(tick);
      } else {
        this._rafId = null;
        this._notifyTurn(null, 0, 0);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopMonitor() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.segments = [];
    this._notifyTurn(null);
  }

  _scheduleFloat32(float32, turnId = null) {
    if (!this.ctx || !float32 || float32.length === 0) {
      return;
    }

    if (this.onAudioLevel) {
      let sum = 0;
      const step = Math.max(1, Math.floor(float32.length / 128));
      let count = 0;
      for (let i = 0; i < float32.length; i += step) {
        sum += float32[i] * float32[i];
        count++;
      }
      this.onAudioLevel(count > 0 ? Math.sqrt(sum / count) : 0);
    }

    const audioBuffer = this.ctx.createBuffer(1, float32.length, this.sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const now = this.ctx.currentTime;
    // Catch-up guard: if mobile network jitter caused > maxBufferSeconds backlog, snap back to live
    if (this.nextStartTime - now > this.maxBufferSeconds) {
      this.clearQueue();
    }
    if (this.nextStartTime < now + 0.01) {
      this.nextStartTime = now + this.lookaheadSeconds;
    }

    const startTime = this.nextStartTime;
    const endTime = startTime + audioBuffer.duration;
    source.start(startTime);
    this.nextStartTime = endTime;

    if (turnId !== null && turnId !== undefined && turnId > 0) {
      const last = this.segments[this.segments.length - 1];
      if (last && last.turnId === turnId && startTime <= last.endTime + 0.12) {
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

  enqueuePcm16(arrayBuffer, turnId = null) {
    if (!this.ctx || !arrayBuffer || arrayBuffer.byteLength < 2) {
      return;
    }
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    this._scheduleFloat32(float32, turnId);
  }

  enqueueUlaw24k(uint8View, turnId = null) {
    if (!this.ctx || !uint8View || uint8View.byteLength < 1) {
      return;
    }
    const float32 = new Float32Array(uint8View.length);
    for (let i = 0; i < uint8View.length; i++) {
      float32[i] = ULAW_DECODE_LUT[uint8View[i]];
    }
    this._scheduleFloat32(float32, turnId);
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
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.gainNode = null;
      this.nextStartTime = 0;
    }
  }
}
