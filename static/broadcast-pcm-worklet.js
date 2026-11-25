/**
 * Dedicated Mode 2 Broadcast AudioWorkletProcessor ("broadcast-pcm-capture").
 * Captures pure, untouched native AudioContext samples as 16-bit signed LE mono PCM
 * with ZERO custom resampling, and reports the exact `sampleRate` alongside every 40ms chunk
 * so congregation phones play back at the exact original pitch and studio timbre.
 */
class BroadcastPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedChunkMs = Number(options?.processorOptions?.chunkMs);
    const chunkMs =
      Number.isFinite(requestedChunkMs) && requestedChunkMs >= 20 && requestedChunkMs <= 120
        ? requestedChunkMs
        : 40;
    this.chunkSamples = Math.max(256, Math.round((sampleRate * chunkMs) / 1000));
    this.buffer = new Int16Array(this.chunkSamples);
    this.writeIndex = 0;
    this.sumSquares = 0;
    this.rmsCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) {
      return true;
    }

    const channelCount = input.length;
    const frameLength = input[0].length;
    if (frameLength === 0) {
      return true;
    }

    for (let i = 0; i < frameLength; i++) {
      let s = 0;
      if (channelCount === 1) {
        s = input[0][i];
      } else {
        for (let ch = 0; ch < channelCount; ch++) {
          s += input[ch][i];
        }
        s /= channelCount;
      }

      this.sumSquares += s * s;
      this.rmsCount++;

      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this.buffer[this.writeIndex++] =
        clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      if (this.writeIndex >= this.chunkSamples) {
        const rms = this.rmsCount > 0 ? Math.sqrt(this.sumSquares / this.rmsCount) : 0;
        const out = this.buffer;
        this.port.postMessage(
          { pcm: out.buffer, rms, sampleRate },
          [out.buffer]
        );
        this.buffer = new Int16Array(this.chunkSamples);
        this.writeIndex = 0;
        this.sumSquares = 0;
        this.rmsCount = 0;
      }
    }

    return true;
  }
}

registerProcessor("broadcast-pcm-capture", BroadcastPcmCaptureProcessor);
