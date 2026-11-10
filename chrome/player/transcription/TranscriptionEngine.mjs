import {EventEmitter} from '../modules/eventemitter.mjs';
import {Localize} from '../modules/Localize.mjs';
import {SubtitleTrack} from '../SubtitleTrack.mjs';
import {AlertPolyfill} from '../utils/AlertPolyfill.mjs';
import {Utils} from '../utils/Utils.mjs';
import {TARGET_SAMPLE_RATE} from './AudioDecoder.mjs';
import {detectSpeech, findCutPoint} from './AudioChunker.mjs';
import {buildCuesFromAlignedText, buildCuesFromSegments, buildCuesFromText, finalizeCues, isCJK, mergeSeam, snapCuesToSpeech, wrapText} from './CueBuilder.mjs';
import {FragmentAudioSource} from './FragmentAudioSource.mjs';
import {LiveAudioTap} from './LiveAudioTap.mjs';
import {TranscriptCache} from './TranscriptCache.mjs';
import {LANGUAGE_NAME_TO_CODE, ProviderError, TranscriptionProvider} from './TranscriptionProvider.mjs';
import {encodeWav} from './WavEncoder.mjs';

// The chunk at the playhead is kept short so the first subtitle arrives fast;
// chunks further ahead are longer, which gives the model more context.
const FIRST_CHUNK = {minSec: 2, targetSec: 3.5, maxSec: 6};
const NEXT_CHUNK = {minSec: 3, targetSec: 8, maxSec: 15};
// Start this far before the playhead after a seek so the first word isn't cut.
const SEEK_BACKOFF_SEC = 1.0;
const MIN_SPEECH_SEC = 0.3;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
// When the fragment path can't produce audio this many times in a row, fall back to live capture.
const UNAVAILABLE_LIMIT = 3;
// Short grace period for subtitles that come with the page/source before AI ones start.
const AUTO_START_DELAY_MS = 300;
// In live mode cues arrive after their time; keep each one on screen at least this long.
const LIVE_MIN_DISPLAY_SEC = 2.5;
// Longest playback start is held back waiting for the first line (see waitUntilReady).
const START_GATE_MAX_MS = 2500;
// Text-only models get timing from a second, timestamped model (see buildCuesFromAlignedText).
const TIMING_MODEL = 'whisper-1';
// For the chunk at the playhead, don't hold the line back more than this waiting for timing.
const URGENT_TIMING_WAIT_MS = 150;

const CODE_TO_LANGUAGE_NAME = Object.fromEntries(
    Object.entries(LANGUAGE_NAME_TO_CODE).map(([name, code]) => [code, name[0].toUpperCase() + name.slice(1)]),
);

function hashString(str) {
  // FNV-1a, enough to key a local cache.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Generates subtitles with a speech-to-text API, ahead of the playhead when the
 * audio is already downloaded, or live from the audio graph otherwise.
 */
export class TranscriptionEngine extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.settings = {};
    this.cache = new TranscriptCache();
    this.enabled = false;
    this.resumeOnNextSource = false;
    this.client.on('tick', () => this.schedulePump());
    this.resetState();
  }

  resetState() {
    this.spans = [];
    this.inFlight = 0;
    this.track = null;
    this.source = null;
    this.liveTap = null;
    this.mode = null;
    this.unavailableCount = 0;
    this.failures = new Map();
    this.sourceLines = [];
    this.pumpTimer = null;
    this.pumping = false;
    this.pumpAgain = false;
    this.status = 'idle';
    this.errorShown = false;
  }

  get subtitlesManager() {
    return this.client.interfaceController.subtitlesManager;
  }

  setSettings(settings) {
    const changed = JSON.stringify(settings || {}) !== JSON.stringify(this.settings);
    this.settings = {...(settings || {})};
    if (changed && this.enabled) {
      // Provider/model/language changes invalidate what's in flight.
      this.stop();
      this.start();
    }
  }

  isEnabled() {
    return this.enabled;
  }

  toggle() {
    if (this.enabled) {
      this.stop();
    } else {
      this.start();
    }
  }

  emitState(status, message) {
    this.status = status;
    this.emit('state', {enabled: this.enabled, status, message});
  }

  get lookahead() {
    const value = this.settings.lookaheadSeconds || 120;
    return Math.min(value, this.client.state?.bufferAhead || value);
  }

  get concurrency() {
    return Math.max(1, Math.min(6, this.settings.concurrency || 3));
  }

  get settingsKey() {
    const s = this.settings;
    return [s.provider || 'openai', s.model || '', s.language || '', s.translateTo || ''].join('|');
  }

  get mediaKey() {
    const url = this.client.source?.url || '';
    let base = url;
    try {
      const u = new URL(url);
      base = u.origin + u.pathname;
    } catch (e) {
      // Not a URL (e.g. a local file); use it as is.
    }
    return hashString(base + '|' + Math.round(this.client.duration || 0));
  }

  async start() {
    if (this.enabled || this.starting || !this.client.player) return;
    this.starting = true;
    try {
      await this.startInner();
    } finally {
      this.starting = false;
    }
  }

  async startInner() {
    const apiKey = (await Utils.getConfig('aiSubtitlesApiKey')) || '';
    if (!apiKey && (this.settings.provider || 'openai') !== 'custom') {
      this.emitState('error', Localize.getMessage('player_aisubs_nokey'));
      return;
    }
    this.provider = TranscriptionProvider.fromSettings(this.settings, apiKey);
    this.timingProvider = null;
    if (!this.provider.supportsTimestamps && this.settings.preciseTiming !== false && (this.settings.provider || 'openai') === 'openai') {
      this.timingProvider = TranscriptionProvider.fromSettings({...this.settings, model: TIMING_MODEL}, apiKey);
    }
    this.enabled = true;
    this.errorShown = false;
    this.ensureTrack();
    this.emitState('working');

    await this.loadCache();
    if (FragmentAudioSource.isSupported(this.client)) {
      this.mode = 'fragments';
      this.source = new FragmentAudioSource(this.client);
    } else {
      await this.startLive();
    }
    this.schedulePump();
  }

  stop() {
    this.enabled = false;
    for (const span of this.spans) {
      if (span.state === 'pending') {
        span.cancelled = true;
        span.controller?.abort();
      }
    }
    // Keep finished spans so re-enabling doesn't redo (or re-bill) them.
    this.spans = this.spans.filter((s) => s.state === 'done');
    if (this.liveTap) {
      this.liveTap.stop();
      this.liveTap = null;
    }
    clearTimeout(this.pumpTimer);
    this.emitState('idle');
  }

  /** Called before the player switches to a new source. */
  reset() {
    this.resumeOnNextSource = this.enabled;
    this.stop();
    clearTimeout(this.autoStartTimer);
    this.source?.destroy();
    this.resetState();
  }

  /** Called once a new source is playing-ready. */
  onSourceReady() {
    clearTimeout(this.autoStartTimer);
    this.autoStartPending = false;
    if (this.resumeOnNextSource) {
      this.resumeOnNextSource = false;
      this.start();
      return;
    }
    if (this.settings.autoGenerate) {
      // Give page-provided and auto-loaded subtitles a moment to show up first.
      this.autoStartPending = true;
      this.autoStartTimer = setTimeout(() => {
        this.autoStartPending = false;
        if (!this.enabled && this.subtitlesManager.tracks.length === 0) {
          this.start();
        }
      }, AUTO_START_DELAY_MS);
    }
  }

  /**
   * Resolves when the audio around `time` has been transcribed, or after
   * START_GATE_MAX_MS. Awaited by play() so playback starts with its first
   * line already on screen instead of about a second late.
   * @param {number} time
   * @return {Promise<void>}
   */
  waitUntilReady(time) {
    if (this.settings.waitForFirstLine === false) return Promise.resolve();
    const deadline = Date.now() + START_GATE_MAX_MS;
    const ready = () => {
      if (this.autoStartPending || this.starting) return false;
      if (!this.enabled || this.mode !== 'fragments') return true;
      // The span holding the playhead, and the one right after it (the first line may start a bit later).
      const here = this.findSpanAt(time);
      if (!here || here.state === 'pending') return false;
      const next = this.findSpanAt(here.end + 0.01);
      return !next ? here.end >= Math.min(time + 2, this.client.duration - 0.1) : next.state !== 'pending' || next.start > time + 2;
    };
    return new Promise((resolve) => {
      const check = () => {
        if (ready() || Date.now() >= deadline) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  onFragmentUpdate() {
    if (this.mode === 'fragments') this.schedulePump(50);
  }

  onSeek() {
    if (!this.enabled) return;
    const now = this.client.currentTime;
    const horizon = now + this.lookahead;
    // Work far from the new position is wasted; free the slots for the playhead.
    this.spans = this.spans.filter((span) => {
      if (span.state === 'pending' && (span.end < now - 2 || span.start > horizon)) {
        span.cancelled = true;
        span.controller?.abort();
        return false;
      }
      return true;
    });
    this.liveTap?.flush(false);
    this.schedulePump(0);
  }

  ensureTrack() {
    if (this.track && this.subtitlesManager.tracks.includes(this.track)) {
      this.subtitlesManager.activateTrack(this.track);
      return;
    }
    let label = Localize.getMessage('player_aisubs_tracklabel');
    if (this.settings.translateTo) label += ` (${this.settings.translateTo})`;
    const track = new SubtitleTrack(label, this.settings.translateTo || this.settings.language || null);
    track.kind = 'ai';
    track.isLive = true;
    this.track = this.subtitlesManager.addTrack(track);
    this.subtitlesManager.activateTrack(this.track);
  }

  async loadCache() {
    const chunks = await this.cache.getChunks(this.mediaKey, this.settingsKey);
    if (!chunks?.length) return;
    const cues = [];
    for (const chunk of chunks) {
      if (this.findSpanAt(chunk.start + 0.01)) continue;
      this.insertSpan({start: chunk.start, end: chunk.end, state: 'done', text: chunk.text || ''});
      for (const c of chunk.cues || []) cues.push(SubtitleTrack.makeCue(c.start, c.end, c.text));
    }
    if (cues.length) {
      this.track.appendCues(cues);
      this.subtitlesManager.refreshTrack(this.track);
    }
  }

  async startLive() {
    this.mode = 'live';
    this.liveTap = new LiveAudioTap(this.client, (chunk) => this.onLiveChunk(chunk));
    try {
      await this.liveTap.start();
      AlertPolyfill.toast('info', Localize.getMessage('player_aisubs_livecapture'));
    } catch (e) {
      console.error('[AI subtitles] live capture failed', e);
      this.fail(e.message);
    }
  }

  onLiveChunk(chunk) {
    if (!this.enabled) return;
    const span = {start: chunk.start, end: chunk.end, audioStart: chunk.start, rate: chunk.rate, state: 'pending', pcm: chunk.pcm};
    this.insertSpan(span);
    this.dispatch(span);
  }

  // ---- span bookkeeping (covered = done or in flight) ----

  insertSpan(span) {
    const i = this.spans.findIndex((s) => s.start > span.start);
    if (i === -1) this.spans.push(span);
    else this.spans.splice(i, 0, span);
  }

  removeSpan(span) {
    const i = this.spans.indexOf(span);
    if (i !== -1) this.spans.splice(i, 1);
  }

  findSpanAt(t) {
    return this.spans.find((s) => s.start <= t && t < s.end) || null;
  }

  firstUncovered(t) {
    let span = this.findSpanAt(t);
    while (span) {
      t = span.end;
      span = this.findSpanAt(t);
    }
    return t;
  }

  nextSpanStart(t) {
    let next = Infinity;
    for (const s of this.spans) {
      if (s.start > t && s.start < next) next = s.start;
    }
    return next;
  }

  // ---- scheduling ----

  schedulePump(delay = 100) {
    if (!this.enabled || this.mode !== 'fragments') return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.pump(), delay);
  }

  async pump() {
    if (!this.enabled || this.mode !== 'fragments') return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (this.enabled && this.inFlight < this.concurrency) {
          const span = await this.planNext();
          if (!span) break;
          this.dispatch(span);
        }
      } while (this.pumpAgain && this.enabled);
    } catch (e) {
      console.error('[AI subtitles] planning failed', e);
    } finally {
      this.pumping = false;
    }
    this.updateStatus();
  }

  async planNext() {
    const duration = this.client.duration;
    if (!duration || !isFinite(duration)) return null;
    const now = this.client.currentTime;
    const horizon = Math.min(duration, now + this.lookahead);

    const t = this.firstUncovered(Math.max(0, now - SEEK_BACKOFF_SEC));
    if (t >= horizon - 0.05) return null;

    const policy = t <= now + 1 ? FIRST_CHUNK : NEXT_CHUNK;
    const nextStart = this.nextSpanStart(t);
    const readEnd = Math.min(duration, t + policy.maxSec + 0.5, nextStart);
    const result = await this.source.read(t, readEnd);
    if (!this.enabled) return null;

    if (result.status === 'unavailable') {
      if (++this.unavailableCount >= UNAVAILABLE_LIMIT) {
        console.warn('[AI subtitles] fragment audio unavailable, switching to live capture');
        this.source = null;
        await this.startLive();
      }
      return null;
    }
    if (result.status !== 'ok') return null; // still downloading; FRAGMENT_UPDATE will wake us
    this.unavailableCount = 0;

    const available = result.end - result.start;
    const isFinal = readEnd >= duration - 0.05 || readEnd === nextStart;
    let cut = available;
    if (!(isFinal && available <= policy.maxSec)) {
      cut = findCutPoint(result.pcm, TARGET_SAMPLE_RATE, {...policy, isFinal});
    }
    cut = Math.max(0.05, Math.min(cut, available));

    // Coverage starts at t even if decoded audio starts a hair later, so no gap is re-planned forever.
    const span = {
      start: t,
      end: result.start + cut,
      audioStart: result.start,
      state: 'pending',
      pcm: result.pcm.subarray(0, Math.round(cut * TARGET_SAMPLE_RATE)),
    };
    const key = span.start.toFixed(1);
    if ((this.failures.get(key) || 0) >= MAX_ATTEMPTS) {
      span.state = 'failed';
      span.pcm = null;
    }
    this.insertSpan(span);
    return span.state === 'pending' ? span : this.planNext();
  }

  dispatch(span) {
    this.inFlight++;
    this.updateStatus();
    this.process(span).finally(() => {
      this.inFlight--;
      this.updateStatus();
      this.schedulePump(0);
    });
  }

  updateStatus() {
    if (!this.enabled) return;
    const status = this.inFlight > 0 ? 'working' : 'idle';
    if (status !== this.status) this.emitState(status);
  }

  promptFor(start) {
    // Previous chunk's text keeps names and spelling consistent across chunks.
    const prev = this.spans.find((s) => s.state === 'done' && Math.abs(s.end - start) < 0.1 && s.text);
    return prev ? prev.text : '';
  }

  async process(span) {
    const pcm = span.pcm;
    span.pcm = null;
    const pcmDuration = pcm.length / TARGET_SAMPLE_RATE;
    const regions = detectSpeech(pcm, TARGET_SAMPLE_RATE);
    const speech = regions.reduce((sum, r) => sum + r.end - r.start, 0);
    if (speech < MIN_SPEECH_SEC) {
      span.state = 'done';
      span.text = '';
      this.saveSpan(span, []);
      return;
    }

    const controller = new AbortController();
    span.controller = controller;
    try {
      const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
      const language = this.settings.language || '';
      const timingPromise = this.timingProvider ?
        this.timingProvider.transcribe(wav, {language, signal: controller.signal}).catch((e) => {
          if (e.name !== 'AbortError') console.warn('[AI subtitles] timing request failed', e);
          return null;
        }) :
        Promise.resolve(null);
      const result = await this.provider.transcribe(wav, {
        language,
        prompt: this.promptFor(span.start),
        signal: controller.signal,
      });
      if (span.cancelled || !this.enabled) return;

      const rate = span.rate || 1;
      const speechRegions = regions.map((r) => ({start: span.audioStart + r.start * rate, end: span.audioStart + r.end * rate}));
      // Model timing says which words go together; energy says exactly when speech starts and stops.
      const shape = (raw) => finalizeCues(snapCuesToSpeech([...raw].sort((a, b) => a.start - b.start), speechRegions));
      const alignTo = (timing) => {
        if (!timing?.segments?.length) return null;
        const aligned = buildCuesFromAlignedText(result.text, scaleSegments(timing.segments, rate), span.audioStart);
        return aligned ? shape(aligned) : null;
      };

      let cues = null;
      let lateTiming = null;
      if (result.segments && result.segments.length) {
        cues = shape(buildCuesFromSegments(scaleSegments(result.segments, rate), span.audioStart));
      } else if (this.timingProvider && result.text) {
        // Far-ahead chunks wait for precise timing. The one at the playhead is shown
        // right away with estimated timing and re-timed when whisper answers.
        const urgent = span.start <= this.client.currentTime + 2;
        const timing = urgent ?
          await Promise.race([timingPromise, new Promise((resolve) => setTimeout(() => resolve('late'), URGENT_TIMING_WAIT_MS))]) :
          await timingPromise;
        if (span.cancelled || !this.enabled) return;
        if (timing === 'late') lateTiming = timingPromise;
        else cues = alignTo(timing);
      }
      if (!cues) {
        cues = shape(buildCuesFromText(result.text || '', scaleRegions(regions, rate), span.audioStart, pcmDuration * rate));
      }
      span.text = result.text || '';

      if (this.settings.translateTo && cues.length) {
        cues = await this.translateCues(cues, result.language, controller.signal);
        if (span.cancelled || !this.enabled) return;
        lateTiming = null; // translated lines no longer map 1:1 onto the transcript
      }

      span.state = 'done';
      this.commit(span, cues);
      lateTiming?.then((timing) => {
        const retimed = alignTo(timing);
        if (retimed && !span.cancelled && this.enabled) this.replaceSpanCues(span, retimed);
      });
    } catch (e) {
      if (span.cancelled || e.name === 'AbortError') {
        this.removeSpan(span);
        return;
      }
      console.error('[AI subtitles] chunk failed', span.start, e);
      if (e instanceof ProviderError && [400, 401, 403, 404].includes(e.status)) {
        this.fail(e.message);
        return;
      }
      const key = span.start.toFixed(1);
      this.failures.set(key, (this.failures.get(key) || 0) + 1);
      if (!this.errorShown) {
        this.errorShown = true;
        this.emitState('error', Localize.getMessage('player_aisubs_error') + ': ' + e.message);
      }
      // Free the region so it gets planned (and decoded) again.
      setTimeout(() => {
        this.removeSpan(span);
        this.schedulePump(0);
      }, RETRY_DELAY_MS);
    }
  }

  async translateCues(cues, language, signal) {
    // Already in the target language (e.g. an English line in a Japanese video): translating would only paraphrase it.
    if (language && CODE_TO_LANGUAGE_NAME[language]?.toLowerCase() === String(this.settings.translateTo).toLowerCase()) {
      return cues;
    }
    const lines = cues.map((c) => (isCJK(c.text) ? c.text.replace(/\n/g, '') : c.text.replace(/\n/g, ' ')));
    try {
      const translated = await this.provider.translate(lines, {
        targetLanguage: this.settings.translateTo,
        sourceLanguage: CODE_TO_LANGUAGE_NAME[language] || '',
        context: this.sourceLines.slice(-4),
        signal,
      });
      this.sourceLines.push(...lines);
      if (this.sourceLines.length > 20) this.sourceLines.splice(0, this.sourceLines.length - 20);
      return cues.map((c, i) => ({...c, text: wrapText(translated[i] || lines[i])}));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // Untranslated subtitles beat no subtitles.
      console.warn('[AI subtitles] translation failed, showing original', e);
      return cues;
    }
  }

  commit(span, cues) {
    const track = this.track;
    if (!track) return;
    const nearby = track.cues
        .filter((c) => c.endTime > span.start - 1 && c.startTime < span.end + 1)
        .map((c) => ({start: c.startTime, end: c.endTime, text: c.text}));
    cues = mergeSeam(nearby, cues);

    if (this.mode === 'live') {
      const now = this.client.currentTime;
      cues = cues.map((c) => (c.end < now + LIVE_MIN_DISPLAY_SEC ?
        {...c, start: Math.max(c.start, now), end: Math.max(c.end, now + Math.min(LIVE_MIN_DISPLAY_SEC, c.end - c.start + 1))} :
        c));
    }

    span.cueObjects = cues.map((c) => SubtitleTrack.makeCue(c.start, c.end, c.text));
    if (span.cueObjects.length) {
      track.appendCues(span.cueObjects);
      this.subtitlesManager.refreshTrack(track);
    }
    this.saveSpan(span, cues);
  }

  /** Swaps a span's cues for better-timed ones (e.g. when whisper timing arrives late). */
  replaceSpanCues(span, cues) {
    const track = this.track;
    if (!track) return;
    const old = new Set(span.cueObjects || []);
    track.cues = track.cues.filter((c) => !old.has(c));
    this.commit(span, cues);
  }

  saveSpan(span, cues) {
    if (this.mode !== 'fragments') return;
    this.cache.putChunk(this.mediaKey, this.settingsKey, {
      start: span.start,
      end: span.end,
      cues,
      text: span.text || '',
      savedAt: Date.now(),
    });
  }

  fail(message) {
    this.stop();
    this.emitState('error', Localize.getMessage('player_aisubs_error') + ': ' + message);
  }
}

// Live capture at playbackRate r compresses media time; stretch results back onto the media timeline.
function scaleSegments(segments, rate) {
  if (rate === 1) return segments;
  return segments.map((s) => ({
    ...s,
    start: s.start * rate,
    end: s.end * rate,
    words: (s.words || []).map((w) => ({...w, start: w.start * rate, end: w.end * rate})),
  }));
}

function scaleRegions(regions, rate) {
  if (rate === 1) return regions;
  return regions.map((r) => ({start: r.start * rate, end: r.end * rate}));
}
