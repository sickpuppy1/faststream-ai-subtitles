#!/usr/bin/env node
// Generates the e2e test programme (A/V), ground truth, and all packagings.
// Usage: node e2e/fixtures/make-fixtures.mjs
// Needs: ffmpeg/ffprobe on PATH (or /usr/local/bin), macOS `say`. No npm deps.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const WORK = path.join(OUT, 'work');
const FFMPEG = process.env.FFMPEG || '/usr/local/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE || '/usr/local/bin/ffprobe';
const SR = 48000;
const CH = 2;
const FPS = 25;
const W = 1280;
const H = 720;
const SEGMENT = 4; // seconds per HLS/DASH segment
const SPEECH_THRESH_DB = -45; // onset/offset detection threshold
const NOISE_DB = -45; // pink noise bed RMS
const MUSIC_DB = -22; // music RMS target
const LEAD_IN = 0.8; // seconds of silence before first item
const TAIL = 1.0; // seconds of silence after last item
const FONT = '/Library/Fonts/Arial Unicode.ttf';

// ---------------------------------------------------------------------------
// Programme content. 19 Japanese + 5 English everyday-conversation lines.
// Order is fixed; two music-only sections are inserted at MUSIC_AFTER indexes.
// ---------------------------------------------------------------------------
const UTTERANCES = [
  {lang: 'ja', text: 'おはようございます。今日はすごくいい天気ですね。昨日の夜は雨だったので、ほっとしました。'},
  {lang: 'ja', text: 'そうですね。午後から少し雨が降るみたいなので、念のため傘を持って行った方がいいと思いますよ。'},
  {lang: 'ja', text: 'じゃあ、折りたたみの傘をかばんに入れておきますね。帰りに困らないように。'},
  {lang: 'en', text: 'Did you get a chance to look at the new menu yet? I heard the lunch specials are really good this week.'},
  {lang: 'ja', text: '昨日の夜、駅の近くに新しいレストランができたので、友達と一緒に行ってきました。とても混んでいました。'},
  {lang: 'ja', text: 'どうでしたか？料理はおいしかったですか？注文は何にしたんですか？'},
  {lang: 'ja', text: 'はい、特にパスタが本当においしかったです。ソースもあっさりしていて、店員さんも親切でした。'},
  {lang: 'ja', text: '今度、一緒に行きましょうよ。次は私がお店を予約しておきますから。'},
  {lang: 'ja', text: 'いいですね。来週の週末はどうですか？天気がよければ、公園でランチもいいかもしれません。'},
  {lang: 'en', text: 'Yes, I think I will order the salmon this time. It looks really fresh in the photos online.'},
  {lang: 'ja', text: '土曜日なら空いていると思います。午前中は特に予定がないので、ゆっくり準備できそうです。'},
  {lang: 'ja', text: 'それじゃあ、土曜日の十二時に駅の前で待ち合わせしましょう。改札を出たところで待っていますね。'},
  {lang: 'ja', text: 'わかりました。遅れないようにしますね。電車が少し混むかもしれないので、早めに家を出ます。'},
  {lang: 'ja', text: 'ところで、この資料はもう確認しましたか？明日の会議で使うので、今日中に見ておいてほしいんです。'},
  {lang: 'en', text: 'Sounds good. I will call the restaurant tomorrow morning to confirm a table for four people.'},
  {lang: 'ja', text: 'まだです。夕方までには目を通しておきます。気になるところがあれば、またメールで聞きますね。'},
  {lang: 'ja', text: 'ありがとうございます。とても助かります。本当にいつもすみません。'},
  {lang: 'ja', text: 'コーヒーでも飲みに行きませんか？近くにいいカフェがあるんですよ。窓際の席がとても落ち着くんです。'},
  {lang: 'ja', text: 'ぜひ。最近、週末に散歩をするのが楽しくなってきました。朝の空気がとても気持ちいいんですよ。'},
  {lang: 'en', text: 'Thanks for helping me move last weekend. I could not have carried the sofa without you.'},
  {lang: 'ja', text: 'それはいいですね。どこかおすすめの公園はありますか？静かな場所だと嬉しいです。'},
  {lang: 'ja', text: '川沿いの公園が静かで気持ちいいですよ。ベンチもたくさんあるので、今度一緒に案内しますね。'},
  {lang: 'ja', text: 'ありがとうございます。楽しみにしていますね。お弁当を持って行くのもいいかもしれません。'},
  {lang: 'en', text: 'No problem at all, see you on Monday. Have a great rest of your weekend.'},
];
const MUSIC_AFTER = [8, 17]; // insert a music section after utterance index (0-based)
const MUSIC_LEN = 7; // seconds

// Deterministic PRNG (mulberry32) so gaps are stable between runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gap (seconds) between consecutive items; 0.3..2.5 s, with both extremes forced in.
function makeGaps(count) {
  const r = rng(20261020);
  const gaps = [];
  for (let i = 0; i < count; i++) {
    gaps.push(Math.round((0.3 + r() * 2.2) * 1000) / 1000);
  }
  gaps[0] = 0.3;
  gaps[Math.floor(count / 2)] = 2.5;
  return gaps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function run(bin, args, opts = {}) {
  try {
    const {stdout} = await execFileP(bin, args, {maxBuffer: 256 * 1024 * 1024, ...opts});
    return stdout;
  } catch (err) {
    const tail = String(err.stderr || err.message).split('\n').slice(-15).join('\n');
    throw new Error(`${path.basename(bin)} ${args.slice(0, 3).join(' ')} failed:\n${tail}`);
  }
}

async function ffmpeg(args) {
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function ffprobeValue(file, entries = 'format=duration') {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]);
  return out.trim();
}

const db = (lin) => 20 * Math.log10(Math.max(lin, 1e-12));
const lin = (dB) => Math.pow(10, dB / 20);

function rmsOf(f32) {
  let s = 0;
  for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  return Math.sqrt(s / Math.max(1, f32.length));
}

// Find speech span in interleaved stereo f32 using 5 ms RMS windows over the
// mono mix, threshold SPEECH_THRESH_DB. Returns [startFrame, endFrame).
function speechSpan(f32) {
  const frames = f32.length / CH;
  const win = Math.round(0.005 * SR);
  const thr = lin(SPEECH_THRESH_DB);
  let first = -1;
  let last = -1;
  for (let w = 0; w * win < frames; w++) {
    const a = w * win;
    const b = Math.min(frames, a + win);
    let s = 0;
    for (let i = a; i < b; i++) {
      const l = f32[2 * i];
      const r = f32[2 * i + 1];
      s += (l * l + r * r) / 2;
    }
    const rms = Math.sqrt(s / (b - a));
    if (rms > thr) {
      if (first < 0) first = a;
      last = b;
    }
  }
  if (first < 0) throw new Error('no speech above threshold in clip');
  return [first, last];
}

// ---------------------------------------------------------------------------
// Stage 1: speech clips (say -> raw f32 48k stereo -> trimmed + normalised)
// ---------------------------------------------------------------------------
async function sayVoice(lang) {
  const voices = (await run('say', ['-v', '?'])).split('\n');
  if (lang === 'ja') return voices.some((l) => l.startsWith('Kyoko ')) ? 'Kyoko' : null;
  return voices.some((l) => l.startsWith('Samantha ')) ? 'Samantha' : null;
}

async function buildClips() {
  const clips = [];
  for (let i = 0; i < UTTERANCES.length; i++) {
    const u = UTTERANCES[i];
    const id = String(i + 1).padStart(2, '0');
    const voice = await sayVoice(u.lang);
    if (!voice) throw new Error(`no say voice for ${u.lang}`);
    const aiff = path.join(WORK, `u${id}.aiff`);
    const raw = path.join(WORK, `u${id}.f32`);
    await run('say', ['-v', voice, '-o', aiff, u.text]);
    await ffmpeg(['-i', aiff, '-ar', String(SR), '-ac', String(CH), '-f', 'f32le', raw]);
    const buf = await fs.readFile(raw);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const [a, b] = speechSpan(f32);
    // trimmed copy, 3 ms fades to avoid clicks, normalised to peak -3 dBFS
    const n = b - a;
    const out = new Float32Array(n * CH);
    let peak = 0;
    for (let k = 0; k < n * CH; k++) peak = Math.max(peak, Math.abs(f32[a * CH + k]));
    const gain = lin(-3) / peak;
    const fade = Math.round(0.003 * SR);
    for (let i2 = 0; i2 < n; i2++) {
      let env = 1;
      if (i2 < fade) env = i2 / fade;
      if (n - 1 - i2 < fade) env = Math.min(env, (n - 1 - i2) / fade);
      for (let c = 0; c < CH; c++) out[i2 * CH + c] = f32[(a + i2) * CH + c] * gain * env;
    }
    clips.push({...u, id, voice, samples: out, frames: n, trimmedStartFrame: a, rawFrames: f32.length / CH});
    process.stdout.write(`  u${id} ${voice.padEnd(8)} ${(n / SR).toFixed(3)}s  ${u.text}\n`);
  }
  return clips;
}

// ---------------------------------------------------------------------------
// Stage 2: music (ffmpeg aevalsrc) and pink noise bed (ffmpeg anoisesrc)
// ---------------------------------------------------------------------------
async function buildMusic() {
  // Chords (C, F, G, Am), 1.75 s each, 3 sine voices per chord.
  const chords = [
    [261.63, 329.63, 392.0],
    [349.23, 440.0, 523.25],
    [392.0, 493.88, 587.33],
    [220.0, 261.63, 329.63],
  ];
  const amp = 0.065; // 3 uncorrelated voices -> RMS ~ -22 dBFS
  const k = 'floor(t/1.75)';
  const pick = (voice) => {
    // nested if(eq(k,i),freq,...) — commas escaped for the filtergraph parser
    let e = `${chords[3][voice]}`;
    for (let c = 2; c >= 0; c--) e = `if(eq(${k}\\,${c})\\,${chords[c][voice]}\\,${e})`;
    return e;
  };
  const fade = 'min(1\\,t*4)*min(1\\,(7-t)*4)';
  const voices = [0, 1, 2].map((v) => `sin(2*PI*${pick(v)}*t)`).join('+');
  const expr = `${amp}*(${voices})*${fade}`;
  const rawPath = path.join(WORK, 'music.f32');
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=exprs=${expr}|${expr}:s=${SR}:d=${MUSIC_LEN}`,
    '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), rawPath]);
  const buf = await fs.readFile(rawPath);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  // Measure and nudge to the exact target RMS (keeps the -22 dBFS spec honest).
  const g = lin(MUSIC_DB) / rmsOf(f32);
  for (let i = 0; i < f32.length; i++) f32[i] *= g;
  return f32;
}

async function buildNoise(totalSeconds) {
  const rawPath = path.join(WORK, 'noise.f32');
  await ffmpeg(['-f', 'lavfi', '-i',
    `anoisesrc=color=pink:sample_rate=${SR}:duration=${totalSeconds + 1}:amplitude=0.1,aformat=channel_layouts=stereo`,
    '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), rawPath]);
  const buf = await fs.readFile(rawPath);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const g = lin(NOISE_DB) / rmsOf(f32);
  for (let i = 0; i < f32.length; i++) f32[i] *= g;
  return f32;
}

// ---------------------------------------------------------------------------
// Stage 3: timeline, mix, ground truth
// ---------------------------------------------------------------------------
function buildTimeline(clips, musicLen) {
  // items: utterance clips and music sections, in order
  const items = [];
  clips.forEach((c, i) => {
    items.push({kind: 'speech', clip: c});
    if (MUSIC_AFTER.includes(i)) items.push({kind: 'music'});
  });
  const gapsSec = makeGaps(items.length - 1);
  const placed = [];
  let pos = Math.round(LEAD_IN * SR);
  items.forEach((it, idx) => {
    const len = it.kind === 'speech' ? it.clip.frames : musicLen;
    placed.push({...it, start: pos, len});
    pos += len;
    if (idx < items.length - 1) pos += Math.round(gapsSec[idx] * SR);
  });
  const totalFrames = pos + Math.round(TAIL * SR);
  return {placed, totalFrames, gapsSec};
}

function mix(placed, totalFrames, music, noise) {
  const out = new Float32Array(totalFrames * CH);
  for (let i = 0; i < out.length; i++) out[i] = noise[i];
  for (const p of placed) {
    const src = p.kind === 'speech' ? p.clip.samples : music;
    const base = p.start * CH;
    for (let i = 0; i < src.length; i++) out[base + i] += src[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4: video (drawtext burn-in) + master encode
// ---------------------------------------------------------------------------
async function hasDrawtext() {
  const f = await run(FFMPEG, ['-hide_banner', '-filters']).catch(() => '');
  return /\bdrawtext\b/.test(f) && (await fs.stat(FONT).then(() => true, () => false));
}

// drawtext does not wrap, so split long lines: words for ASCII, 26 chars for CJK.
function wrapText(text) {
  if (/^[\x00-\x7f]+$/.test(text)) {
    const lines = [];
    let cur = '';
    for (const w of text.split(' ')) {
      if ((cur + ' ' + w).trim().length > 50) {
        lines.push(cur.trim()); cur = w;
      } else cur += ' ' + w;
    }
    lines.push(cur.trim());
    return lines.join('\n');
  }
  const chars = [...text];
  const lines = [];
  for (let i = 0; i < chars.length; i += 26) lines.push(chars.slice(i, i + 26).join(''));
  return lines.join('\n');
}

async function writeTextFiles(placed) {
  const dir = path.join(WORK, 'text');
  await fs.mkdir(dir, {recursive: true});
  const files = new Map();
  for (const p of placed) {
    const name = p.kind === 'speech' ? `u${p.clip.id}.txt` : 'music.txt';
    const text = p.kind === 'speech' ? p.clip.text : '♪ music only (no speech) ♪';
    await fs.writeFile(path.join(dir, name), wrapText(text), 'utf8');
    files.set(p, path.join(dir, name));
  }
  return files;
}

function drawChain(placed, files) {
  const parts = [];
  for (const p of placed) {
    const a = (p.start / SR).toFixed(6);
    const b = ((p.start + p.len) / SR).toFixed(6);
    parts.push(`drawtext=fontfile='${FONT}':textfile='${files.get(p)}':fontsize=36:fontcolor=white:` +
      `x=(w-text_w)/2:y=h-170:box=1:boxcolor=black@0.6:boxborderw=14:enable='between(t,${a},${b})'`);
  }
  parts.push(`drawtext=fontfile='${FONT}':text='%{pts\\:hms}':fontsize=96:fontcolor=white:` +
    `x=40:y=36:box=1:boxcolor=black@0.5:boxborderw=12`);
  return parts.join(',');
}

async function encodeMaster(totalSec, audioRaw, vfChain) {
  const target = path.join(OUT, 'mp4', 'video.mp4');
  const video = vfChain ?
    ['-f', 'lavfi', '-i', `color=c=0x101418:s=${W}x${H}:r=${FPS}:d=${totalSec}`] :
    ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=${totalSec}`];
  await ffmpeg([...video,
    '-f', 'f32le', '-ar', String(SR), '-ac', String(CH), '-i', audioRaw,
    ...(vfChain ? ['-vf', vfChain] : []),
    '-map', '0:v', '-map', '1:a', '-t', String(totalSec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-level', '3.1', '-r', String(FPS),
    '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-x264-params', 'open_gop=0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(SR), '-ac', String(CH),
    '-movflags', '+faststart', target]);
  return target;
}

// ---------------------------------------------------------------------------
// Stage 5: packagings (all with -c copy from the master)
// ---------------------------------------------------------------------------
async function packageHlsTs(master) {
  const dir = path.join(OUT, 'hls-ts');
  await fs.mkdir(dir, {recursive: true});
  await ffmpeg(['-i', master, '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'hls',
    '-hls_time', String(SEGMENT), '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%03d.ts'), path.join(dir, 'video.m3u8')]);
  const bytes = (await fs.stat(master)).size;
  const dur = Number(await ffprobeValue(master));
  const bw = Math.round((bytes * 8) / dur);
  const master_m3u8 = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${bw},RESOLUTION=${W}x${H},FRAME-RATE=${FPS}.000,` +
      'CODECS="avc1.64001f,mp4a.40.2"',
    'video.m3u8', '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'master.m3u8'), master_m3u8);
}

async function packageDisguised() {
  const src = path.join(OUT, 'hls-ts');
  const dst = path.join(OUT, 'hls-ts-disguised');
  await fs.mkdir(dst, {recursive: true});
  const tinyPng = path.join(WORK, 'tiny16.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff3366:s=16x16', '-frames:v', '1', tinyPng]);
  const png = await fs.readFile(tinyPng);
  const names = (await fs.readdir(src)).filter((f) => /^seg\d+\.ts$/.test(f)).sort();
  for (const n of names) {
    const ts = await fs.readFile(path.join(src, n));
    const jpeg = n.replace(/\.ts$/, '.jpeg');
    await fs.writeFile(path.join(dst, jpeg), Buffer.concat([png, ts]));
  }
  for (const pl of ['video.m3u8']) {
    const txt = await fs.readFile(path.join(src, pl), 'utf8');
    await fs.writeFile(path.join(dst, pl), txt.replace(/seg(\d+)\.ts/g, 'seg$1.jpeg'));
  }
  const master = await fs.readFile(path.join(src, 'master.m3u8'), 'utf8');
  await fs.writeFile(path.join(dst, 'master.m3u8'), master);
  return {count: names.length, pngLength: png.length};
}

async function packageFmp4(master) {
  const dir = path.join(OUT, 'hls-fmp4');
  await fs.mkdir(path.join(dir, 'video'), {recursive: true});
  await fs.mkdir(path.join(dir, 'audio'), {recursive: true});
  await ffmpeg(['-i', master, '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'hls',
    '-hls_time', String(SEGMENT), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, '%v', 'seg%03d.m4s'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,agroup:aud,name:video a:0,agroup:aud,name:audio,default:yes',
    path.join(dir, '%v', 'index.m3u8')]);
}

async function packageDash(master) {
  const dir = path.join(OUT, 'dash');
  await fs.mkdir(dir, {recursive: true});
  await ffmpeg(['-i', master, '-map', '0:v', '-map', '0:a', '-c', 'copy', '-f', 'dash',
    '-seg_duration', String(SEGMENT), '-use_template', '1', '-use_timeline', '1',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    path.join(dir, 'manifest.mpd')]);
}

// ---------------------------------------------------------------------------
// Stage 6: verification
// ---------------------------------------------------------------------------
async function verifyDisguised(expectedPngLen) {
  const dir = path.join(OUT, 'hls-ts-disguised');
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpeg')).sort();
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
  let ok = 0;
  const problems = [];
  const stripped = [];
  for (const n of names) {
    const b = await fs.readFile(path.join(dir, n));
    if (!PNG_SIG.every((v, i) => b[i] === v)) {
      problems.push(`${n}: no PNG signature`); continue;
    }
    // PNG length = end of IEND chunk (IEND + 4-byte CRC)
    const iend = b.indexOf(Buffer.from('IEND'));
    const pngLen = iend + 8;
    if (pngLen !== expectedPngLen) {
      problems.push(`${n}: png length ${pngLen} != ${expectedPngLen}`); continue;
    }
    let bad = 0;
    let packets = 0;
    for (let off = pngLen; off < b.length; off += 188) {
      packets++;
      if (b[off] !== 0x47) bad++;
    }
    if ((b.length - pngLen) % 188 !== 0) bad++;
    if (bad) problems.push(`${n}: ${bad} bad TS sync bytes of ${packets}`);
    else ok++;
    stripped.push(b.subarray(pngLen));
  }
  // concatenated stripped TS for ffprobe duration check
  const tsPath = path.join(WORK, 'disguised-stripped.ts');
  await fs.writeFile(tsPath, Buffer.concat(stripped));
  return {total: names.length, ok, problems, tsPath};
}

async function main() {
  const t0 = Date.now();
  for (const d of [OUT, WORK, path.join(OUT, 'mp4')]) await fs.mkdir(d, {recursive: true});
  await fs.rm(path.join(WORK, 'text'), {recursive: true, force: true});
  console.log('[1/6] speech clips (say)');
  const clips = await buildClips();

  console.log('[2/6] music + pink noise bed');
  const music = await buildMusic();
  const musicFrames = music.length / CH;

  const {placed, totalFrames, gapsSec} = buildTimeline(clips, musicFrames);
  const totalSec = totalFrames / SR;
  const noise = await buildNoise(totalSec);

  console.log('[3/6] mix timeline (exact sample placement)');
  const audio = mix(placed, totalFrames, music, noise.subarray(0, totalFrames * CH));
  const audioRaw = path.join(WORK, 'mix.f32');
  await fs.writeFile(audioRaw, Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));

  const groundtruth = {
    duration: Math.round(totalSec * 1000) / 1000,
    utterances: placed.filter((p) => p.kind === 'speech').map((p) => ({
      start: round6(p.start / SR),
      end: round6((p.start + p.len) / SR),
      text: p.clip.text,
      lang: p.clip.lang,
    })),
    music: placed.filter((p) => p.kind === 'music').map((p) => ({
      start: round6(p.start / SR),
      end: round6((p.start + p.len) / SR),
    })),
  };
  await fs.writeFile(path.join(OUT, 'groundtruth.json'), JSON.stringify(groundtruth, null, 2) + '\n');

  console.log('[4/6] video + master encode (H.264 + AAC)');
  const drawtext = await hasDrawtext();
  const files = drawtext ? await writeTextFiles(placed) : null;
  const vf = drawtext ? drawChain(placed, files) : null;
  if (!drawtext) console.log('  drawtext/font unavailable: using testsrc2, no text burn-in');
  const master = await encodeMaster(totalSec.toFixed(6), audioRaw, vf);

  console.log('[5/6] packagings');
  await packageHlsTs(master);
  const disguised = await packageDisguised();
  await packageFmp4(master);
  await packageDash(master);

  console.log('[6/6] verification');
  const rows = [];
  const gt = groundtruth.duration;
  const addRow = async (name, file, entries) => {
    const d = Number(await ffprobeValue(file, entries));
    rows.push({name, dur: d, delta: d - gt, pass: Math.abs(d - gt) <= 0.2});
  };
  await addRow('mp4/video.mp4', master);
  await addRow('hls-ts/video.m3u8', path.join(OUT, 'hls-ts', 'video.m3u8'));
  await addRow('hls-ts/master.m3u8', path.join(OUT, 'hls-ts', 'master.m3u8'));
  await addRow('hls-fmp4/master.m3u8 (video)', path.join(OUT, 'hls-fmp4', 'video', 'index.m3u8'));
  await addRow('hls-fmp4/master.m3u8 (audio)', path.join(OUT, 'hls-fmp4', 'audio', 'index.m3u8'));
  // ffprobe's DASH demuxer under-reports the last segment (203.0 s here), so
  // the MPD itself is checked: sum of the video SegmentTimeline / timescale.
  {
    const mpd = await fs.readFile(path.join(OUT, 'dash', 'manifest.mpd'), 'utf8');
    const tpl = mpd.match(/<AdaptationSet[^>]*contentType="video"[\s\S]*?<SegmentTemplate timescale="(\d+)"[\s\S]*?<\/SegmentTemplate>/);
    if (!tpl) throw new Error('dash: no video SegmentTemplate');
    const timescale = Number(tpl[1]);
    let ticks = 0;
    for (const m of tpl[0].matchAll(/<S ([^>]*)\/>/g)) {
      const attrs = ' ' + m[1];
      const d = Number(attrs.match(/ d="(\d+)"/)[1]);
      const r = Number((attrs.match(/ r="(-?\d+)"/) || [0, 0])[1]);
      ticks += d * (r + 1);
    }
    const d = ticks / timescale;
    rows.push({name: 'dash/manifest.mpd (timeline sum)', dur: d, delta: d - gt, pass: Math.abs(d - gt) <= 0.2});
  }
  const dv = await verifyDisguised(disguised.pngLength);
  await addRow('hls-ts-disguised (stripped TS concat)', dv.tsPath, 'format=duration');

  console.log(`\nGround truth: ${groundtruth.utterances.length} utterances, ${groundtruth.music.length} music sections, duration ${gt}s`);
  console.log(`Text burn-in: ${drawtext ? 'yes' : 'no'}`);
  console.log('\nPackaging                              duration(s)  delta(s)  result');
  for (const r of rows) {
    console.log(`${r.name.padEnd(38)} ${r.dur.toFixed(3).padStart(10)}  ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(3)}`.padEnd(60) + (r.pass ? 'PASS' : 'FAIL'));
  }
  console.log(`\nDisguised TS check: ${dv.ok}/${dv.total} segments OK (PNG prefix ${disguised.pngLength} bytes, 188-byte sync stride)`);
  for (const p of dv.problems) console.log('  ' + p);
  const failed = rows.filter((r) => !r.pass).length + dv.problems.length + (dv.ok !== dv.total ? 1 : 0);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${failed ? `${failed} CHECK(S) FAILED` : 'All checks passed.'}`);
  if (failed) process.exitCode = 1;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
