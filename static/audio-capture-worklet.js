/**
 * AudioWorkletProcessor for capturing mono microphone / mixer Line-Out audio,
 * resampling smoothly from native AudioContext sampleRate (44.1k/48k) to 16kHz
 * 16-bit signed little-endian PCM, and emitting 100ms chunks (1,600 samples).
 */
class Pcm16kCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedRate = Number(options?.processorOptions?.targetRate);
    const requestedChunkMs = Number(options?.processorOptions?.chunkMs);
    this.targetRate = Number.isFinite(requestedRate) && requestedRate >= 8000 ? requestedRate : 16000;
    const chunkMs =
      Number.isFinite(requestedChunkMs) && requestedChunkMs >= 20 && requestedChunkMs <= 200
        ? requestedChunkMs
        : 100;
    this.chunkSamples = Math.round((this.targetRate * chunkMs) / 1000);
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

    // Anti-aliased resampling to targetRate (box-average window when downsampling prevents
    // high-frequency aliasing & metallic timbre distortion when converting 48kHz -> 24kHz/16kHz)
    let pos = this.phase;
    const isDownsampling = this.ratio > 1.05;
    while (pos < frameLength) {
      let sample;
      if (isDownsampling) {
        const start = Math.floor(pos);
        const end = Math.min(frameLength, Math.ceil(pos + this.ratio));
        let acc = 0;
        let cnt = 0;
        for (let k = Math.max(0, start); k < end; k++) {
          acc += mono[k];
          cnt++;
        }
        sample = cnt > 0 ? acc / cnt : mono[Math.min(frameLength - 1, Math.max(0, start))];
      } else {
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const s0 = idx === 0 && pos < 0 ? this.lastSample : mono[idx];
        const s1 = idx + 1 < frameLength ? mono[idx + 1] : mono[frameLength - 1];
        sample = s0 + (s1 - s0) * frac;
      }
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
