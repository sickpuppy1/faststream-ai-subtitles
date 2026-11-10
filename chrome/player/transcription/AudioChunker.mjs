/**
 * Voice-activity detection and pause-aligned chunk planning for mono PCM.
 * All functions are pure. Times are seconds from the start of `samples`.
 */

export const ChunkerDefaults = Object.freeze({
  frameMs: 20,
  minSilenceMs: 250,
  minSpeechMs: 120,
  speechPadMs: 150,
  thresholdAboveFloorDb: 12,
  absoluteMinDb: -55,
});

const FLOOR_DB = -100;
// Shortest gap between words that is still a usable cut when no real pause exists.
const SHORT_PAUSE_MS = 100;
const FALLBACK_TARGET_BIAS_DB = 4;
const MIN_TAIL_SEC = 0.5;
const MIN_TOTAL_SPEECH_SEC = 0.3;
const EPS = 1e-9;

/**
 * Merges caller options over the defaults.
 * @param {Object} opts Partial options.
 * @return {Object} Full options.
 */
function resolve(opts) {
  return {...ChunkerDefaults, ...opts};
}

/**
 * Number of samples in one analysis frame (at least 1).
 * @param {number} sampleRate Samples per second.
 * @param {number} frameMs Frame length in milliseconds.
 * @return {number} Samples per frame.
 */
function frameLength(sampleRate, frameMs) {
  return Math.max(1, Math.round((sampleRate * frameMs) / 1000));
}

/**
 * Frame duration in seconds after rounding to whole samples.
 * @param {number} sampleRate Samples per second.
 * @param {number} frameMs Frame length in milliseconds.
 * @return {number} Seconds per frame.
 */
function frameSeconds(sampleRate, frameMs) {
  return frameLength(sampleRate, frameMs) / sampleRate;
}

/**
 * Computes the RMS level of each non-overlapping frame in dBFS.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {number} frameMs Frame length in milliseconds.
 * @return {Float32Array} One dB value per frame, floored at -100.
 */
export function computeFrameEnergies(samples, sampleRate, frameMs = 20) {
  const len = frameLength(sampleRate, frameMs);
  const count = Math.ceil(samples.length / len);
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * len;
    const end = Math.min(samples.length, start + len);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      sumSq += samples[i] * samples[i];
    }
    const meanSq = sumSq / (end - start);
    // 20*log10(rms) equals 10*log10(mean square).
    out[f] = meanSq > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(meanSq)) : FLOOR_DB;
  }
  return out;
}

/**
 * Estimates background level as the 10th percentile of frame energies.
 * @param {ArrayLike<number>} energiesDb Frame energies in dBFS.
 * @return {number} Noise floor in dBFS.
 */
export function estimateNoiseFloor(energiesDb) {
  const n = energiesDb.length;
  if (n === 0) return FLOOR_DB;
  const sorted = Float32Array.from(energiesDb).sort();
  return sorted[Math.floor(0.1 * (n - 1))];
}

/**
 * Speech threshold in dBFS: noise floor plus margin, but never below the absolute minimum.
 * @param {ArrayLike<number>} energiesDb Frame energies in dBFS.
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {number} Threshold in dBFS.
 */
export function speechThreshold(energiesDb, opts = {}) {
  const o = resolve(opts);
  return Math.max(
      estimateNoiseFloor(energiesDb) + o.thresholdAboveFloorDb,
      o.absoluteMinDb,
  );
}

/**
 * Finds speech regions: frames above threshold, with short gaps merged,
 * short blips dropped and each region padded.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {Array<{start: number, end: number}>} Sorted, non-overlapping regions in seconds.
 */
export function detectSpeech(samples, sampleRate, opts = {}) {
  const o = resolve(opts);
  const duration = samples.length / sampleRate;
  const {energies, thr, fSec} = analyze(samples, sampleRate, o);

  // Raw runs of voiced frames.
  const raw = [];
  let i = 0;
  while (i < energies.length) {
    if (energies[i] <= thr) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < energies.length && energies[j + 1] > thr) j++;
    raw.push({start: i * fSec, end: Math.min(duration, (j + 1) * fSec)});
    i = j + 1;
  }

  // Merge runs separated by a gap shorter than minSilenceMs.
  const minSilenceSec = o.minSilenceMs / 1000;
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minSilenceSec - EPS) {
      last.end = r.end;
    } else {
      merged.push({...r});
    }
  }

  // Drop regions shorter than minSpeechMs, then pad and merge overlaps.
  const minSpeechSec = o.minSpeechMs / 1000;
  const padSec = o.speechPadMs / 1000;
  const out = [];
  for (const r of merged) {
    if (r.end - r.start < minSpeechSec - EPS) continue;
    const start = Math.max(0, r.start - padSec);
    const end = Math.min(duration, r.end + padSec);
    const last = out[out.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({start, end});
    }
  }
  return out;
}

/**
 * Chooses a pause-aligned cut point inside a time window.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {{minSec: number, targetSec: number, maxSec: number, isFinal?: boolean}} range
 *   Window and target, in seconds from the start of `samples`.
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {number} Cut time in seconds, clamped to the window.
 */
export function findCutPoint(samples, sampleRate, {minSec, targetSec, maxSec, isFinal = false}, opts = {}) {
  const o = resolve(opts);
  const duration = samples.length / sampleRate;
  if (isFinal && duration <= maxSec) return duration;
  const {energies, thr, fSec} = analyze(samples, sampleRate, o);
  return cutFromEnergies(energies, thr, fSec, duration, {minSec, targetSec, maxSec}, o);
}

/**
 * Splits audio into chunks, cutting at pauses.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {{minSec: number, targetSec: number, maxSec: number, isFinal?: boolean}} range
 *   Chunk length window, in seconds, applied to the remaining audio at each step.
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {{chunks: Array<{start: number, end: number}>, consumedUntil: number}}
 *   Chunks in seconds, plus how much audio is covered (the rest is left for later).
 */
export function planChunks(samples, sampleRate, {minSec, targetSec, maxSec, isFinal = false}, opts = {}) {
  const o = resolve(opts);
  const len = samples.length;
  const duration = len / sampleRate;
  const {thr} = analyze(samples, sampleRate, o);
  const fSec = frameSeconds(sampleRate, o.frameMs);
  const chunks = [];
  let idx = 0;

  for (;;) {
    const remainSec = (len - idx) / sampleRate;
    if (remainSec <= 0) break;
    if (isFinal ? remainSec <= maxSec : remainSec < maxSec) break;
    const energies = computeFrameEnergies(samples.subarray(idx), sampleRate, o.frameMs);
    let cutSec = cutFromEnergies(energies, thr, fSec, remainSec, {minSec, targetSec, maxSec}, o);
    if (!(cutSec > 0)) cutSec = Math.min(maxSec, remainSec);
    const cutIdx = Math.min(len, idx + Math.max(1, Math.round(cutSec * sampleRate)));
    chunks.push({start: idx / sampleRate, end: cutIdx / sampleRate});
    idx = cutIdx;
  }

  if (isFinal && idx < len) {
    const tailSec = (len - idx) / sampleRate;
    if (tailSec < MIN_TAIL_SEC && chunks.length > 0) {
      chunks[chunks.length - 1].end = duration;
    } else {
      chunks.push({start: idx / sampleRate, end: duration});
    }
  }

  return {chunks, consumedUntil: isFinal ? duration : idx / sampleRate};
}

/**
 * Fraction of frames in [start, end) whose energy is above the speech threshold.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {number} start Window start in seconds.
 * @param {number} end Window end in seconds (exclusive).
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {number} Ratio between 0 and 1 (0 when the window has no frames).
 */
export function speechRatio(samples, sampleRate, start, end, opts = {}) {
  const o = resolve(opts);
  const {energies, thr, fSec} = analyze(samples, sampleRate, o);
  const first = Math.max(0, Math.ceil(start / fSec - EPS));
  const last = Math.min(energies.length, Math.ceil(end / fSec - EPS));
  let voiced = 0;
  let total = 0;
  for (let i = first; i < last; i++) {
    total++;
    if (energies[i] > thr) voiced++;
  }
  return total > 0 ? voiced / total : 0;
}

/**
 * True when detected speech regions add up to at least 0.3 s.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {Object} [opts] Overrides for ChunkerDefaults.
 * @return {boolean} Whether the audio contains enough speech.
 */
export function hasSpeech(samples, sampleRate, opts = {}) {
  let total = 0;
  for (const r of detectSpeech(samples, sampleRate, opts)) {
    total += r.end - r.start;
  }
  return total >= MIN_TOTAL_SPEECH_SEC;
}

/**
 * Frame energies, speech threshold and frame duration for one buffer.
 * @param {Float32Array} samples Mono samples.
 * @param {number} sampleRate Samples per second.
 * @param {Object} o Resolved options.
 * @return {{energies: Float32Array, thr: number, fSec: number}} Analysis state.
 */
function analyze(samples, sampleRate, o) {
  const energies = computeFrameEnergies(samples, sampleRate, o.frameMs);
  return {
    energies,
    thr: speechThreshold(energies, o),
    fSec: frameSeconds(sampleRate, o.frameMs),
  };
}

/**
 * Core cut search on precomputed frame energies.
 * Prefers the silence run with the best score, else the quietest 5-frame region.
 * @param {Float32Array} energies Frame energies in dBFS.
 * @param {number} thr Speech threshold in dBFS.
 * @param {number} fSec Seconds per frame.
 * @param {number} duration Length of the audio in seconds.
 * @param {{minSec: number, targetSec: number, maxSec: number}} range Window.
 * @param {Object} o Resolved options.
 * @return {number} Cut time in seconds.
 */
function cutFromEnergies(energies, thr, fSec, duration, range, o) {
  const {minSec, targetSec} = range;
  const hi = Math.min(range.maxSec, duration);
  if (hi < minSec) return hi;
  const clamp = (t) => Math.min(hi, Math.max(minSec, t));

  const n = energies.length;
  const iMin = Math.max(0, Math.ceil(minSec / fSec - EPS));
  const iMax = Math.min(n - 1, Math.floor(hi / fSec + EPS));
  if (iMin > iMax) return clamp(targetSec);

  // Silence runs: score = min(length, 1 s) - 0.2 * distance from target.
  // Prefer real pauses; if there are none, a short gap between words still beats
  // cutting at an arbitrary quiet frame inside a word.
  for (const minRunMs of [o.minSilenceMs, SHORT_PAUSE_MS]) {
    let bestCenter = null;
    let bestScore = -Infinity;
    let i = 0;
    while (i < n) {
      if (energies[i] > thr) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && energies[j + 1] <= thr) j++;
      const runSec = (j - i + 1) * fSec;
      const a = Math.max(i, iMin);
      const b = Math.min(j, iMax);
      if (runSec * 1000 + EPS >= minRunMs && a <= b) {
        const center = ((a + b + 1) / 2) * fSec;
        // Long pauses usually separate sentences/speakers, so they outweigh hitting the target length.
        const score = Math.min(runSec, 1.5) - 0.1 * Math.abs(center - targetSec);
        if (score > bestScore) {
          bestScore = score;
          bestCenter = center;
        }
      }
      i = j + 1;
    }
    if (bestCenter !== null) return clamp(bestCenter);
  }

  // Fallback: frame with the lowest 5-frame moving average (dB values averaged).
  let bestFrame = iMin;
  let bestAvg = Infinity;
  for (let f = iMin; f <= iMax; f++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) {
      sum += energies[k];
      count++;
    }
    // 4 dB per second away from the target, so an early dip doesn't make a tiny chunk.
    const biased = sum / count + FALLBACK_TARGET_BIAS_DB * Math.abs(f * fSec - targetSec);
    if (biased < bestAvg) {
      bestAvg = biased;
      bestFrame = f;
    }
  }
  return clamp((bestFrame + 0.5) * fSec);
}
