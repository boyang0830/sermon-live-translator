/**
 * Browser-native WebRTC (UDP / Opus + DataChannel "oai-events") client for
 * Alibaba Cloud Model Studio qwen3.8-livetranslate-flash-realtime.
 *
 * Mirrors the omni.qwen.ai/live-translate/ transport architecture:
 *   1. Exchanges Offer/Answer SDP through our local backend proxy (/api/qwen/webrtc-sdp)
 *      so DASHSCOPE_API_KEY never touches the browser.
 *   2. Sends session.update over DataChannel "oai-events" and waits for session.updated
 *      before attaching the live mic track via RTCRtpSender.replaceTrack (zero renegotiation).
 *   3. Streams live confirmed + tentative ("stash") subtitles and tracks real-time
 *      remote audio playback for synchronized subtitle highlighting.
 */
export class QwenWebRtcClient {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.pc = null;
    this.dataChannel = null;
    this.audioTransceiver = null;
    this.localStream = null;
    this.micTrack = null;

    this.remoteAudio = null;
    this.localAnalyserCtx = null;
    this.localAnalyser = null;
    this.remoteAnalyserCtx = null;
    this.remoteAnalyser = null;
    this.remoteBroadcastNode = null;
    this._meterRaf = null;

    this.running = false;
    this.paused = false;
    this.sessionUpdateSent = false;
    this.sessionReady = false;
    this.pendingSessionUpdate = null;

    this.turnId = 1;
    this.speakingTurnId = null;
    this.maxSpokenTurnId = 0;
    this.turnSpokenMs = new Map(); // monotonic cumulative spoken ms per turn
    this.lastMeterFrameMs = 0;
    this.remoteAudioActive = false;
    this.lastRemoteVoiceMs = 0;
    this.turnSawAudioTranscript = false;
    this.turnHasOutput = false;

    this.volume = 1.0;
    this.muted = false;
    this.sinkId = "";

    // Stats tracking
    this.regionSpec = null;
    this.inputActiveSeconds = 0;
    this.outputActiveSeconds = 0;
    this.reportedInputTokens = 0;
    this.reportedInputAudioTokens = 0;
    this.reportedInputTextTokens = 0;
    this.reportedCachedTokens = 0;
    this.reportedOutputTokens = 0;
    this.reportedTextOutTokens = 0;
    this.reportedAudioOutTokens = 0;
    this.turnCount = 0;
    this._statsTimer = null;
    this._lastTickMs = 0;
  }

  async start(options) {
    this.running = true;
    this.paused = false;
    this.sessionUpdateSent = false;
    this.sessionReady = false;
    this.turnId = 1;
    this.speakingTurnId = null;
    this.maxSpokenTurnId = 0;
    this.turnSpokenMs.clear();
    this.lastMeterFrameMs = performance.now();
    this.remoteAudioActive = false;
    this.turnSawAudioTranscript = false;
    this.turnHasOutput = false;
    this.inputActiveSeconds = 0;
    this.outputActiveSeconds = 0;
    this.reportedInputTokens = 0;
    this.reportedInputAudioTokens = 0;
    this.reportedInputTextTokens = 0;
    this.reportedCachedTokens = 0;
    this.reportedOutputTokens = 0;
    this.reportedTextOutTokens = 0;
    this.reportedAudioOutTokens = 0;
    this.turnCount = 0;
    this.regionSpec = options.regionSpec || null;

    this.cb.onStatus?.("connecting", "正在准备麦克风并建立 Qwen3.8 WebRTC 直连...");

    // 1. Capture microphone / mixer Line-Out stream
    const cleanMixer = Boolean(options.mixerCleanMode);
    const audioConstraints = {
      channelCount: 1,
      echoCancellation: !cleanMixer,
      noiseSuppression: !cleanMixer,
      autoGainControl: !cleanMixer,
    };
    if (options.inputDeviceId) {
      audioConstraints.deviceId = { exact: options.inputDeviceId };
    }
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    this.micTrack = this.localStream.getAudioTracks()[0];
    this._startLocalVuMeter(this.localStream);

    // 2. Initialize RTCPeerConnection
    this.pc = new RTCPeerConnection({ iceServers: [] });

    this.remoteAudio = document.createElement("audio");
    this.remoteAudio.autoplay = true;
    this.remoteAudio.playsInline = true;
    this.remoteAudio.volume = Math.min(1, Math.max(0, this.volume));
    this.remoteAudio.muted = this.muted;
    if (this.sinkId && typeof this.remoteAudio.setSinkId === "function") {
      try {
        await this.remoteAudio.setSinkId(this.sinkId);
      } catch (err) {
        console.warn("WebRTC remoteAudio setSinkId fallback:", err);
      }
    }

    this.pc.ontrack = (event) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      this.remoteAudio.srcObject = stream;
      this.remoteAudio.play().catch(() => {});
      this._attachRemoteAudioMonitor(stream);
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const st = this.pc.connectionState;
      if (st === "failed" || st === "disconnected") {
        this.cb.onError?.(
          `Qwen3.8 WebRTC 连接中断 (${st})。请检查网络或百炼 Workspace ID 配置。`,
          st === "failed"
        );
      }
    };

    // 3. Create control/subtitle DataChannel
    this.dataChannel = this.pc.createDataChannel("oai-events");
    this._bindDataChannel(this.dataChannel);
    this.pc.ondatachannel = (event) => {
      if (event.channel && event.channel !== this.dataChannel) {
        this._bindDataChannel(event.channel);
      }
    };

    // 4. Add sendrecv audio transceiver WITHOUT attaching live mic track yet
    // (Alibaba Cloud requires session.updated before upstream audio starts)
    this.audioTransceiver = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });

    // 5. Create local Offer SDP and wait briefly for ICE gathering
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitForIceGathering(this.pc, 2500);

    // 6. Exchange SDP through our local backend proxy (keeps API key secret)
    this.cb.onStatus?.("connecting", "正在与阿里云百炼交换 WebRTC SDP...");
    const res = await fetch("/api/qwen/webrtc-sdp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: this.pc.localDescription.sdp,
        model: options.model,
        direction: options.direction,
        dashscope_api_key: options.dashscopeApiKey,
        dashscope_region: options.dashscopeRegion,
        dashscope_workspace_id: options.dashscopeWorkspaceId,
        qwen_voice_mode: options.qwenVoiceMode,
        qwen_custom_voice_id: options.qwenCustomVoiceId,
        qwen_vad_mode: options.qwenVadMode,
        glossary: options.glossary,
        sermon_context: options.sermonContext,
        save_transcript: options.saveTranscript,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `SDP 交换失败 (HTTP ${res.status})`);
    }

    this.pendingSessionUpdate = data.session_update;
    this._logFileName = data.log_file || null;
    this._phraseCount = data.phrase_count || 0;
    this._directionLabel = data.direction_label || options.direction;

    await this.pc.setRemoteDescription({
      type: "answer",
      sdp: data.answer_sdp,
    });

    this._lastTickMs = performance.now();
    this._statsTimer = setInterval(() => this._tickStats(), 1500);
  }

  _waitForIceGathering(pc, timeoutMs = 2500) {
    if (pc.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }, timeoutMs);

      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  _bindDataChannel(channel) {
    channel.onopen = () => {
      this._sendSessionUpdateIfNeeded(channel);
    };
    channel.onmessage = (event) => {
      this._handleServerMessage(event.data, channel);
    };
    channel.onerror = (err) => {
      console.warn("Qwen WebRTC DataChannel error:", err);
    };
  }

  _sendSessionUpdateIfNeeded(channel) {
    if (this.sessionUpdateSent || !this.pendingSessionUpdate) return;
    if (channel.readyState !== "open") return;
    this.sessionUpdateSent = true;
    channel.send(JSON.stringify(this.pendingSessionUpdate));
  }

  async _attachMicrophoneTrack() {
    if (!this.audioTransceiver || !this.micTrack) return;
    this.micTrack.enabled = !this.paused;
    await this.audioTransceiver.sender.replaceTrack(this.micTrack);
  }

  _setSpeakingTurn(turnId, dtMs = 0) {
    if (turnId === null) {
      if (this.speakingTurnId !== null) {
        this.speakingTurnId = null;
        this.cb.onActiveTurnChange?.(null, 0);
      }
      return;
    }

    // Never jump backwards to an older turn once a newer turn has started speaking
    const monotonicTurn = Math.max(turnId, this.maxSpokenTurnId || turnId);
    this.maxSpokenTurnId = monotonicTurn;

    const prevMs = this.turnSpokenMs.get(monotonicTurn) || 0;
    const nextMs = prevMs + Math.max(0, dtMs);
    this.turnSpokenMs.set(monotonicTurn, nextMs);
    const elapsedSec = nextMs / 1000;

    if (this.speakingTurnId !== monotonicTurn) {
      this.speakingTurnId = monotonicTurn;
      this.cb.onActiveTurnChange?.(monotonicTurn, elapsedSec);
    } else if (dtMs > 0) {
      this.cb.onActiveTurnProgress?.(monotonicTurn, elapsedSec);
    }
  }

  _handleServerMessage(raw, channel) {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }

    const type = ev.type || "";

    if (type === "session.created") {
      this._sendSessionUpdateIfNeeded(channel);
      return;
    }

    if (type === "session.updated") {
      if (!this.sessionReady) {
        this.sessionReady = true;
        this._attachMicrophoneTrack()
          .then(() => {
            this.cb.onStatus?.(
              "live",
              `Qwen3.8 WebRTC 直连已就绪（${this._directionLabel} · 已加载 ${this._phraseCount} 条术语）`,
              this._logFileName
            );
          })
          .catch((err) => {
            this.cb.onError?.(`挂载麦克风音轨失败：${err.message}`, true);
          });
      }
      return;
    }

    if (type === "error") {
      const msg = ev.error?.message || JSON.stringify(ev);
      this.cb.onError?.(`Qwen3.8 WebRTC 服务端错误：${msg}`, false);
      return;
    }

    // Audio playback lifecycle events for instant subtitle highlight
    if (type === "output_audio_buffer.started") {
      this.remoteAudioActive = true;
      this._setSpeakingTurn(this.turnId);
      return;
    }
    if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
      this.remoteAudioActive = false;
      this._setSpeakingTurn(null);
      return;
    }

    // Live translated subtitle with confirmed text + tentative stash (low-latency preview!)
    if (type === "response.audio_transcript.text" || type === "response.text.text") {
      const confirmed = ev.text || "";
      const stash = ev.stash || "";
      if (confirmed || stash) {
        this.turnSawAudioTranscript = true;
        this.turnHasOutput = true;
        this.cb.onTargetReplace?.(this.turnId, confirmed, stash);
        if (this.remoteAudioActive) {
          this._setSpeakingTurn(this.turnId);
        }
      }
      return;
    }

    if (type === "response.audio_transcript.delta") {
      const delta = ev.delta || "";
      if (delta) {
        this.turnSawAudioTranscript = true;
        this.turnHasOutput = true;
        this.cb.onTargetDelta?.(this.turnId, delta);
        if (this.remoteAudioActive) {
          this._setSpeakingTurn(this.turnId);
        }
      }
      return;
    }

    if (type === "response.text.delta" && !this.turnSawAudioTranscript) {
      const delta = ev.delta || "";
      if (delta) {
        this.turnHasOutput = true;
        this.cb.onTargetDelta?.(this.turnId, delta);
      }
      return;
    }

    if (type === "response.audio_transcript.done") {
      const finalText = ev.transcript || ev.text || "";
      if (finalText) {
        this.turnHasOutput = true;
        this.cb.onTargetReplace?.(this.turnId, finalText, "");
      }
      return;
    }

    // Source ASR transcription (confirmed + stash or delta/completed)
    if (type === "conversation.item.input_audio_transcription.text") {
      const confirmed = ev.text || "";
      const stash = ev.stash || "";
      if (confirmed || stash) {
        this.cb.onSourceReplace?.(this.turnId, confirmed, stash);
      }
      return;
    }

    if (
      type === "conversation.item.input_audio_transcription.delta" ||
      type === "input_audio_transcription.delta"
    ) {
      const delta = ev.delta || ev.text || "";
      if (delta) {
        this.cb.onSourceDelta?.(this.turnId, delta);
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = ev.transcript || ev.text || "";
      if (transcript) {
        this.cb.onSourceReplace?.(this.turnId, transcript, "");
      }
      return;
    }

    if (type === "response.done") {
      this.turnCount += 1;
      const usage = ev.response?.usage || ev.usage;
      if (usage) {
        console.info(`[Qwen3.8 usage turn #${this.turnCount}]`, usage);
        const inTotal = Number(usage.input_tokens || 0);
        const outTotal = Number(usage.output_tokens || 0);
        // Official Alibaba Cloud keys are plural: input_tokens_details / output_tokens_details
        const inDetails = usage.input_tokens_details || usage.input_token_details || {};
        const outDetails = usage.output_tokens_details || usage.output_token_details || {};

        const inAudio = Number(inDetails.audio_tokens || 0);
        const inText = Number(inDetails.text_tokens || 0);
        const cached = Number(inDetails.cached_tokens || 0);
        const outText = Number(outDetails.text_tokens || 0);
        const outAudio = Number(outDetails.audio_tokens || 0);

        // IMPORTANT: Qwen3.8-LiveTranslate reports SESSION-CUMULATIVE usage in every response.done!
        // Assign the monotonic high-water value instead of summing with += (which overcounted by N/2x).
        this.reportedInputTokens = Math.max(this.reportedInputTokens, inTotal);
        this.reportedInputAudioTokens = Math.max(this.reportedInputAudioTokens, inAudio);
        this.reportedInputTextTokens = Math.max(this.reportedInputTextTokens, inText);
        this.reportedCachedTokens = Math.max(this.reportedCachedTokens, cached);
        this.reportedOutputTokens = Math.max(this.reportedOutputTokens, outTotal);
        this.reportedTextOutTokens = Math.max(this.reportedTextOutTokens, outText);
        this.reportedAudioOutTokens = Math.max(this.reportedAudioOutTokens, outAudio);
      }

      const completedTurnId = this.turnId;
      this.cb.onTurnComplete?.(completedTurnId, this._logFileName);
      if (this.turnHasOutput) {
        this.turnId += 1;
        this.turnHasOutput = false;
        this.turnSawAudioTranscript = false;
      }
      this._emitStats();
    }
  }

  _startLocalVuMeter(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.localAnalyserCtx = new AudioCtx();
    const src = this.localAnalyserCtx.createMediaStreamSource(stream);
    this.localAnalyser = this.localAnalyserCtx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    src.connect(this.localAnalyser);

    const localBuf = new Float32Array(this.localAnalyser.fftSize);
    const tick = () => {
      if (!this.running) return;
      if (this.localAnalyser) {
        this.localAnalyser.getFloatTimeDomainData(localBuf);
        let sum = 0;
        for (let i = 0; i < localBuf.length; i++) {
          sum += localBuf[i] * localBuf[i];
        }
        const rms = Math.sqrt(sum / localBuf.length);
        this.cb.onInputLevel?.(rms);
      }

      const now = performance.now();
      const dtMs = this.lastMeterFrameMs ? Math.min(100, Math.max(0, now - this.lastMeterFrameMs)) : 0;
      this.lastMeterFrameMs = now;

      if (this.remoteAnalyser) {
        const remoteBuf = new Float32Array(this.remoteAnalyser.fftSize);
        this.remoteAnalyser.getFloatTimeDomainData(remoteBuf);
        let sum = 0;
        for (let i = 0; i < remoteBuf.length; i++) {
          sum += remoteBuf[i] * remoteBuf[i];
        }
        const rms = Math.sqrt(sum / remoteBuf.length);
        if (rms > 0.012) {
          this.lastRemoteVoiceMs = now;
          this.remoteAudioActive = true;
          const targetTurn = this.turnHasOutput ? this.turnId : Math.max(1, this.turnId - 1);
          this._setSpeakingTurn(targetTurn, dtMs);
        } else if (this.remoteAudioActive) {
          if (now - this.lastRemoteVoiceMs > 850) {
            this.remoteAudioActive = false;
            this._setSpeakingTurn(null, 0);
          }
          // During brief comma/breath pauses (<850ms), freeze current word without resetting!
        }
      }

      this._meterRaf = requestAnimationFrame(tick);
    };
    this._meterRaf = requestAnimationFrame(tick);
  }

  async _attachRemoteAudioMonitor(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.remoteAnalyserCtx = new AudioCtx();
      if (this.remoteAnalyserCtx.state === "suspended") {
        await this.remoteAnalyserCtx.resume().catch(() => {});
      }
      const src = this.remoteAnalyserCtx.createMediaStreamSource(stream);
      this.remoteAnalyser = this.remoteAnalyserCtx.createAnalyser();
      this.remoteAnalyser.fftSize = 512;
      src.connect(this.remoteAnalyser);

      // Mode 2 broadcast tap: capture clean 24kHz Int16 PCM from WebRTC remote audio
      // so the single Qwen WebRTC stream can be fanned out to N congregation phones.
      if (typeof this.cb.onRemotePcm === "function" && this.remoteAnalyserCtx.audioWorklet) {
        try {
          await this.remoteAnalyserCtx.audioWorklet.addModule("/static/audio-capture-worklet.js");
          if (!this.running || !this.remoteAnalyserCtx) return;
          const worklet = new AudioWorkletNode(this.remoteAnalyserCtx, "pcm-16k-capture", {
            processorOptions: { targetRate: 24000 },
          });
          let silentChunks = 0;
          worklet.port.onmessage = (event) => {
            if (!this.running) return;
            const { pcm, rms } = event.data || {};
            if (!pcm) return;
            // Gate pure dead-silence after 600ms tail to save church Wi-Fi bandwidth
            if (rms > 0.002) {
              silentChunks = 0;
            } else {
              silentChunks++;
              if (silentChunks > 6) return;
            }
            const activeTurn =
              this.speakingTurnId ||
              (this.turnHasOutput ? this.turnId : Math.max(1, this.turnId - 1));
            this.cb.onRemotePcm?.(pcm, activeTurn);
          };
          src.connect(worklet);
          this.remoteBroadcastNode = worklet;
        } catch (err) {
          console.warn("Unable to attach Mode 2 WebRTC broadcast audio tap:", err);
        }
      }
    } catch (err) {
      console.warn("Unable to attach remote audio analyser:", err);
    }
  }

  _tickStats() {
    if (!this.running) return;
    const now = performance.now();
    const dtSec = Math.max(0, (now - this._lastTickMs) / 1000);
    this._lastTickMs = now;
    if (this.sessionReady && !this.paused) {
      this.inputActiveSeconds += dtSec;
    }
    if (this.remoteAudioActive) {
      this.outputActiveSeconds += dtSec;
    }
    this._emitStats();
  }

  _emitStats() {
    const reg = this.regionSpec || {
      currency: "CNY",
      currency_symbol: "¥",
      input_per_1m_tokens: 40.0,
      output_text_per_1m_tokens: 100.0,
      output_audio_per_1m_tokens: 160.0,
    };

    let cost = 0;
    let basis = "audio_duration_estimate";
    if (this.reportedInputTokens > 0 || this.reportedOutputTokens > 0) {
      basis = "actual_tokens";
      // Bill only audio_tokens at audio input rate when modality breakdown is present
      const billableAudioIn =
        this.reportedInputAudioTokens > 0
          ? this.reportedInputAudioTokens
          : Math.max(0, this.reportedInputTokens - this.reportedInputTextTokens);
      const inCost = (billableAudioIn / 1_000_000) * reg.input_per_1m_tokens;
      const outCost =
        this.reportedAudioOutTokens > 0 || this.reportedTextOutTokens > 0
          ? (this.reportedAudioOutTokens / 1_000_000) * reg.output_audio_per_1m_tokens +
            (this.reportedTextOutTokens / 1_000_000) * reg.output_text_per_1m_tokens
          : (this.reportedOutputTokens / 1_000_000) * reg.output_audio_per_1m_tokens;
      cost = inCost + outCost;
    } else {
      const inTok = this.inputActiveSeconds * 12.5;
      const outAudioTok = this.outputActiveSeconds * 12.5;
      const outTextTok = (this.outputActiveSeconds / 60) * 150;
      cost =
        (inTok / 1_000_000) * reg.input_per_1m_tokens +
        (outAudioTok / 1_000_000) * reg.output_audio_per_1m_tokens +
        (outTextTok / 1_000_000) * reg.output_text_per_1m_tokens;
    }

    this.cb.onStats?.({
      basis,
      currency: reg.currency,
      currency_symbol: reg.currency_symbol,
      estimated_cost: Number(cost.toFixed(5)),
      input_audio_seconds: Number(this.inputActiveSeconds.toFixed(1)),
      output_audio_seconds: Number(this.outputActiveSeconds.toFixed(1)),
      reported_prompt_tokens: this.reportedInputTokens,
      reported_input_audio_tokens: this.reportedInputAudioTokens,
      reported_input_text_tokens: this.reportedInputTextTokens,
      reported_cached_tokens: this.reportedCachedTokens,
      reported_response_tokens: this.reportedOutputTokens,
      reported_audio_output_tokens: this.reportedAudioOutTokens,
      reported_text_output_tokens: this.reportedTextOutTokens,
      turn_count: this.turnCount,
      reconnect_count: 0,
    });
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.micTrack) {
      this.micTrack.enabled = !this.paused;
    }
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1.5, Number(value)));
    if (this.remoteAudio) {
      this.remoteAudio.volume = Math.min(1, this.volume);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.remoteAudio) {
      this.remoteAudio.muted = this.muted;
    }
  }

  async setOutputDevice(deviceId) {
    this.sinkId = deviceId || "";
    if (this.remoteAudio && typeof this.remoteAudio.setSinkId === "function") {
      await this.remoteAudio.setSinkId(this.sinkId);
      return true;
    }
    return false;
  }

  async stop() {
    this.running = false;
    this.paused = false;
    this.remoteAudioActive = false;
    this._setSpeakingTurn(null);

    if (this._meterRaf !== null) {
      cancelAnimationFrame(this._meterRaf);
      this._meterRaf = null;
    }
    if (this._statsTimer !== null) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        // Ignore
      }
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // Ignore
      }
      this.pc = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
      this.micTrack = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio = null;
    }
    if (this.localAnalyserCtx) {
      await this.localAnalyserCtx.close().catch(() => {});
      this.localAnalyserCtx = null;
      this.localAnalyser = null;
    }
    if (this.remoteBroadcastNode) {
      try {
        this.remoteBroadcastNode.port.onmessage = null;
        this.remoteBroadcastNode.disconnect();
      } catch {
        // Ignore
      }
      this.remoteBroadcastNode = null;
    }
    if (this.remoteAnalyserCtx) {
      await this.remoteAnalyserCtx.close().catch(() => {});
      this.remoteAnalyserCtx = null;
      this.remoteAnalyser = null;
    }
  }
}
