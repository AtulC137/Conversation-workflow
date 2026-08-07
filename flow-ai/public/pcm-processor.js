/**
 * pcm-processor.js
 * AudioWorklet processor: accumulates float32 samples,
 * converts to Int16 PCM (pcm_s16le), emits fixed-size chunks.
 *
 * SAMPLE-RATE GUARD:
 * Some browsers ignore the requested AudioContext sampleRate (16k) and run the
 * graph at their hardware rate (commonly 48k). The worklet global `sampleRate`
 * is the real rate, so we linearly downsample every quantum to `targetSampleRate`
 * (16k) before buffering. This guarantees the bytes we ship always match the 16k
 * declared to Sarvam — otherwise STT hears 3x-fast garbage and returns nothing.
 *
 * INTERRUPT ADDITION:
 * Detects speech energy locally and posts { type: 'speech_energy_detected' }
 * to the main thread BEFORE Sarvam VAD fires — saves 200-400ms interrupt latency.
 * Energy threshold tunable via processorOptions.energyThreshold (default 0.002).
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};

    // PCM chunk config — chunkSize is in samples of the OUTPUT (target) stream
    this._chunkSize  = opts.chunkSize  || 4096;
    this._buffer     = new Float32Array(this._chunkSize);
    this._bufferFill = 0;

    // Sample-rate conversion: input (hardware) → target (16k for Sarvam)
    this._targetSampleRate = opts.targetSampleRate || 16000;
    this._inputSampleRate  = sampleRate; // worklet global = real context rate
    this._resampleRatio    = this._inputSampleRate / this._targetSampleRate;
    this._resamplePos      = 0; // fractional read position carried across quanta
    this._needsResample    = Math.abs(this._inputSampleRate - this._targetSampleRate) > 1;

    // Tell the main thread what actually happened (for diagnostics)
    this.port.postMessage({
      type: 'processor_ready',
      inputSampleRate:  this._inputSampleRate,
      targetSampleRate: this._targetSampleRate,
      resampling:       this._needsResample,
    });

    // Energy-based speech detection
    // Tune energyThreshold between 0.001 (sensitive) and 0.005 (less sensitive)
    this._energyThreshold      = opts.energyThreshold      || 0.002;
    this._silenceThreshold     = opts.silenceThreshold      || 0.0005;
    this._speaking             = false;

    // Consecutive-frame gating: avoids single-frame noise spikes
    // speech fires after N consecutive loud frames; silence after M quiet frames
    this._speechFrameGate      = opts.speechFrameGate      || 3;   // ~6ms at 16kHz
    this._silenceFrameGate     = opts.silenceFrameGate     || 20;  // ~40ms
    this._loudFrameCount       = 0;
    this._quietFrameCount      = 0;
  }

  // Linear-interpolation downsample of a single quantum to the target rate.
  // Keeps a fractional read position so output stays continuous across quanta.
  _resample(input) {
    if (!this._needsResample) return input;
    const ratio = this._resampleRatio;
    const outLen = Math.max(0, Math.ceil((input.length - this._resamplePos) / ratio));
    const out = new Float32Array(outLen);
    let pos = this._resamplePos;
    let o = 0;
    while (pos < input.length && o < outLen) {
      const i0   = Math.floor(pos);
      const frac = pos - i0;
      const s0   = input[i0];
      const s1   = i0 + 1 < input.length ? input[i0 + 1] : input[input.length - 1];
      out[o++]   = s0 + (s1 - s0) * frac;
      pos += ratio;
    }
    // Carry the leftover fractional offset into the next quantum
    this._resamplePos = pos - input.length;
    return o === outLen ? out : out.subarray(0, o);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array, 128 samples per quantum

    // ── Energy detection for interrupt signalling ──────────────────────────
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    energy /= samples.length;

    if (!this._speaking) {
      if (energy > this._energyThreshold) {
        this._loudFrameCount++;
        this._quietFrameCount = 0;
        if (this._loudFrameCount >= this._speechFrameGate) {
          this._speaking = true;
          this._loudFrameCount = 0;
          // Post immediately — main thread uses this to interrupt AI audio
          this.port.postMessage({ type: 'speech_energy_detected' });
        }
      } else {
        this._loudFrameCount = 0;
      }
    } else {
      // Already speaking — look for silence to reset
      if (energy < this._silenceThreshold) {
        this._quietFrameCount++;
        if (this._quietFrameCount >= this._silenceFrameGate) {
          this._speaking = false;
          this._quietFrameCount = 0;
          this._loudFrameCount  = 0;
        }
      } else {
        this._quietFrameCount = 0;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // ── Downsample to target rate, then PCM buffer + emit ─────────────────
    const resampled = this._resample(samples);

    let offset = 0;
    while (offset < resampled.length) {
      const spaceInBuffer = this._chunkSize - this._bufferFill;
      const available     = resampled.length - offset;
      const toCopy        = Math.min(spaceInBuffer, available);

      this._buffer.set(resampled.subarray(offset, offset + toCopy), this._bufferFill);
      this._bufferFill += toCopy;
      offset           += toCopy;

      if (this._bufferFill === this._chunkSize) {
        this._emit();
      }
    }

    return true; // keep processor alive
  }

  _emit() {
    const int16 = new Int16Array(this._chunkSize);
    for (let i = 0; i < this._chunkSize; i++) {
      const s  = Math.max(-1, Math.min(1, this._buffer[i]));
      int16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    // Transfer the underlying buffer (zero-copy)
    this.port.postMessage(int16, [int16.buffer]);
    this._bufferFill = 0;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
