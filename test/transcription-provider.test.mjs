import assert from 'node:assert/strict';
import http from 'node:http';
import {describe, it} from 'node:test';
import {
  LANGUAGE_NAME_TO_CODE,
  ProviderError,
  TranscriptionProvider,
  modelSupportsTimestamps,
  normalizeLanguage,
} from '../chrome/player/transcription/TranscriptionProvider.mjs';

const WAV = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);

/**
 * Starts a local HTTP server on an ephemeral port that records every request.
 * @param {(n: number, req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @return {Promise<{baseUrl: string, requests: Array<object>, close: () => Promise<void>}>}
 */
function startMock(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || '',
        raw,
        body: raw.toString('latin1'),
      });
      handler(requests.length - 1, req, res);
    });
  });
  server.on('connection', (socket) => sockets.add(socket));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => done());
        }),
      });
    });
  });
}

/**
 * Sends a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} payload
 * @param {Record<string, string>} [headers]
 */
function reply(res, status, payload, headers = {}) {
  res.writeHead(status, {'content-type': 'application/json', ...headers});
  res.end(JSON.stringify(payload));
}

describe('language and model helpers', () => {
  it('normalizes language names and codes', () => {
    assert.equal(normalizeLanguage('Japanese'), 'ja');
    assert.equal(normalizeLanguage('en-US'), 'en');
    assert.equal(normalizeLanguage('ja'), 'ja');
    assert.equal(normalizeLanguage('Klingon'), '');
    assert.equal(normalizeLanguage('constructor'), '');
    assert.equal(normalizeLanguage(''), '');
    assert.equal(LANGUAGE_NAME_TO_CODE.ukrainian, 'uk');
  });

  it('detects whisper models', () => {
    assert.equal(modelSupportsTimestamps('whisper-1'), true);
    assert.equal(modelSupportsTimestamps('whisper-large-v3-turbo'), true);
    assert.equal(modelSupportsTimestamps('gpt-transcribe'), false);
  });
});

describe('transcribe', () => {
  it('assigns top-level words to segments and maps the language name to a code', async () => {
    const mock = await startMock((n, req, res) => reply(res, 200, {
      task: 'transcribe',
      language: 'japanese',
      duration: 5,
      text: ' こんにちは 世界 ',
      segments: [
        {id: 0, start: 0, end: 2, text: ' こんにちは'},
        {id: 1, start: 2, end: 4, text: ' 世界'},
      ],
      words: [
        {word: ' こ', start: 0.1, end: 0.5},
        {word: 'ん', start: 0.5, end: 1},
        {word: '世', start: 2.1, end: 2.5},
        {word: '界', start: 4.5, end: 5},
      ],
    }));
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        apiKey: 'test-key',
        model: 'whisper-1',
        maxRetries: 0,
      });
      const result = await provider.transcribe(WAV, {language: 'ja'});

      assert.equal(result.language, 'ja');
      assert.equal(result.text, 'こんにちは 世界');
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].text, 'こんにちは');
      assert.deepEqual(result.segments[0].words.map((w) => w.word), ['こ', 'ん']);
      assert.deepEqual(result.segments[1].words.map((w) => w.word), ['世', '界']);
      assert.equal(typeof result.latencyMs, 'number');

      const req = mock.requests[0];
      assert.equal(req.url, '/v1/audio/transcriptions');
      assert.equal(req.auth, 'Bearer test-key');
      assert.match(req.body, /name="file"; filename="chunk\.wav"/);
      assert.match(req.body, /name="model"\r\n\r\nwhisper-1\r\n/);
      assert.match(req.body, /name="language"\r\n\r\nja\r\n/);
      assert.match(req.body, /name="response_format"\r\n\r\nverbose_json\r\n/);
      assert.equal(req.body.split('name="timestamp_granularities[]"').length - 1, 2);
    } finally {
      await mock.close();
    }
  });

  it('accepts words nested inside each segment (local servers)', async () => {
    const mock = await startMock((n, req, res) => reply(res, 200, {
      text: 'one two',
      segments: [
        {start: 0, end: 1, text: ' one', words: [{word: ' one', start: 0, end: 1}]},
        {start: 1, end: 2, text: ' two', words: [{word: ' two', start: 1, end: 2}]},
      ],
    }));
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'Systran/faster-whisper-large-v3',
        maxRetries: 0,
      });
      const result = await provider.transcribe(WAV);
      assert.deepEqual(result.segments.map((s) => s.words.map((w) => w.word)), [['one'], ['two']]);
      assert.equal(result.language, '');
    } finally {
      await mock.close();
    }
  });

  it('uses json for non-whisper models, reads languages[], and sends no timestamp fields', async () => {
    const mock = await startMock((n, req, res) => reply(res, 200, {
      text: 'hello there',
      languages: [{code: 'ja'}],
      usage: {type: 'tokens'},
    }));
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'gpt-transcribe',
        maxRetries: 0,
      });
      const result = await provider.transcribe(WAV);
      assert.equal(result.text, 'hello there');
      assert.equal(result.language, 'ja');
      assert.equal(result.segments, null);

      const body = mock.requests[0].body;
      assert.match(body, /name="model"\r\n\r\ngpt-transcribe\r\n/);
      assert.match(body, /name="response_format"\r\n\r\njson\r\n/);
      assert.equal(body.includes('timestamp_granularities'), false);
      assert.equal(mock.requests[0].auth, '');
    } finally {
      await mock.close();
    }
  });

  it('keeps only the last 200 characters of the prompt', async () => {
    const mock = await startMock((n, req, res) => reply(res, 200, {text: 'ok'}));
    try {
      const provider = new TranscriptionProvider({baseUrl: mock.baseUrl, model: 'gpt-transcribe'});
      await provider.transcribe(WAV, {prompt: 'x'.repeat(100) + 'y'.repeat(200)});
      const body = mock.requests[0].body;
      assert.ok(body.includes('y'.repeat(200)));
      assert.equal(body.includes('x'), false);
    } finally {
      await mock.close();
    }
  });

  it('retries after 429 and succeeds when Retry-After is 0', async () => {
    const mock = await startMock((n, req, res) => {
      if (n === 0) {
        reply(res, 429, {error: {message: 'Rate limited'}}, {'retry-after': '0'});
      } else {
        reply(res, 200, {text: 'ok after retry'});
      }
    });
    try {
      const provider = new TranscriptionProvider({baseUrl: mock.baseUrl, model: 'gpt-transcribe'});
      const result = await provider.transcribe(WAV);
      assert.equal(result.text, 'ok after retry');
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });

  it('does not retry a 401 and throws ProviderError with the API message', async () => {
    const mock = await startMock((n, req, res) => reply(res, 401, {
      error: {
        message: 'Incorrect API key provided',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    }));
    try {
      const provider = new TranscriptionProvider({baseUrl: mock.baseUrl, model: 'gpt-transcribe'});
      await assert.rejects(provider.transcribe(WAV), (err) => {
        return err instanceof ProviderError &&
          err.status === 401 &&
          err.retryable === false &&
          err.code === 'invalid_api_key' &&
          err.message === 'Incorrect API key provided';
      });
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });

  it('fails with a timeout when the server never responds', async () => {
    const mock = await startMock(() => {});
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'gpt-transcribe',
        timeoutMs: 200,
        maxRetries: 0,
      });
      await assert.rejects(provider.transcribe(WAV), (err) => {
        return err instanceof ProviderError && err.code === 'timeout' && err.retryable === true;
      });
    } finally {
      await mock.close();
    }
  });

  it('throws AbortError immediately when the caller aborts, without retrying', async () => {
    const mock = await startMock(() => {});
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'gpt-transcribe',
        timeoutMs: 5000,
        maxRetries: 2,
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(
          provider.transcribe(WAV, {signal: controller.signal}),
          {name: 'AbortError'},
      );
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});

describe('translate', () => {
  it('translates lines and sends the expected chat request', async () => {
    const mock = await startMock((n, req, res) => reply(res, 200, {
      choices: [{message: {content: JSON.stringify({t: ['Hello', 'World']})}}],
    }));
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'whisper-1',
        translateModel: 'gpt-4.1-mini',
        maxRetries: 0,
      });
      const out = await provider.translate(['こんにちは', '世界'], {
        targetLanguage: 'English',
        sourceLanguage: 'Japanese',
        context: ['a', 'b', 'c', 'd', 'e'],
      });
      assert.deepEqual(out, ['Hello', 'World']);

      const req = mock.requests[0];
      assert.equal(req.url, '/v1/chat/completions');
      const payload = JSON.parse(req.raw.toString('utf8'));
      assert.equal(payload.model, 'gpt-4.1-mini');
      assert.equal(payload.temperature, 0);
      assert.deepEqual(payload.response_format, {type: 'json_object'});
      assert.match(payload.messages[0].content, /from Japanese into English/);
      assert.match(payload.messages[0].content, /exactly 2 translated strings/);
      const user = JSON.parse(payload.messages[1].content);
      assert.deepEqual(user.lines, ['こんにちは', '世界']);
      assert.deepEqual(user.context, ['b', 'c', 'd', 'e']);
    } finally {
      await mock.close();
    }
  });

  it('retries a count mismatch once and fills gaps with the original lines', async () => {
    const mock = await startMock((n, req, res) => {
      const t = n === 0 ? ['only one'] : ['Hi'];
      reply(res, 200, {choices: [{message: {content: JSON.stringify({t})}}]});
    });
    try {
      const provider = new TranscriptionProvider({
        baseUrl: mock.baseUrl,
        model: 'whisper-1',
        translateModel: 'gpt-4.1-mini',
        maxRetries: 0,
      });
      const out = await provider.translate(['first line', 'second line'], {targetLanguage: 'English'});
      assert.deepEqual(out, ['Hi', 'second line']);
      assert.equal(mock.requests.length, 2);
    } finally {
      await mock.close();
    }
  });
});

describe('fromSettings', () => {
  it('fills missing fields from presets', async () => {
    assert.equal(TranscriptionProvider.fromSettings({provider: 'groq'}, 'k').supportsTimestamps, true);
    assert.equal(TranscriptionProvider.fromSettings({}).supportsTimestamps, false);
    assert.equal(TranscriptionProvider.fromSettings({provider: 'unknown'}).supportsTimestamps, false);

    const mock = await startMock((n, req, res) => reply(res, 200, {text: 'hi'}));
    try {
      const provider = TranscriptionProvider.fromSettings({
        provider: 'custom',
        baseUrl: `${mock.baseUrl}/`,
        model: '',
      });
      const result = await provider.transcribe(WAV);
      assert.equal(result.text, 'hi');
      const req = mock.requests[0];
      assert.equal(req.url, '/v1/audio/transcriptions');
      assert.equal(req.auth, '');
      assert.match(req.body, /name="model"\r\n\r\nwhisper-1\r\n/);
      assert.match(req.body, /name="response_format"\r\n\r\nverbose_json\r\n/);

      // Custom preset has no translation model, so translate() must refuse without a request.
      await assert.rejects(provider.translate(['x'], {targetLanguage: 'English'}), (err) => {
        return err instanceof ProviderError && err.retryable === false;
      });
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  });
});
