/**
 * Client for OpenAI-compatible speech-to-text and chat translation APIs.
 * Uses only fetch, FormData, Blob and AbortController, so it runs in extension
 * pages and in Node.
 */

/** Endpoint and model defaults for each provider choice. */
export const ProviderPresets = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-transcribe',
    translateModel: 'gpt-4.1-mini',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    translateModel: 'llama-3.3-70b-versatile',
  },
  custom: {
    baseUrl: '',
    model: 'whisper-1',
    translateModel: '',
  },
};

/** Maps lowercase English language names (as returned by Whisper) to ISO 639-1 codes. */
export const LANGUAGE_NAME_TO_CODE = {
  japanese: 'ja',
  english: 'en',
  chinese: 'zh',
  korean: 'ko',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  portuguese: 'pt',
  russian: 'ru',
  italian: 'it',
  hindi: 'hi',
  arabic: 'ar',
  indonesian: 'id',
  thai: 'th',
  vietnamese: 'vi',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
  ukrainian: 'uk',
};

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5000;
const BASE_RETRY_DELAY_MS = 400;
const RETRY_JITTER_MS = 200;
const PROMPT_MAX_CHARS = 200;
const WORD_START_TOLERANCE_S = 0.05;
const TRANSLATE_CONTEXT_LINES = 4;

/**
 * Tells whether a model returns word and segment timestamps (Whisper models do).
 * @param {string} model Model id.
 * @return {boolean}
 */
export function modelSupportsTimestamps(model) {
  return /whisper/i.test(model);
}

/**
 * Converts a language name ("Japanese") or code ("ja", "en-US") to an ISO 639-1 code.
 * @param {unknown} value Language name or code from an API response or settings.
 * @return {string} Two-letter code, or '' when the input is not recognized.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (Object.hasOwn(LANGUAGE_NAME_TO_CODE, text)) {
    return LANGUAGE_NAME_TO_CODE[text];
  }
  const match = /^([a-z]{2})(?:[-_][a-z0-9]+)?$/.exec(text);
  return match ? match[1] : '';
}

/** Error from a provider call. `status` is 0 for network errors and timeouts. */
export class ProviderError extends Error {
  /**
   * @param {string} message Human-readable message.
   * @param {{status?: number, retryable?: boolean, code?: string}} [options]
   */
  constructor(message, {status = 0, retryable = false, code = ''} = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

/** Calls an OpenAI-compatible API for transcription and translation. */
export class TranscriptionProvider {
  #baseUrl;
  #apiKey;
  #model;
  #translateModel;
  #timeoutMs;
  #maxRetries;
  #fetchImpl;

  /**
   * @param {object} options
   * @param {string} options.baseUrl API base URL, e.g. https://api.openai.com/v1.
   * @param {string} [options.apiKey] Bearer token. Omitted from requests when empty.
   * @param {string} options.model Transcription model id.
   * @param {string} [options.translateModel] Chat model used by translate().
   * @param {number} [options.timeoutMs] Per-attempt timeout in milliseconds.
   * @param {number} [options.maxRetries] Retries after the first attempt.
   * @param {typeof fetch} [options.fetchImpl] Fetch function to use.
   */
  constructor({
    baseUrl,
    apiKey = '',
    model,
    translateModel = '',
    timeoutMs = 30000,
    maxRetries = 2,
    fetchImpl = globalThis.fetch.bind(globalThis),
  }) {
    this.#baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#model = model;
    this.#translateModel = translateModel;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#fetchImpl = fetchImpl;
  }

  /**
   * Builds a provider from saved settings, filling empty fields from the preset.
   * @param {{provider?: string, baseUrl?: string, model?: string, translateModel?: string}} [settings]
   * @param {string} [apiKey] Bearer token.
   * @return {TranscriptionProvider}
   */
  static fromSettings(settings = {}, apiKey = '') {
    const s = settings ?? {};
    const name = Object.hasOwn(ProviderPresets, s.provider) ? s.provider : 'openai';
    const preset = ProviderPresets[name];
    return new TranscriptionProvider({
      baseUrl: s.baseUrl || preset.baseUrl,
      apiKey,
      model: s.model || preset.model,
      translateModel: s.translateModel || preset.translateModel,
    });
  }

  /** True when the transcription model returns word and segment timestamps. */
  get supportsTimestamps() {
    return modelSupportsTimestamps(this.#model);
  }

  /**
   * Transcribes one WAV chunk.
   * @param {Uint8Array} wavBytes WAV file bytes.
   * @param {{language?: string, prompt?: string, signal?: AbortSignal}} [options]
   * @return {Promise<{text: string, language: string, segments: Array|null, latencyMs: number}>}
   */
  async transcribe(wavBytes, {language = '', prompt = '', signal} = {}) {
    const form = new FormData();
    form.append('file', new Blob([wavBytes], {type: 'audio/wav'}), 'chunk.wav');
    form.append('model', this.#model);
    form.append('temperature', '0');
    if (language) {
      form.append('language', language);
    }
    if (prompt) {
      form.append('prompt', prompt.slice(-PROMPT_MAX_CHARS));
    }
    if (this.supportsTimestamps) {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
    } else {
      form.append('response_format', 'json');
    }

    const started = Date.now();
    const json = await this.#post('/audio/transcriptions', form, signal);
    const segments = Array.isArray(json.segments) ?
      normalizeSegments(json.segments, json.words) :
      null;
    const languageCode = normalizeLanguage(json.language) ||
      normalizeLanguage(Array.isArray(json.languages) ? json.languages[0]?.code : '');

    return {
      text: typeof json.text === 'string' ? json.text.trim() : '',
      language: languageCode,
      segments,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Translates subtitle lines with a chat model. Returns one string per input line.
   * @param {string[]} lines Lines to translate, in order.
   * @param {{targetLanguage: string, sourceLanguage?: string, context?: string[], signal?: AbortSignal}} options
   * @return {Promise<string[]>}
   */
  async translate(lines, {targetLanguage, sourceLanguage = '', context = [], signal} = {}) {
    if (!this.#translateModel) {
      throw new ProviderError('No translation model is set for this provider.', {
        retryable: false,
        code: 'no_translate_model',
      });
    }
    if (lines.length === 0) {
      return [];
    }

    const from = sourceLanguage ? ` from ${sourceLanguage}` : '';
    const system = `You translate video subtitle lines${from} into ${targetLanguage}. ` +
      `Reply with JSON {"t": [...]} containing exactly ${lines.length} translated strings, ` +
      'one per input line, in the same order. Natural, concise subtitle style. ' +
      'No notes, no romanization.';
    const user = JSON.stringify({
      context: context.slice(-TRANSLATE_CONTEXT_LINES),
      lines,
    });

    let translated = await this.#translateOnce(system, user, signal);
    if (translated.length !== lines.length) {
      translated = await this.#translateOnce(system, user, signal);
    }
    return lines.map((line, i) => {
      const value = translated[i];
      return typeof value === 'string' && value.trim() ? value.trim() : line;
    });
  }

  /**
   * Runs one chat completion and returns the parsed "t" array ([] when unparseable).
   * @param {string} system
   * @param {string} user
   * @param {AbortSignal|undefined} signal
   * @return {Promise<unknown[]>}
   */
  async #translateOnce(system, user, signal) {
    const json = await this.#post('/chat/completions', {
      model: this.#translateModel,
      temperature: 0,
      response_format: {type: 'json_object'},
      messages: [
        {role: 'system', content: system},
        {role: 'user', content: user},
      ],
    }, signal);
    const content = json.choices?.[0]?.message?.content;
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed?.t) ? parsed.t : [];
    } catch {
      return [];
    }
  }

  /**
   * POSTs a body with retries. Retries network errors, timeouts and RETRY_STATUSES.
   * @param {string} path Path appended to the base URL.
   * @param {FormData|object} body FormData, or a plain object sent as JSON.
   * @param {AbortSignal|undefined} signal Caller signal; aborting it stops immediately.
   * @return {Promise<object>} Parsed JSON response.
   */
  async #post(path, body, signal) {
    if (!this.#baseUrl) {
      throw new ProviderError('No API base URL is set for this provider.', {code: 'no_base_url'});
    }
    const headers = {};
    if (this.#apiKey) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }
    let payload = body;
    if (!(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const init = {method: 'POST', headers, body: payload};
    const url = `${this.#baseUrl}${path}`;

    for (let attempt = 0; ; attempt++) {
      const result = await this.#attempt(url, init, signal);
      if (result.ok) {
        return result.data;
      }
      if (attempt >= this.#maxRetries) {
        throw result.error;
      }
      await sleep(retryDelayMs(attempt, result.retryAfterMs), signal);
    }
  }

  /**
   * Makes one HTTP attempt with a timeout.
   * Returns {ok: true, data}, or {ok: false, error, retryAfterMs} for a retryable failure.
   * Throws ProviderError (not retryable) or AbortError for everything else.
   * @param {string} url
   * @param {RequestInit} init
   * @param {AbortSignal|undefined} signal
   * @return {Promise<object>}
   */
  async #attempt(url, init, signal) {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.#timeoutMs);
    const combined = signal ?
      combineSignals(signal, timeoutController.signal) :
      timeoutController.signal;

    let res;
    let text;
    try {
      res = await this.#fetchImpl(url, {...init, signal: combined});
      text = await res.text();
    } catch (error) {
      if (signal?.aborted) {
        throw abortError();
      }
      if (timedOut) {
        return {
          ok: false,
          error: new ProviderError(`Request timed out after ${this.#timeoutMs} ms.`, {
            retryable: true,
            code: 'timeout',
          }),
        };
      }
      return {
        ok: false,
        error: new ProviderError(`Network error: ${error?.message ?? error}`, {
          retryable: true,
          code: 'network',
        }),
      };
    } finally {
      clearTimeout(timer);
    }

    const body = parseJsonOrNull(text);
    if (res.ok) {
      if (body === null) {
        throw new ProviderError('Provider returned a response that is not JSON.', {
          status: res.status,
        });
      }
      return {ok: true, data: body};
    }

    const errorObj = body && typeof body === 'object' && body.error && typeof body.error === 'object' ?
      body.error :
      {};
    const error = new ProviderError(errorObj.message || res.statusText || `HTTP ${res.status}`, {
      status: res.status,
      retryable: RETRY_STATUSES.has(res.status),
      code: String(errorObj.code || errorObj.type || ''),
    });
    if (error.retryable) {
      return {ok: false, error, retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'))};
    }
    throw error;
  }
}

/**
 * Turns raw API segments into the normalized shape. Top-level words (OpenAI format)
 * are assigned to segments; per-segment words (local servers) are kept as-is.
 * @param {Array<object>} rawSegments
 * @param {unknown} topWords Top-level words array, or undefined.
 * @return {Array<object>}
 */
function normalizeSegments(rawSegments, topWords) {
  const segments = rawSegments.map((seg) => ({
    start: Number(seg.start) || 0,
    end: Number(seg.end) || 0,
    text: String(seg.text ?? '').trim(),
    words: normalizeWords(seg.words),
    no_speech_prob: finiteOrNull(seg.no_speech_prob),
    avg_logprob: finiteOrNull(seg.avg_logprob),
    compression_ratio: finiteOrNull(seg.compression_ratio),
  }));

  const words = normalizeWords(topWords);
  if (words.length > 0 && segments.length > 0) {
    for (const segment of segments) {
      segment.words = [];
    }
    for (const word of words) {
      segments[pickSegmentIndex(segments, word.start)].words.push(word);
    }
  }
  return segments;
}

/**
 * Finds the segment for a word start time. First tries a segment with
 * start - 0.05 <= t < end. Otherwise uses the last segment that started
 * before t (gaps and trailing words), or the first segment for early words.
 * @param {Array<{start: number, end: number}>} segments
 * @param {number} t Word start in seconds.
 * @return {number} Index into segments.
 */
function pickSegmentIndex(segments, t) {
  for (let i = 0; i < segments.length; i++) {
    if (t >= segments[i].start - WORD_START_TOLERANCE_S && t < segments[i].end) {
      return i;
    }
  }
  let best = 0;
  for (let i = 0; i < segments.length; i++) {
    if (t >= segments[i].start - WORD_START_TOLERANCE_S) {
      best = i;
    }
  }
  return best;
}

/**
 * @param {unknown} raw
 * @return {Array<{word: string, start: number, end: number}>}
 */
function normalizeWords(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const words = [];
  for (const item of raw) {
    const start = Number(item?.start);
    if (!Number.isFinite(start)) {
      continue;
    }
    const end = Number(item.end);
    const word = String(item.word ?? item.text ?? '').trim();
    if (word) {
      words.push({word, start, end: Number.isFinite(end) ? end : start});
    }
  }
  return words;
}

/**
 * @param {unknown} value
 * @return {number|null}
 */
function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

/**
 * Parses a Retry-After header given in seconds.
 * @param {string|null} value
 * @return {number|undefined} Milliseconds, or undefined when absent or not numeric.
 */
function parseRetryAfterMs(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * @param {number} attempt Zero-based index of the attempt that failed.
 * @param {number|undefined} retryAfterMs Server hint.
 * @return {number} Delay in milliseconds.
 */
function retryDelayMs(attempt, retryAfterMs) {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  return BASE_RETRY_DELAY_MS * 2 ** attempt + Math.random() * RETRY_JITTER_MS;
}

/**
 * @param {string} text
 * @return {object|null}
 */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Combines signals so that either one aborts the result.
 * @param {AbortSignal} a
 * @param {AbortSignal} b
 * @return {AbortSignal}
 */
function combineSignals(a, b) {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {once: true});
  }
  return controller.signal;
}

/**
 * Creates the AbortError thrown when the caller cancels.
 * @return {DOMException}
 */
function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Waits for ms, rejecting with AbortError if the signal fires first.
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @return {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
