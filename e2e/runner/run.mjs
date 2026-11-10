// End-to-end test: loads the unpacked extension in Chromium, plays a fixture
// stream at 1x, and measures AI subtitle readiness, timing and accuracy against
// e2e/fixtures/out/groundtruth.json.
//
// Usage: node run.mjs [--variant hls-ts-disguised] [--seconds 200] [--seek 120@60]
//        [--translate English] [--model gpt-transcribe] [--headed]
// The OpenAI key is read from ~/.config/subtitle-extension/openai_key (never from the repo).
import {chromium} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const extensionPath = path.join(root, 'chrome');
const groundTruth = JSON.parse(fs.readFileSync(path.join(root, 'e2e/fixtures/out/groundtruth.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const variant = args.page ? `page-${args.page}` : (args.variant || 'hls-ts-disguised');
const playSeconds = Number(args.seconds || groundTruth.duration);
const port = Number(args.port || 8765);
const manifests = {
  'hls-ts-disguised': 'fixtures/out/hls-ts-disguised/master.m3u8',
  'hls-ts': 'fixtures/out/hls-ts/master.m3u8',
  'hls-fmp4': 'fixtures/out/hls-fmp4/master.m3u8',
  'dash': 'fixtures/out/dash/manifest.mpd',
  'mp4': 'fixtures/out/mp4/video.mp4',
};
const streamUrl = `http://localhost:${port}/${manifests[variant]}`;
const apiKey = fs.readFileSync(path.join(os.homedir(), '.config/subtitle-extension/openai_key'), 'utf8').trim();

function normalize(t) {
  // Katakana -> hiragana: writing ほっと as ホッと is a spelling choice, not a recognition error.
  return String(t).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
      .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function levenshtein(a, b) {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function errorRate(ref, hyp, lang) {
  // Japanese has no word boundaries: character error rate. English: word error rate.
  if (lang === 'ja') {
    const r = Array.from(normalize(ref));
    const h = Array.from(normalize(hyp));
    return r.length ? levenshtein(r, h) / r.length : 0;
  }
  const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const r = words(ref);
  const h = words(hyp);
  return r.length ? levenshtein(r, h) / r.length : 0;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, 'e2e/server.mjs'), '--port', String(port)], {
    env: {...process.env, LATENCY_MS: args.latency || '60', THROTTLE_KBPS: args.throttle || '0'},
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((r) => setTimeout(r, 600));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !args.headed,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
    viewport: {width: 1280, height: 720},
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    // Configure options + key through extension storage, exactly as the options page would.
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/player/options/index.html`);
    await setup.evaluate(async ({apiKey, model, translateTo, autoEnable}) => {
      const stored = await chrome.storage.local.get('options');
      const options = stored.options ? JSON.parse(stored.options) : {};
      options.aiSubtitles = {
        ...(options.aiSubtitles || {}),
        autoGenerate: true,
        provider: 'openai',
        model,
        translateTo,
        lookaheadSeconds: 120,
        concurrency: 3,
      };
      if (autoEnable) options.autoEnableURLs = [autoEnable];
      await chrome.storage.local.set({options: JSON.stringify(options), aiSubtitlesApiKey: apiKey});
      await chrome.runtime.sendMessage({type: 'LOAD_OPTIONS', time: Date.now()});
    }, {apiKey, model: args.model || '', translateTo: args.translate || '', autoEnable: args.page ? `http://localhost:${port}/site/` : ''});
    await setup.close();

    const page = await context.newPage();
    const consoleLines = [];
    page.on('console', (m) => {
      const text = m.text();
      if (/AI subtitles|error|Error/.test(text)) consoleLines.push(`[${m.type()}] ${text}`);
    });
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

    // target: the frame that runs the FastStream player (the page itself, or the iframe it injects into a site)
    let target = page;
    if (args.page) {
      await page.goto(`http://localhost:${port}/site/${args.page}.html`);
      const deadline = Date.now() + 30000;
      while (!(target = page.frames().find((f) => f.url().startsWith(`chrome-extension://${extensionId}/player/index.html`)))) {
        if (Date.now() > deadline) throw new Error('FastStream did not replace the video on the page');
        await new Promise((r) => setTimeout(r, 200));
      }
      console.log('player frame:', target.url().slice(0, 120));
    } else {
      await page.goto(`chrome-extension://${extensionId}/player/index.html#${streamUrl}`);
    }
    await target.waitForFunction(() => window.fastStream && window.fastStream.duration > 0, null, {timeout: 30000});
    const playCalled = Date.now();
    await target.evaluate(() => window.fastStream.play());
    const playWall = Date.now();
    const startGateMs = playWall - playCalled;

    // Track when each cue first appears, and at what playback time.
    const seen = new Map();
    let finalCues = [];
    const shownSamples = [];
    let seekDone = false;
    const [seekTo, seekAt] = String(args.seek || '').split('@').map(Number);

    while (true) {
      const snap = await target.evaluate(() => {
        const fs = window.fastStream;
        const engine = fs.transcriptionEngine;
        const track = engine?.track;
        const container = document.querySelector('.mainplayer .fluid_subtitles_container');
        return {
          t: fs.currentTime,
          paused: fs.player?.getVideo()?.paused,
          enabled: engine?.enabled,
          mode: engine?.mode,
          inFlight: engine?.inFlight,
          cues: (track?.cues || []).map((c) => ({s: c.startTime, e: c.endTime, x: c.text})),
          shown: container && container.style.display !== 'none' ? container.innerText.replace(/\|/g, '').trim() : '',
        };
      });
      const wall = (Date.now() - playWall) / 1000;
      // Arrival = first time a line with this text appeared (re-timing replaces cues but keeps the text).
      for (const c of snap.cues) {
        if (!seen.has(c.x)) seen.set(c.x, {arrivedAtMedia: snap.t, arrivedAtWall: wall});
      }
      finalCues = snap.cues;
      shownSamples.push({t: snap.t, shown: snap.shown});

      if (seekTo && !seekDone && snap.t >= seekAt) {
        seekDone = true;
        await target.evaluate((to) => {
          window.fastStream.currentTime = to;
        }, seekTo);
        console.log(`seeked ${snap.t.toFixed(1)} -> ${seekTo}`);
      }
      if (snap.t >= Math.min(playSeconds, groundTruth.duration - 0.3) || wall > playSeconds + 60) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await page.screenshot({path: path.join(here, `screenshot-${variant}.png`)});
    report(finalCues.map((c) => ({...c, ...seen.get(c.x)})), shownSamples, consoleLines, {seekTo, seekAt, startGateMs});
  } finally {
    await context.close();
    server.kill();
    fs.rmSync(userDataDir, {recursive: true, force: true});
  }
}

function report(cues, shownSamples, consoleLines, {seekTo, seekAt, startGateMs}) {
  const maxT = Math.max(...shownSamples.map((s) => s.t));
  const watched = (u) => {
    if (!seekTo) return u.end <= maxT;
    return u.end <= seekAt || (u.start >= seekTo && u.end <= maxT);
  };
  const rows = [];
  for (const u of groundTruth.utterances.filter(watched)) {
    const overlapping = cues.filter((c) => c.e > u.start + 0.05 && c.s < u.end - 0.05).sort((a, b) => a.s - b.s);
    const text = overlapping.map((c) => c.x.replace(/\n/g, u.lang === 'ja' ? '' : ' ')).join(u.lang === 'ja' ? '' : ' ');
    const firstArrival = overlapping.length ? Math.min(...overlapping.map((c) => c.arrivedAtMedia)) : NaN;
    // lead > 0: the subtitle existed before the speech started (the "real-time illusion").
    const lead = u.start - firstArrival;
    const startErr = overlapping.length ? Math.min(...overlapping.map((c) => c.s)) - u.start : NaN;
    // What was actually on screen in the middle of the utterance.
    const during = shownSamples.filter((s) => s.t >= u.start + 0.2 && s.t <= u.end - 0.2);
    const coverage = during.length ? during.filter((s) => s.shown).length / during.length : 0;
    rows.push({u, text, err: errorRate(u.text, text, u.lang), lead, startErr, onScreen: coverage});
  }

  const music = groundTruth.music || [];
  const musicCues = cues.filter((c) => music.some((m) => c.s >= m.start + 0.3 && c.e <= m.end - 0.3));

  console.log('\nutterance results (lead = seconds the cue was ready before the speech started):');
  for (const r of rows) {
    console.log(`${r.u.start.toFixed(1).padStart(6)}s ${r.u.lang} err=${(r.err * 100).toFixed(0).padStart(3)}% ` +
      `lead=${Number.isNaN(r.lead) ? '  n/a' : r.lead.toFixed(1).padStart(5)}s startErr=${Number.isNaN(r.startErr) ? ' n/a' : r.startErr.toFixed(2)}s ` +
      `onScreen=${(r.onScreen * 100).toFixed(0).padStart(3)}% | ${r.text.slice(0, 60)}`);
  }
  const ja = rows.filter((r) => r.u.lang === 'ja');
  const en = rows.filter((r) => r.u.lang === 'en');
  const summary = {
    variant,
    startGateMs,
    utterances: rows.length,
    covered: rows.filter((r) => r.text).length,
    readyBeforeSpeech: rows.filter((r) => r.lead >= 0).length,
    medianLeadSec: Number(median(rows.map((r) => r.lead).filter((x) => !Number.isNaN(x))).toFixed(2)),
    worstLeadSec: Number(Math.min(...rows.map((r) => (Number.isNaN(r.lead) ? -99 : r.lead))).toFixed(2)),
    meanOnScreenCoverage: Number((rows.reduce((a, r) => a + r.onScreen, 0) / (rows.length || 1)).toFixed(3)),
    jaCER: Number((ja.reduce((a, r) => a + r.err, 0) / (ja.length || 1)).toFixed(3)),
    enWER: Number((en.reduce((a, r) => a + r.err, 0) / (en.length || 1)).toFixed(3)),
    medianAbsStartErrSec: Number(median(rows.map((r) => Math.abs(r.startErr)).filter((x) => !Number.isNaN(x))).toFixed(2)),
    cuesInsideMusicOnly: musicCues.length,
    duplicateCuesInTrack: cues.filter((c, i) => cues.some((d, j) => j < i && d.x === c.x && d.e > c.s && d.s < c.e)).length,
    totalCues: cues.length,
  };
  console.log('\nsummary', JSON.stringify(summary, null, 2));
  if (musicCues.length) console.log('music cues:', musicCues.map((c) => c.x));
  if (consoleLines.length) console.log('\nconsole:\n' + consoleLines.slice(0, 40).join('\n'));
  fs.writeFileSync(path.join(here, `result-${variant}.json`), JSON.stringify({summary, rows, cues}, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
