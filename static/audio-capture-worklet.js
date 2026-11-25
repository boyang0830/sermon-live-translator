/**
 * AudioWorkletProcessor for capturing mono microphone / mixer Line-Out audio,
 * resampling smoothly from native AudioContext sampleRate (44.1k/48k) to 16kHz
 * 16-bit signed little-endian PCM, and emitting 100ms chunks (1,600 samples).
 */
class Pcm16kCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSamples = 1600; // 100ms at 16kHz (official Gemini Live Translate spec)
    this.buffer = new Int16Array(this.chunkSamples);
    this.writeIndex = 0;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.lastSample = 0;
    this.sumSquares = 0;
    this.rmsCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) {
      return true;
    }

    // Downmix to mono if stereo Line-Out is connected
    const channelCount = input.length;
    const frameLength = input[0].length;
    if (frameLength === 0) {
      return true;
    }

    const mono =
      channelCount === 1
        ? input[0]
        : (() => {
            const mixed = new Float32Array(frameLength);
            for (let i = 0; i < frameLength; i++) {
              let sum = 0;
              for (let ch = 0; ch < channelCount; ch++) {
                sum += input[ch][i];
              }
              mixed[i] = sum / channelCount;
            }
            return mixed;
          })();

    for (let i = 0; i < frameLength; i++) {
      const s = mono[i];
      this.sumSquares += s * s;
      this.rmsCount++;
    }

    // Linear interpolation resampling to 16kHz
    let pos = this.phase;
    while (pos < frameLength) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = idx === 0 && pos < 0 ? this.lastSample : mono[idx];
      const s1 = idx + 1 < frameLength ? mono[idx + 1] : mono[frameLength - 1];
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.writeIndex++] =
        clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      if (this.writeIndex >= this.chunkSamples) {
        const rms =
          this.rmsCount > 0 ? Math.sqrt(this.sumSquares / this.rmsCount) : 0;
        const out = this.buffer;
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this.buffer = new Int16Array(this.chunkSamples);
        this.writeIndex = 0;
        this.sumSquares = 0;
        this.rmsCount = 0;
      }

      pos += this.ratio;
    }

    this.phase = pos - frameLength;
    this.lastSample = mono[frameLength - 1];
    return true;
  }
}

registerProcessor("pcm-16k-capture", Pcm16kCaptureProcessor);
