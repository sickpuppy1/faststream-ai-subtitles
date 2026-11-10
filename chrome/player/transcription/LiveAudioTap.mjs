import {TARGET_SAMPLE_RATE} from './AudioDecoder.mjs';
import {findCutPoint, computeFrameEnergies, speechThreshold, hasSpeech} from './AudioChunker.mjs';

const LIVE_CHUNK = {minSec: 1.5, targetSec: 4, maxSec: 7};
// An utterance is considered finished after this much trailing quiet.
const END_SILENCE_SEC = 0.45;
// A jump between expected and actual media time larger than this is a seek.
const DISCONTINUITY_SEC = 1.0;
const FIR_TAPS = 63;

function makeLowpass(cutoffRatio) {
  const taps = new Float32Array(FIR_TAPS);
  const mid = (FIR_TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < FIR_TAPS; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoffRatio : Math.sin(2 * Math.PI * cutoffRatio * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FIR_TAPS - 1));
    taps[i] = sinc * window;
    sum += taps[i];
  }
  for (let i = 0; i < FIR_TAPS; i++) taps[i] /= sum;
  return taps;
}

/**
 * Fallback for sources whose bytes can't be read ahead (direct video, MP4):
 * taps the player's Web Audio graph while it plays and emits utterance-sized
 * chunks with media timestamps. Subtitles lag by roughly one utterance.
 */
export class LiveAudioTap {
  constructor(client, onChunk) {
    this.client = client;
    this.onChunk = onChunk;
    this.node = null;
    this.sink = null;
    this.reset();
  }

  reset() {
    this.pcm = new Float32Array(TARGET_SAMPLE_RATE * 30);
    this.length = 0;
    this.mediaStart = null;
    this.rate = 1;
    this.history = new Float32Array(FIR_TAPS);
    this.phase = 0;
  }

  async start() {
    const ctx = this.client.audioContext;
    if (!ctx || !this.client.audioOutputNode) throw new Error('Web Audio is not available');
    await ctx.audioWorklet.addModule(new URL('./live-tap.worklet.mjs', import.meta.url).href);
    this.step = ctx.sampleRate / TARGET_SAMPLE_RATE;
    this.taps = makeLowpass(0.45 / this.step);
    this.node = new AudioWorkletNode(ctx, 'fs-live-tap', {numberOfInputs: 1, numberOfOutputs: 1});
    this.node.port.onmessage = (e) => this.onBatch(e.data);
    // Keep the node pulled by the graph without making it audible.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.client.audioOutputNode.connect(this.node);
  }

  stop() {
    if (this.node) {
      try {
        this.client.audioOutputNode?.disconnect(this.node);
      } catch (e) {
        // Graph may already be torn down.
      }
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.sink.disconnect();
      this.node = null;
      this.sink = null;
    }
    this.reset();
  }

  onBatch(samples) {
    const video = this.client.player?.getVideo();
    if (!video || video.paused || video.seeking) return;

    const resampled = this.resample(samples);
    const rate = video.playbackRate || 1;
    const nowMedia = video.currentTime;
    const batchMedia = (resampled.length / TARGET_SAMPLE_RATE) * rate;

    if (this.mediaStart !== null) {
      const expected = this.mediaStart + ((this.length + resampled.length) / TARGET_SAMPLE_RATE) * this.rate;
      if (Math.abs(expected - nowMedia) > DISCONTINUITY_SEC || rate !== this.rate) {
        this.flush(false);
      }
    }
    if (this.mediaStart === null) {
      this.mediaStart = Math.max(0, nowMedia - batchMedia);
      this.rate = rate;
    }

    this.append(resampled);
    this.maybeEmit();
  }

  resample(input) {
    const taps = this.taps;
    const step = this.step;
    // Prepend filter history so the FIR is continuous across batches.
    const src = new Float32Array(FIR_TAPS + input.length);
    src.set(this.history, 0);
    src.set(input, FIR_TAPS);
    const out = [];
    let pos = this.phase;
    while (pos + FIR_TAPS < src.length) {
      const i = Math.floor(pos);
      let acc = 0;
      for (let k = 0; k < FIR_TAPS; k++) acc += src[i + k] * taps[k];
      out.push(acc);
      pos += step;
    }
    this.phase = pos - input.length;
    this.history = src.slice(src.length - FIR_TAPS);
    return Float32Array.from(out);
  }

  append(samples) {
    if (this.length + samples.length > this.pcm.length) {
      const grown = new Float32Array(Math.max(this.pcm.length * 2, this.length + samples.length));
      grown.set(this.pcm.subarray(0, this.length));
      this.pcm = grown;
    }
    this.pcm.set(samples, this.length);
    this.length += samples.length;
  }

  maybeEmit() {
    const seconds = this.length / TARGET_SAMPLE_RATE;
    if (seconds < LIVE_CHUNK.minSec) return;
    const pcm = this.pcm.subarray(0, this.length);

    if (seconds >= LIVE_CHUNK.maxSec) {
      const cut = findCutPoint(pcm, TARGET_SAMPLE_RATE, {...LIVE_CHUNK, isFinal: false});
      this.emit(cut);
      return;
    }

    // Emit early as soon as the speaker pauses, to keep the lag short.
    const energies = computeFrameEnergies(pcm, TARGET_SAMPLE_RATE);
    const threshold = speechThreshold(energies);
    const tailFrames = Math.round(END_SILENCE_SEC / 0.02);
    if (energies.length <= tailFrames) return;
    for (let i = energies.length - tailFrames; i < energies.length; i++) {
      if (energies[i] > threshold) return;
    }
    if (hasSpeech(pcm, TARGET_SAMPLE_RATE)) {
      this.emit(seconds - END_SILENCE_SEC / 2);
    } else if (seconds > LIVE_CHUNK.maxSec / 2) {
      // Nothing but quiet so far; drop it instead of growing forever.
      this.drop(seconds - END_SILENCE_SEC);
    }
  }

  emit(cutSec) {
    const n = Math.round(cutSec * TARGET_SAMPLE_RATE);
    const pcm = this.pcm.slice(0, n);
    const start = this.mediaStart;
    const end = start + cutSec * this.rate;
    this.drop(cutSec);
    this.onChunk({start, end, pcm, rate: this.rate});
  }

  drop(cutSec) {
    const n = Math.min(this.length, Math.round(cutSec * TARGET_SAMPLE_RATE));
    this.pcm.copyWithin(0, n, this.length);
    this.length -= n;
    this.mediaStart += (n / TARGET_SAMPLE_RATE) * this.rate;
  }

  flush(emitRemainder) {
    if (emitRemainder && this.length / TARGET_SAMPLE_RATE >= 0.5) {
      this.emit(this.length / TARGET_SAMPLE_RATE);
    }
    this.length = 0;
    this.mediaStart = null;
  }
}
