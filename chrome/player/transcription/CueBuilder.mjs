/**
 * Turns speech-to-text output into display-ready subtitle cues.
 * Pure functions: no DOM, no I/O. All times are seconds; lengths are characters
 * (code points for wrapping, UTF-16 units for normalized comparisons).
 */

/** Default limits and thresholds used by every function in this module. */
export const CueDefaults = {
  maxCharsPerLine: 42,
  maxCharsPerLineCJK: 16,
  maxLines: 2,
  minDuration: 0.8,
  maxDuration: 7,
  maxCps: 20,
  maxCpsCJK: 8,
  minGap: 0.08,
  wordGapSplit: 0.6,
  noSpeechProb: 0.6,
  logprobThreshold: -1.0,
  compressionRatioThreshold: 2.4,
  snapTolerance: 0.3,
};

const SENTENCE_END_CJK = '。！？';
const SENTENCE_END_ASCII = '.!?';
const CLAUSE_MARKS_ALWAYS = '、，；：';
const CLAUSE_MARKS_ASCII = ',;:';
// Characters that must not start a line: closing punctuation, long vowel mark, small kana.
const NO_LINE_START = '。、！？ー・…」』）)ゃゅょっぁぃぅぇぉ.,!?;:';
// Characters after which a line break reads naturally.
const SOFT_BREAK_AFTER = '。、！？，.,!?;:；：';
// Characters after which a line break is avoided (opening brackets).
const NO_BREAK_AFTER = '「『（(';
// Spec value: a cue that already spans this long may end at a sentence end.
const MIN_SENTENCE_CUE_SECONDS = 1.2;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_RE = /\p{Script=Han}/u;
const HIRAGANA_RE = /\p{Script=Hiragana}/u;
const KATAKANA_RE = /\p{Script=Katakana}/u;
// Everything is stripped except letters, digits, marks and the long vowel mark (Lm, not P).
const STRIP_RE = /[\s\p{P}\p{S}]+/gu;

/** Known speech-to-text hallucinations (compared after normalizeText). */
export const HALLUCINATION_PHRASES = [
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'please subscribe',
  'please like and subscribe',
  'subscribe to my channel',
  'subtitles by the amara.org community',
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  '最後までご視聴いただきありがとうございました',
  'チャンネル登録よろしくお願いします',
  'チャンネル登録お願いします',
  '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目',
  'MBC 뉴스 이덕영입니다',
  'sous-titres réalisés para la communauté d\'amara.org',
  'sous-titres réalisés par la communauté d\'amara.org',
];

/**
 * Lowercases, applies NFKC and removes whitespace, punctuation and symbols.
 * Keeps the long vowel mark (U+30FC) because it carries meaning in Japanese.
 * @param {string} t
 * @return {string}
 */
export function normalizeText(t) {
  return String(t ?? '').normalize('NFKC').toLowerCase().replace(STRIP_RE, '');
}

const BLACKLIST_KEYS = HALLUCINATION_PHRASES.map((p) => normalizeText(p));
// Substring markers, already normalized (so 'amara.org' becomes 'amaraorg').
const SUBSTRING_MARKERS = ['amara.org', '字幕by', 'subtitlesby'].map((m) => normalizeText(m));

/**
 * True when more than 30% of the non-space characters are Han, Hiragana,
 * Katakana or Hangul.
 * @param {string} text
 * @return {boolean}
 */
export function isCJK(text) {
  const chars = Array.from(String(text ?? '')).filter((c) => !/\s/.test(c));
  if (chars.length === 0) return false;
  const cjk = chars.filter((c) => CJK_RE.test(c)).length;
  return cjk / chars.length > 0.3;
}

/**
 * Detects a loop where one unit repeats at least 6 times in a row and covers
 * more than 60% of the text. CJK: unit is 1-6 characters. Otherwise: a word.
 * @param {string} raw original text
 * @param {string} normalized normalizeText(raw)
 * @return {boolean}
 */
function hasRepetitionLoop(raw, normalized) {
  if (isCJK(raw)) {
    const chars = Array.from(normalized);
    for (let size = 1; size <= 6; size++) {
      for (let i = 0; i + size * 6 <= chars.length; i++) {
        const unit = chars.slice(i, i + size).join('');
        let reps = 1;
        while (chars.slice(i + reps * size, i + (reps + 1) * size).join('') === unit) reps++;
        if (reps >= 6 && reps * size > 0.6 * chars.length) return true;
      }
    }
    return false;
  }
  const tokens = String(raw).normalize('NFKC').toLowerCase().split(/\s+/)
      .map((w) => normalizeText(w)).filter(Boolean);
  let run = 0;
  for (let i = 0; i < tokens.length; i++) {
    run = i > 0 && tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run >= 6 && run > 0.6 * tokens.length) return true;
  }
  return false;
}

/**
 * True for empty text, blacklisted phrases (or repeats of them), marker
 * substrings, and repetition loops.
 * @param {string} text
 * @return {boolean}
 */
export function isHallucination(text) {
  const raw = String(text ?? '');
  const n = normalizeText(raw);
  if (n === '') return true;
  for (const key of BLACKLIST_KEYS) {
    if (n.length % key.length === 0 && n === key.repeat(n.length / key.length)) return true;
  }
  if (SUBSTRING_MARKERS.some((m) => n.includes(m))) return true;
  return hasRepetitionLoop(raw, n);
}

/** Text of a segment: its text field, or its words joined when text is missing. */
function segmentText(seg) {
  if (typeof seg.text === 'string' && seg.text.trim() !== '') return seg.text;
  return (Array.isArray(seg.words) ? seg.words : []).map((w) => w?.word ?? '').join('');
}

/** Merges caller options over the defaults. */
function resolve(opts) {
  return {...CueDefaults, ...opts};
}

/** Collapses every run of whitespace into one space. */
function normalizeSpaces(text) {
  return String(text ?? '').replace(/\s+/g, ' ');
}

/** Characters per line for this text (CJK or Latin limit). */
function lineLimit(text, o) {
  return isCJK(text) ? o.maxCharsPerLineCJK : o.maxCharsPerLine;
}

/**
 * Drops segments that look like silence, compressed repetition, or hallucination.
 * A missing field never triggers its rule.
 * @param {Array<object>} segments
 * @param {object} [opts]
 * @return {Array<object>}
 */
export function filterSegments(segments, opts) {
  const o = resolve(opts);
  return (segments ?? []).filter((seg) => {
    if (!seg) return false;
    if (seg.no_speech_prob > o.noSpeechProb && seg.avg_logprob < o.logprobThreshold) return false;
    if (seg.compression_ratio > o.compressionRatioThreshold) return false;
    return !isHallucination(segmentText(seg));
  });
}

/** True when the character at index i ends a sentence. */
function isSentenceEnd(chars, i) {
  const c = chars[i];
  if (SENTENCE_END_CJK.includes(c)) return true;
  if (!SENTENCE_END_ASCII.includes(c)) return false;
  return i + 1 >= chars.length || /\s/.test(chars[i + 1]);
}

/** True when the character at index i is a clause mark (comma, colon, etc.). */
function isClauseMark(chars, i) {
  const c = chars[i];
  if (CLAUSE_MARKS_ALWAYS.includes(c)) return true;
  return CLAUSE_MARKS_ASCII.includes(c) && (i + 1 >= chars.length || /\s/.test(chars[i + 1]));
}

/**
 * Finds where to cut so the first part fits in maxLen. Tries sentence ends,
 * then clause marks, then spaces, then a hard cut. Returns the cut index.
 * @param {string[]} chars characters of the text (length > maxLen)
 * @param {number} maxLen
 * @return {number}
 */
function bestCut(chars, maxLen) {
  const last = Math.min(maxLen, chars.length - 1);
  const tiers = [
    (p) => isSentenceEnd(chars, p - 1),
    (p) => isClauseMark(chars, p - 1),
    (p) => /\s/.test(chars[p]),
  ];
  for (const isCut of tiers) {
    for (let p = last; p >= 1; p--) {
      if (isCut(p)) return p;
    }
  }
  let cut = last;
  while (cut > 1 && NO_LINE_START.includes(chars[cut])) cut--;
  return cut;
}

/**
 * Splits text into pieces that each fit maxLines lines of the line limit.
 * @param {string} text
 * @param {object} [opts]
 * @return {string[]}
 */
export function splitTextForCues(text, opts) {
  const o = resolve(opts);
  const src = normalizeSpaces(text);
  const maxLen = lineLimit(src, o) * o.maxLines;
  const pieces = [];
  let rest = Array.from(src.trim());
  while (rest.length > maxLen) {
    const cut = bestCut(rest, maxLen);
    pieces.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
    while (rest.length && /\s/.test(rest[0])) rest.shift();
  }
  pieces.push(rest.join(''));
  return pieces.map((p) => p.trim()).filter(Boolean);
}

/**
 * Finds the 2-line break whose two sides are both within the limit and best balanced.
 * Returns [first, second] or null when no break fits.
 * @param {string[]} chars
 * @param {number} limit
 * @param {boolean} cjk
 * @return {string[]|null}
 */
function bestTwoLineBreak(chars, limit, cjk) {
  let best = null;
  let bestScore = Infinity;
  for (let p = 1; p < chars.length; p++) {
    let left;
    let right;
    if (cjk) {
      if (NO_LINE_START.includes(chars[p])) continue;
      left = chars.slice(0, p).join('').trim();
      right = chars.slice(p).join('').trim();
    } else {
      if (!/\s/.test(chars[p])) continue;
      left = chars.slice(0, p).join('').trim();
      right = chars.slice(p + 1).join('').trim();
    }
    if (NO_BREAK_AFTER.includes(chars[p - 1])) continue;
    const la = Array.from(left).length;
    const lb = Array.from(right).length;
    if (la === 0 || lb === 0 || la > limit || lb > limit) continue;
    let score = Math.abs(la - lb);
    // Japanese reads best broken right after 、/。, so punctuation weighs more there.
    if (SOFT_BREAK_AFTER.includes(chars[p - 1])) score -= cjk ? 5 : 3;
    if (cjk) {
      // Kanji followed by hiragana is usually one word (少|し, 降|る); hiragana then kanji/katakana is
      // usually a word boundary after a particle (が|降る, を|持って).
      if (HAN_RE.test(chars[p - 1]) && HIRAGANA_RE.test(chars[p])) score += 4;
      else if (HIRAGANA_RE.test(chars[p - 1]) && (HAN_RE.test(chars[p]) || KATAKANA_RE.test(chars[p]))) score -= 2;
    }
    if (score < bestScore) {
      bestScore = score;
      best = [left, right];
    }
  }
  return best;
}

/**
 * Greedy fill to the line limit. CJK: one character per unit, never starts a
 * line with a NO_LINE_START character. Latin: whole words, hard cut for long words.
 * @param {string} text
 * @param {number} limit
 * @param {boolean} cjk
 * @return {string[]}
 */
function greedyWrap(text, limit, cjk) {
  const lines = [];
  if (cjk) {
    let cur = [];
    for (const ch of Array.from(text)) {
      if (cur.length < limit) {
        cur.push(ch);
        continue;
      }
      if (NO_LINE_START.includes(ch)) {
        // Move the tail that is forbidden at a line start down with the next line.
        let k = cur.length - 1;
        while (k > 0 && NO_LINE_START.includes(cur[k])) k--;
        if (k > 0) {
          lines.push(cur.slice(0, k).join(''));
          cur = [...cur.slice(k), ch];
          continue;
        }
      }
      lines.push(cur.join(''));
      cur = [ch];
    }
    if (cur.length) lines.push(cur.join(''));
    return lines;
  }
  let cur = '';
  for (const word of text.split(' ')) {
    let w = word;
    while (Array.from(w).length > limit) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      const chunk = Array.from(w);
      lines.push(chunk.slice(0, limit).join(''));
      w = chunk.slice(limit).join('');
    }
    if (!w) continue;
    if (!cur) cur = w;
    else if (Array.from(cur).length + 1 + Array.from(w).length <= limit) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Keeps at most maxLines lines; extra lines are merged into the last one. */
function capLines(lines, maxLines, sep) {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(sep)];
}

/**
 * Breaks text into at most maxLines lines of the line limit, joined by '\n'.
 * Two lines: the most balanced break (bonus after punctuation). If none fits,
 * a greedy fill is used and any overflow lands in the last line.
 * @param {string} text
 * @param {object} [opts]
 * @return {string}
 */
export function wrapText(text, opts) {
  const o = resolve(opts);
  const src = normalizeSpaces(text).trim();
  if (!src) return '';
  const cjk = isCJK(src);
  const limit = cjk ? o.maxCharsPerLineCJK : o.maxCharsPerLine;
  const chars = Array.from(src);
  if (chars.length <= limit) return src;
  if (o.maxLines >= 2) {
    const pair = bestTwoLineBreak(chars, limit, cjk);
    if (pair) return pair.join('\n');
  }
  return capLines(greedyWrap(src, limit, cjk), o.maxLines, cjk ? '' : ' ').join('\n');
}

/** Joins word objects into text. Latin words get a space only if neither side has one. */
function joinWords(words, cjk) {
  let out = '';
  for (const w of words) {
    const piece = String(w.word);
    if (!cjk && out && !/\s$/.test(out) && !/^\s/.test(piece)) out += ' ';
    out += piece;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Keeps only words that have text and finite times. */
function validWords(seg) {
  const list = Array.isArray(seg.words) ? seg.words : [];
  return list.filter((w) => w && typeof w.word === 'string' && w.word.trim() !== '' &&
    Number.isFinite(w.start) && Number.isFinite(w.end));
}

/** Groups word timestamps into cues (relative times, no chunk offset yet). */
function cuesFromWords(words, o) {
  const cjk = isCJK(words.map((w) => w.word).join(''));
  const maxTotal = (cjk ? o.maxCharsPerLineCJK : o.maxCharsPerLine) * o.maxLines;
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length === 0) {
      cur = [w];
      continue;
    }
    const prev = cur[cur.length - 1];
    const first = cur[0];
    const gap = w.start - prev.end;
    const curDuration = prev.end - first.start;
    const newDuration = w.end - first.start;
    const lastChar = Array.from(prev.word.trim()).pop() ?? '';
    const endsSentence = lastChar !== '' && (SENTENCE_END_CJK + SENTENCE_END_ASCII).includes(lastChar);
    const tooLong = Array.from(joinWords([...cur, w], cjk)).length > maxTotal;
    if (tooLong || gap > o.wordGapSplit || newDuration > o.maxDuration ||
      (endsSentence && curDuration >= MIN_SENTENCE_CUE_SECONDS)) {
      groups.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length) groups.push(cur);
  return groups
      .map((g) => ({
        start: g[0].start,
        end: g[g.length - 1].end,
        text: joinWords(g, cjk),
      }))
      .filter((c) => c.text !== '');
}

/** Spreads a segment's time across its text pieces, by normalized character count. */
function cuesFromSegmentText(seg, o) {
  const pieces = splitTextForCues(segmentText(seg), o);
  if (pieces.length === 0) return [];
  const weights = pieces.map((p) => Math.max(1, normalizeText(p).length));
  const weightSum = weights.reduce((x, y) => x + y, 0);
  const span = seg.end - seg.start;
  let t = seg.start;
  return pieces.map((text, i) => {
    const start = t;
    t = i === pieces.length - 1 ? seg.end : t + (span * weights[i]) / weightSum;
    return {start, end: t, text};
  });
}

/**
 * Builds cues from timestamped segments (Whisper verbose_json style).
 * Uses word timings when present, otherwise splits the segment text.
 * @param {Array<object>} segments
 * @param {number} chunkStart absolute start time of the chunk, in seconds
 * @param {object} [opts]
 * @return {Array<{start: number, end: number, text: string}>}
 */
export function buildCuesFromSegments(segments, chunkStart, opts) {
  const o = resolve(opts);
  const base = Number.isFinite(chunkStart) ? chunkStart : 0;
  const cues = [];
  for (const seg of filterSegments(segments, o)) {
    const words = validWords(seg);
    let relative;
    if (words.length) {
      relative = cuesFromWords(words, o);
    } else if (Number.isFinite(seg.start) && Number.isFinite(seg.end)) {
      relative = cuesFromSegmentText(seg, o);
    } else {
      relative = [];
    }
    for (const c of relative) {
      cues.push({
        start: base + c.start,
        end: base + c.end,
        text: wrapText(c.text, o),
      });
    }
  }
  return cues;
}

/** Sorts speech regions, clips them to the chunk, merges overlaps. Falls back to the whole chunk. */
function normalizeRegions(regions, duration) {
  const list = (Array.isArray(regions) ? regions : [])
      .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end))
      .map((r) => ({start: Math.max(0, r.start), end: Math.min(duration, r.end)}))
      .filter((r) => r.end > r.start)
      .sort((x, y) => x.start - y.start);
  const merged = [];
  for (const r of list) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({...r});
  }
  return merged.length ? merged : [{start: 0, end: duration}];
}

/** Splits text at sentence ends, keeping the marks attached. */
function splitSentenceUnits(text) {
  const chars = Array.from(normalizeSpaces(text).trim());
  const units = [];
  let cur = [];
  for (let i = 0; i < chars.length; i++) {
    cur.push(chars[i]);
    if (isSentenceEnd(chars, i)) {
      units.push(cur.join('').trim());
      cur = [];
    }
  }
  if (cur.length) units.push(cur.join('').trim());
  return units.filter(Boolean);
}

/**
 * Maps a position on the speech timeline (speech only, gaps removed) back to
 * real chunk time. preferNext=true resolves a boundary to the start of the next region.
 */
function timelineToReal(regions, cum, t, preferNext) {
  for (let i = 0; i < regions.length; i++) {
    const end = cum[i] + (regions[i].end - regions[i].start);
    if (preferNext ? t < end : t <= end) {
      return {real: regions[i].start + (t - cum[i]), idx: i};
    }
  }
  const last = regions.length - 1;
  return {real: regions[last].end, idx: last};
}

/**
 * Builds cues from plain text (no timestamps). Text pieces are mapped onto the
 * speech regions, weighted by character count, so silence is skipped.
 * @param {string} text
 * @param {Array<{start: number, end: number}>} speechRegions relative to chunk start
 * @param {number} chunkStart absolute chunk start, in seconds
 * @param {number} chunkDuration chunk length, in seconds (must be > 0)
 * @param {object} [opts]
 * @return {Array<{start: number, end: number, text: string}>}
 */
export function buildCuesFromText(text, speechRegions, chunkStart, chunkDuration, opts) {
  const o = resolve(opts);
  const src = normalizeSpaces(text).trim();
  if (!src || !(chunkDuration > 0) || isHallucination(src)) return [];
  const base = Number.isFinite(chunkStart) ? chunkStart : 0;
  const regions = normalizeRegions(speechRegions, chunkDuration);
  // With several speech regions, pieces must not span a silent gap, so split sentence by sentence.
  const units = regions.length > 1 ? splitSentenceUnits(src) : [src];
  const pieces = units.flatMap((u) => splitTextForCues(u, o));
  if (pieces.length === 0) return [];

  const cum = [];
  let total = 0;
  for (const r of regions) {
    cum.push(total);
    total += r.end - r.start;
  }
  const weights = pieces.map((p) => Math.max(1, normalizeText(p).length));
  const weightSum = weights.reduce((x, y) => x + y, 0);

  const cues = [];
  let acc = 0;
  pieces.forEach((piece, i) => {
    const a = (acc / weightSum) * total;
    acc += weights[i];
    const b = (acc / weightSum) * total;
    const from = timelineToReal(regions, cum, a, true);
    const to = timelineToReal(regions, cum, b, false);
    let s = from.real;
    let e = to.real;
    if (from.idx !== to.idx) {
      // The piece crosses a silent gap: keep it in the region that holds most of it.
      const portionA = cum[from.idx] + (regions[from.idx].end - regions[from.idx].start) - a;
      const portionB = b - cum[to.idx];
      if (portionA >= portionB) e = regions[from.idx].end;
      else s = regions[to.idx].start;
    }
    const startNear = regions.find((r) => s >= r.start && s - r.start <= o.snapTolerance);
    if (startNear) s = startNear.start;
    const endNear = regions.find((r) => e <= r.end && r.end - e <= o.snapTolerance);
    if (endNear) e = endNear.end;
    if (e < s) e = s;
    cues.push({start: base + s, end: base + e, text: wrapText(piece, o)});
  });
  return cues;
}

/**
 * Sorts cues, drops empty ones, removes overlaps (keeping minGap), and extends
 * short cues within the limits. Returns new objects; the input is not changed.
 * @param {Array<{start: number, end: number, text: string}>} cues
 * @param {object} [opts]
 * @return {Array<{start: number, end: number, text: string}>}
 */
export function finalizeCues(cues, opts) {
  const o = resolve(opts);
  const arr = (cues ?? [])
      .filter((c) => c && typeof c.text === 'string' && c.text.trim() !== '' &&
        Number.isFinite(c.start) && Number.isFinite(c.end))
      .map((c) => ({start: c.start, end: c.end, text: c.text}))
      .sort((a, b) => a.start - b.start);

  for (let i = 0; i < arr.length; i++) {
    const cue = arr[i];
    const next = arr[i + 1];
    if (next && cue.end > next.start - o.minGap) {
      cue.end = Math.max(cue.start + 0.3, next.start - o.minGap);
    }
  }

  for (let i = 0; i < arr.length; i++) {
    const cue = arr[i];
    const next = arr[i + 1];
    const cps = isCJK(cue.text) ? o.maxCpsCJK : o.maxCps;
    const needed = Math.max(o.minDuration, normalizeText(cue.text).length / cps);
    if (cue.end - cue.start < needed) {
      let limit = Math.min(cue.start + needed, cue.start + o.maxDuration);
      if (next) limit = Math.min(limit, next.start - o.minGap);
      if (limit > cue.end) cue.end = limit;
    }
    if (cue.end - cue.start > o.maxDuration) cue.end = cue.start + o.maxDuration;
  }
  return arr;
}

/** True when a new cue repeats an existing cue that overlaps it in time. */
function isSeamDuplicate(existing, cue) {
  const overlap = Math.min(existing.end, cue.end) - Math.max(existing.start, cue.start);
  if (!(overlap > 0)) return false;
  const a = normalizeText(existing.text);
  const b = normalizeText(cue.text);
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.includes(shorter);
}

/**
 * Drops new cues that duplicate existing cues at a seam (chunk boundary).
 * `opts` is accepted for API symmetry; no option applies here.
 * @param {Array<{start: number, end: number, text: string}>} existingCues
 * @param {Array<{start: number, end: number, text: string}>} newCues
 * @param {object} [opts]
 * @return {Array<{start: number, end: number, text: string}>}
 */
export function mergeSeam(existingCues, newCues, opts) {
  const existing = existingCues ?? [];
  return (newCues ?? []).filter((cue) => !existing.some((e) => isSeamDuplicate(e, cue)));
}

/** normalizeText plus katakana -> hiragana, so two models' spelling choices still align. */
function alignKey(t) {
  return normalizeText(t).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * Timed reference characters from Whisper-style segments: one entry per
 * normalized character, with the start/end of the word (or segment) it came from.
 */
function timedReferenceChars(segments) {
  const out = [];
  for (const seg of segments) {
    const words = validWords(seg);
    const units = words.length ? words : (Number.isFinite(seg.start) && Number.isFinite(seg.end) ? [{word: segmentText(seg), start: seg.start, end: seg.end}] : []);
    for (const w of units) {
      const chars = Array.from(alignKey(w.word));
      const step = chars.length ? (w.end - w.start) / chars.length : 0;
      chars.forEach((c, i) => out.push({c, start: w.start + i * step, end: w.start + (i + 1) * step}));
    }
  }
  return out;
}

/**
 * Edit-distance alignment of hyp to ref. Returns, for each hyp index, the ref
 * index it matched or substituted, or -1 when it was an insertion.
 */
function alignIndices(hyp, ref) {
  const n = hyp.length;
  const m = ref.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = 0; i <= n; i++) dp[i * w] = i;
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[(i - 1) * w + j - 1] + (hyp[i - 1] === ref[j - 1] ? 0 : 1);
      dp[i * w + j] = Math.min(sub, dp[(i - 1) * w + j] + 1, dp[i * w + j - 1] + 1);
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const cur = dp[i * w + j];
    if (cur === dp[(i - 1) * w + j - 1] + (hyp[i - 1] === ref[j - 1] ? 0 : 1)) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (cur === dp[(i - 1) * w + j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}

/**
 * Builds cues from untimed text (e.g. gpt-transcribe) using a second, timed
 * transcript of the same audio (e.g. whisper-1 words) only for timing.
 * The texts are aligned character by character; each piece of the untimed text
 * takes the times of the reference characters it aligned to.
 * @param {string} text untimed transcript (the text that is shown)
 * @param {Array<object>} timedSegments segments with start/end and optional words, relative to chunk start
 * @param {number} chunkStart absolute chunk start, in seconds
 * @param {object} [opts]
 * @return {Array<{start: number, end: number, text: string}>|null} null when alignment isn't usable
 */
export function buildCuesFromAlignedText(text, timedSegments, chunkStart, opts) {
  const o = resolve(opts);
  const src = normalizeSpaces(text).trim();
  if (!src || isHallucination(src)) return [];
  const ref = timedReferenceChars(filterSegments(timedSegments, o));
  if (!ref.length) return null;

  const pieces = splitSentenceUnits(src).flatMap((u) => splitTextForCues(u, o));
  const pieceKeys = pieces.map((p) => Array.from(alignKey(p)));
  const hyp = pieceKeys.flat();
  if (!hyp.length) return [];
  const map = alignIndices(hyp, ref.map((r) => r.c));
  let matched = 0;
  for (let i = 0; i < hyp.length; i++) {
    if (map[i] >= 0 && hyp[i] === ref[map[i]].c) matched++;
  }
  // Too little overlap means the timing transcript heard something else; don't trust it.
  if (matched < hyp.length * 0.4) return null;

  const base = Number.isFinite(chunkStart) ? chunkStart : 0;
  const timed = [];
  let k = 0;
  for (let p = 0; p < pieces.length; p++) {
    const idx = [];
    for (let c = 0; c < pieceKeys[p].length; c++, k++) {
      if (map[k] >= 0) idx.push(map[k]);
    }
    timed.push(idx.length ? {start: ref[Math.min(...idx)].start, end: ref[Math.max(...idx)].end} : null);
  }
  // Pieces that aligned to nothing sit between their neighbours rather than being dropped.
  const lastRefEnd = ref[ref.length - 1].end;
  const cues = [];
  let prevEnd = 0;
  for (let p = 0; p < pieces.length; p++) {
    let t = timed[p];
    if (!t) {
      const next = timed.slice(p + 1).find(Boolean);
      t = {start: prevEnd, end: next ? next.start : lastRefEnd};
    }
    const start = Math.max(prevEnd, t.start);
    const end = Math.max(start + 0.2, t.end);
    prevEnd = end;
    cues.push({start: base + start, end: base + end, text: wrapText(pieces[p], o)});
  }
  return cues;
}

/**
 * Nudges cue edges onto detected speech: a cue that starts in silence moves to
 * the next speech onset; one that starts just after an onset (and the previous
 * cue doesn't use it) moves back to it; an end inside speech extends to the end
 * of that speech run. Model timestamps say *which* words; energy says *when*.
 * @param {Array<{start: number, end: number, text: string}>} cues sorted, absolute times
 * @param {Array<{start: number, end: number}>} regions speech regions, absolute times
 * @param {object} [opts] {maxForward = 1.0, maxBackward = 0.5, maxExtend = 1.0}
 * @return {Array<{start: number, end: number, text: string}>}
 */
export function snapCuesToSpeech(cues, regions, opts = {}) {
  const maxForward = opts.maxForward ?? 1.0;
  const maxBackward = opts.maxBackward ?? 0.5;
  const maxExtend = opts.maxExtend ?? 1.0;
  const rs = (regions ?? []).filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  if (!rs.length) return cues.map((c) => ({...c}));
  const out = cues.map((c) => ({...c}));
  for (let i = 0; i < out.length; i++) {
    const cue = out[i];
    const prevEnd = i > 0 ? out[i - 1].end : -Infinity;
    const nextStart = i + 1 < out.length ? out[i + 1].start : Infinity;

    const inside = rs.find((r) => r.start <= cue.start && cue.start < r.end);
    if (!inside) {
      const next = rs.find((r) => r.start > cue.start);
      if (next && next.start - cue.start <= maxForward && next.start < cue.end - 0.3) cue.start = next.start;
    } else if (cue.start - inside.start <= maxBackward && inside.start >= prevEnd) {
      cue.start = inside.start;
    }

    const endRegion = rs.find((r) => r.start < cue.end && cue.end < r.end);
    if (endRegion && endRegion.end - cue.end <= maxExtend && endRegion.end <= nextStart) cue.end = endRegion.end;
  }
  return out;
}
