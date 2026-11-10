import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  concatBytes,
  extractTsAudio,
  findTsSyncOffset,
  isLikelyTs,
} from '../chrome/player/transcription/TsAudioDemuxer.mjs';

const FFMPEG = existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = existsSync('/usr/local/bin/ffprobe') ? '/usr/local/bin/ffprobe' : 'ffprobe';
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const dir = mkdtempSync(join(tmpdir(), 'ts-audio-demuxer-'));

/**
 * Runs ffmpeg with the given args and throws if it fails.
 * @param {string[]} args Arguments for ffmpeg.
 */
function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: dir,
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  }
}

/**
 * Returns the duration of a media file in seconds, via ffprobe.
 * @param {string} file Path to the file.
 * @return {number} Duration in seconds (NaN if ffprobe fails).
 */
function probeDuration(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  if (r.status !== 0) return NaN;
  return parseFloat(r.stdout.toString().trim());
}

/**
 * Writes bytes to a file in the temp dir and probes its duration.
 * @param {string} name File name inside the temp dir.
 * @param {Uint8Array} bytes Bytes to write.
 * @return {number} Duration in seconds, per ffprobe.
 */
function writeAndProbe(name, bytes) {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return probeDuration(file);
}

before(() => {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders']).stdout.toString();
  const hasX264 = /\blibx264\b/.test(enc);
  const video = hasX264 ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg2video'];
  const src = [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=3',
  ];
  ffmpeg([...src, ...video, '-c:a', 'aac', '-shortest', '-f', 'mpegts', join(dir, 'a.ts')]);
  ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=3',
    ...video, '-c:a', 'mp2', '-shortest', '-f', 'mpegts', join(dir, 'mp2.ts'),
  ]);
  // 2 segments of 1s each, cut on keyframes every second.
  ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=2',
    ...video,
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:a', 'aac', '-shortest',
    '-f', 'segment', '-segment_time', '1', '-reset_timestamps', '1',
    '-segment_format', 'mpegts', join(dir, 'seg%03d.ts'),
  ]);
});

after(() => rmSync(dir, {recursive: true, force: true}));

test('AAC TS: extracts ADTS AAC with a finite first PTS', () => {
  const bytes = new Uint8Array(readFileSync(join(dir, 'a.ts')));
  const out = extractTsAudio(bytes);
  assert.equal(out.codec, 'aac');
  assert.ok(out.data.length > 0);
  assert.equal(out.data[0], 0xff);
  assert.equal((out.data[1] & 0xf0), 0xf0);
  assert.ok(Number.isFinite(out.firstPts));
  assert.ok(out.pid !== null);
});

test('AAC TS with PNG signature and 1500 junk bytes prefix: same data', () => {
  const ts = new Uint8Array(readFileSync(join(dir, 'a.ts')));
  const plain = extractTsAudio(ts);
  const junk = randomBytes(1500);
  const prefixed = concatBytes([PNG_SIGNATURE, new Uint8Array(junk), ts]);
  assert.equal(findTsSyncOffset(prefixed), PNG_SIGNATURE.length + 1500);
  assert.equal(isLikelyTs(prefixed), true);
  const out = extractTsAudio(prefixed);
  assert.equal(out.codec, 'aac');
  assert.deepEqual(Buffer.from(out.data), Buffer.from(plain.data));
});

test('extracted AAC decodes with ffprobe to about 3.0s', () => {
  const out = extractTsAudio(new Uint8Array(readFileSync(join(dir, 'a.ts'))));
  const d = writeAndProbe('out-a.aac', out.data);
  assert.ok(Math.abs(d - 3.0) < 0.15, `duration was ${d}`);
});

test('MP2 TS: codec mp3, data decodes with ffprobe', () => {
  const out = extractTsAudio(new Uint8Array(readFileSync(join(dir, 'mp2.ts'))));
  assert.equal(out.codec, 'mp3');
  assert.ok(out.data.length > 0);
  const d = writeAndProbe('out-mp2.mp2', out.data);
  assert.ok(d > 2.5 && d < 3.5, `duration was ${d}`);
});

test('random garbage and empty input: codec null, no throw', () => {
  const garbage = new Uint8Array(randomBytes(4096));
  // Remove any accidental sync bytes so the input is truly not TS.
  for (let i = 0; i < garbage.length; i++) if (garbage[i] === 0x47) garbage[i] = 0x48;
  for (const input of [garbage, new Uint8Array(0)]) {
    const out = extractTsAudio(input);
    assert.equal(out.codec, null);
    assert.equal(out.data.length, 0);
    assert.equal(out.firstPts, null);
    assert.equal(out.pid, null);
  }
  assert.equal(extractTsAudio(null).codec, null);
});

test('truncated TS does not throw', () => {
  const ts = new Uint8Array(readFileSync(join(dir, 'a.ts')));
  for (const len of [1, 187, 188, 500, 4000]) {
    assert.doesNotThrow(() => extractTsAudio(ts.subarray(0, len)));
  }
});

test('two consecutive HLS-style segments: concatenated audio ~ 2.0s', () => {
  const parts = [0, 1].map((i) => {
    const name = `seg${String(i).padStart(3, '0')}.ts`;
    const out = extractTsAudio(new Uint8Array(readFileSync(join(dir, name))));
    assert.equal(out.codec, 'aac');
    return out.data;
  });
  const d = writeAndProbe('out-seg.aac', concatBytes(parts));
  assert.ok(Math.abs(d - 2.0) < 0.15, `duration was ${d}`);
});

test('findTsSyncOffset: edge cases', () => {
  assert.equal(findTsSyncOffset(new Uint8Array(0)), -1);
  assert.equal(findTsSyncOffset(new Uint8Array([0x47])), 0);
  const two = new Uint8Array(376);
  two[0] = 0x47;
  two[188] = 0x47;
  assert.equal(findTsSyncOffset(two), 0);
  const oneMissing = new Uint8Array(564);
  oneMissing[0] = 0x47;
  oneMissing[188] = 0x47;
  assert.equal(findTsSyncOffset(oneMissing), -1);
});
