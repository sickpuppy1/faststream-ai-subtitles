import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  computeFrameEnergies,
  detectSpeech,
  findCutPoint,
  hasSpeech,
  planChunks,
  speechRatio,
  speechThreshold,
} from '../chrome/player/transcription/AudioChunker.mjs';
import {encodeWav} from '../chrome/player/transcription/WavEncoder.mjs';

const SR = 16000;
const FFMPEG = '/usr/local/bin/ffmpeg';
const FFPROBE = '/usr/local/bin/ffprobe';
const BURSTS = [[0.5, 2.0], [2.6, 4.0], [5.5, 9.0], [9.4, 12.0]];

/**
 * Seeded PRNG (mulberry32) so test signals are repeatable.
 * @param {number} seed Integer seed.
 * @return {function(): number} Returns floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds noise at about -70 dBFS with "speech" bursts (3 sines, ~-21 dBFS).
 * @param {number} seconds Length.
 * @param {Array<[number, number]>} bursts Burst [start, end] pairs in seconds.
 * @param {number} seed PRNG seed.
 * @return {Float32Array} Mono samples.
 */
function makeSignal(seconds, bursts, seed = 1) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const sigma = 10 ** (-70 / 20);
  for (let i = 0; i < n; i++) {
    // Box-Muller transform: two uniforms to one Gaussian.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    out[i] = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  for (const [a, b] of bursts) {
    for (let i = Math.round(a * SR); i < Math.round(b * SR) && i < n; i++) {
      const t = i / SR - a;
      const env = 0.75 + 0.25 * Math.sin(2 * Math.PI * 2 * t);
      const tone = Math.sin(2 * Math.PI * 150 * t) +
        Math.sin(2 * Math.PI * 300 * t + 1) +
        Math.sin(2 * Math.PI * 450 * t + 2);
      out[i] = 0.08 * env * tone;
    }
  }
  return out;
}

/**
 * Checks whether a time falls strictly inside any burst.
 * @param {number} t Time in seconds.
 * @param {Array<[number, number]>} bursts Burst pairs.
 * @return {boolean} True when t is inside a burst.
 */
function insideBurst(t, bursts) {
  return bursts.some(([a, b]) => t > a && t < b);
}

test('detectSpeech finds the four synthetic bursts within 0.2 s', () => {
  const samples = makeSignal(13, BURSTS, 7);
  const regions = detectSpeech(samples, SR);
  assert.equal(regions.length, 4, JSON.stringify(regions));
  BURSTS.forEach(([a, b], k) => {
    // Padding of 150 ms widens each burst on both sides.
    assert.ok(Math.abs(regions[k].start - (a - 0.15)) <= 0.2, `start ${k}`);
    assert.ok(Math.abs(regions[k].end - (b + 0.15)) <= 0.2, `end ${k}`);
  });
  for (let k = 1; k < regions.length; k++) {
    assert.ok(regions[k].start >= regions[k - 1].end, 'sorted, non-overlapping');
  }
});

test('findCutPoint lands in the 4.0-5.5 s gap', () => {
  const samples = makeSignal(13, BURSTS, 7);
  const cut = findCutPoint(samples, SR, {minSec: 3, targetSec: 5, maxSec: 8});
  assert.ok(cut >= 4.0 && cut <= 5.5, `cut=${cut}`);
});

test('planChunks never cuts inside a burst (non-final)', () => {
  const samples = makeSignal(13, BURSTS, 7);
  const {chunks, consumedUntil} = planChunks(samples, SR, {minSec: 3, targetSec: 5, maxSec: 8});
  assert.ok(chunks.length >= 1);
  for (const c of chunks) {
    assert.equal(insideBurst(c.end, BURSTS), false, `cut at ${c.end}`);
    assert.ok(c.end - c.start <= 8 + 1e-9);
  }
  assert.equal(consumedUntil, chunks[chunks.length - 1].end);
  assert.ok(13 - consumedUntil < 8, 'remainder left unconsumed is shorter than maxSec');
});

test('planChunks isFinal covers the whole buffer and never cuts inside a burst', () => {
  const samples = makeSignal(13, BURSTS, 7);
  const {chunks, consumedUntil} = planChunks(samples, SR, {
    minSec: 3, targetSec: 5, maxSec: 8, isFinal: true,
  });
  assert.equal(consumedUntil, 13);
  assert.equal(chunks[chunks.length - 1].end, 13);
  for (let k = 1; k < chunks.length; k++) {
    assert.equal(chunks[k].start, chunks[k - 1].end, 'contiguous');
    assert.equal(insideBurst(chunks[k].start, BURSTS), false);
  }
});

test('findCutPoint isFinal returns duration when it fits in maxSec', () => {
  const samples = makeSignal(7, [[0.5, 3]], 3);
  assert.equal(findCutPoint(samples, SR, {minSec: 3, targetSec: 5, maxSec: 8, isFinal: true}), 7);
});

test('planChunks isFinal merges a tail shorter than 0.5 s into the previous chunk', () => {
  // Silence 0-0.8 s and 7.7-8.3 s (keeps >10% silent frames so the noise floor is real).
  const samples = makeSignal(8.3, [[0.8, 7.7]], 5);
  const {chunks, consumedUntil} = planChunks(samples, SR, {
    minSec: 3, targetSec: 5, maxSec: 8, isFinal: true,
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].end, 8.3);
  assert.equal(consumedUntil, 8.3);
});

test('detectSpeech on the synthetic buffer: speechRatio and hasSpeech behave', () => {
  const samples = makeSignal(13, BURSTS, 7);
  assert.equal(speechRatio(samples, SR, 0.6, 1.9), 1);
  assert.equal(speechRatio(samples, SR, 4.2, 5.3), 0);
  assert.equal(hasSpeech(samples, SR), true);
  assert.equal(hasSpeech(makeSignal(5, [], 9), SR), false);
});

test('speech threshold uses the absolute minimum on quiet noise', () => {
  const energies = computeFrameEnergies(makeSignal(2, [], 2), SR, 20);
  assert.equal(speechThreshold(energies), -55);
});

test('encodeWav writes a valid 16 kHz mono 16-bit header and round-trips samples', () => {
  const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, 1 / 3]);
  const bytes = encodeWav(input, SR);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) => String.fromCharCode(...bytes.subarray(off, off + 4));

  assert.equal(bytes.byteLength, 44 + input.length * 2);
  assert.equal(tag(0), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + input.length * 2);
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), SR);
  assert.equal(view.getUint32(28, true), 32000, 'byteRate');
  assert.equal(view.getUint16(32, true), 2, 'blockAlign');
  assert.equal(view.getUint16(34, true), 16, 'bitsPerSample');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint32(40, true), input.length * 2);

  for (let i = 0; i < input.length; i++) {
    const decoded = view.getInt16(44 + i * 2, true) / 32767;
    const expected = Math.min(1, Math.max(-1, input[i]));
    assert.ok(Math.abs(decoded - expected) <= 1 / 32767 + 1e-9, `sample ${i}`);
  }
});

test('encodeWav output is read back as 16 kHz mono by ffprobe', {skip: !existsSync(FFPROBE)}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chunker-wav-'));
  const file = join(dir, 'out.wav');
  writeFileSync(file, encodeWav(makeSignal(1, [[0.1, 0.9]], 4), SR));
  const probe = JSON.parse(execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'json', file,
  ], {encoding: 'utf8'}));
  const stream = probe.streams[0];
  assert.equal(stream.sample_rate, '16000');
  assert.equal(stream.channels, 1);
  assert.equal(stream.codec_name, 'pcm_s16le');
});

const canSay = process.platform === 'darwin' && existsSync('/usr/bin/say') && existsSync(FFMPEG);

test('real Japanese speech from macOS say: 3 regions and a cut in the first pause', {skip: !canSay}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chunker-say-'));
  const aiff = join(dir, 'x.aiff');
  const raw = join(dir, 'x.raw');
  execFileSync('say', [
    '-v', 'Kyoko', '-o', aiff,
    '今日はいい天気ですね。[[slnc 900]]駅の近くに新しいカフェができました。[[slnc 900]]一緒に行きませんか。',
  ]);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', aiff, '-f', 'f32le', '-ac', '1', '-ar', '16000', raw]);
  const bytes = readFileSync(raw);
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  const samples = new Float32Array(aligned);

  const regions = detectSpeech(samples, SR);
  assert.equal(regions.length, 3, JSON.stringify(regions));

  const gapStart = regions[0].end;
  const gapEnd = regions[1].start;
  const cut = findCutPoint(samples, SR, {
    minSec: gapStart, targetSec: (gapStart + gapEnd) / 2, maxSec: gapEnd,
  });
  assert.ok(cut >= gapStart && cut <= gapEnd, `cut=${cut} gap=${gapStart}-${gapEnd}`);
  assert.equal(speechRatio(samples, SR, cut - 0.05, cut + 0.05), 0, 'samples near the cut are quiet');
});

test('planChunks on 30 s of noise runs under 20 ms', () => {
  const samples = makeSignal(30, [], 11);
  const opts = {minSec: 3, targetSec: 5, maxSec: 8};
  planChunks(samples, SR, opts); // warm-up so JIT cost is not measured
  const t0 = performance.now();
  planChunks(samples, SR, opts);
  const ms = performance.now() - t0;
  assert.ok(ms < 20, `took ${ms.toFixed(2)} ms`);
});
