import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {
  HALLUCINATION_PHRASES,
  buildCuesFromSegments,
  buildCuesFromText,
  filterSegments,
  finalizeCues,
  isCJK,
  isHallucination,
  mergeSeam,
  normalizeText,
  splitTextForCues,
  wrapText,
} from '../chrome/player/transcription/CueBuilder.mjs';

const SMALL_KANA_OR_MARK = /^[。、！？ー ゃゅょっぁぃぅぇぉ]/u;

describe('normalizeText and isCJK', () => {
  test('removes punctuation and symbols but keeps the long vowel mark', () => {
    assert.equal(normalizeText('ＡＢＣ 。、ー ♪'), 'abcー');
    assert.equal(normalizeText('Hello, World!'), 'helloworld');
  });

  test('detects CJK text by script share', () => {
    assert.equal(isCJK('今日は良い天気ですね'), true);
    assert.equal(isCJK('Hello world'), false);
    assert.equal(isCJK(''), false);
  });
});

describe('isHallucination', () => {
  test('every blacklisted phrase is a hallucination', () => {
    for (const phrase of HALLUCINATION_PHRASES) {
      assert.equal(isHallucination(phrase), true, phrase);
    }
  });

  test('repeats of a phrase and marker substrings are hallucinations', () => {
    assert.equal(isHallucination('Thank you for watching!!'), true);
    assert.equal(isHallucination('Thanks for watching thanks for watching thanks for watching'), true);
    assert.equal(isHallucination('ご視聴ありがとうございました。ご視聴ありがとうございました。'), true);
    assert.equal(isHallucination('Subtitles by the Amara.org community'), true);
    assert.equal(isHallucination('字幕by ほげ'), true);
  });

  test('repetition loops are hallucinations', () => {
    assert.equal(isHallucination('あ'.repeat(20)), true);
    assert.equal(isHallucination('the the the the the the the'), true);
  });

  test('empty text is a hallucination', () => {
    assert.equal(isHallucination(''), true);
    assert.equal(isHallucination('。。。'), true);
  });

  test('real speech is not dropped', () => {
    assert.equal(isHallucination('ありがとうございました。今日は楽しかったです。'), false);
    assert.equal(isHallucination('おつかれさまでした'), false);
    assert.equal(isHallucination('Thanks, I really enjoyed the trip today.'), false);
    assert.equal(isHallucination('Thanks for watching the match with me'), false);
  });
});

describe('filterSegments', () => {
  test('applies silence, compression and hallucination rules; missing fields do not trigger rules', () => {
    const segments = [
      {start: 0, end: 1, text: 'Keep me.', no_speech_prob: 0.1, avg_logprob: -0.2},
      {start: 1, end: 2, text: 'Drop silence.', no_speech_prob: 0.9, avg_logprob: -1.5},
      {start: 2, end: 3, text: 'Keep high no-speech but confident.', no_speech_prob: 0.9, avg_logprob: -0.2},
      {start: 3, end: 4, text: 'Drop compressed.', compression_ratio: 3.1},
      {start: 4, end: 5, text: 'Thanks for watching'},
      {start: 5, end: 6, text: 'Missing fields are fine'},
    ];
    const kept = filterSegments(segments).map((s) => s.text);
    assert.deepEqual(kept, [
      'Keep me.',
      'Keep high no-speech but confident.',
      'Missing fields are fine',
    ]);
  });
});

describe('wrapText and splitTextForCues', () => {
  test('English: at most 2 lines of 42 characters', () => {
    const text = 'This is a fairly long English sentence that should wrap onto two lines nicely.';
    assert.ok(text.length <= 84);
    const lines = wrapText(text).split('\n');
    assert.ok(lines.length <= 2);
    for (const line of lines) assert.ok(line.length <= 42, line);
  });

  test('English: every split piece fits and sentence ends are preferred', () => {
    const text = Array(10).fill('Sentence one is here.').join(' ');
    const pieces = splitTextForCues(text);
    assert.ok(pieces.length >= 2);
    for (const p of pieces) {
      assert.ok(p.length <= 84, p);
      assert.ok(p.endsWith('.'), p);
    }
  });

  test('Japanese: lines are at most 16 characters and never start with 。 or ー or small kana', () => {
    const text = '今日はとても天気がいいので、友達と公園に行きました。';
    const lines = wrapText(text).split('\n');
    assert.ok(lines.length <= 2);
    for (const line of lines) {
      assert.ok(Array.from(line).length <= 16, line);
      assert.equal(SMALL_KANA_OR_MARK.test(line), false, line);
    }
  });

  test('Japanese: a long vowel run is not split off to the start of a line', () => {
    const lines = wrapText('とても嬉しかったですーーーーーーーーー').split('\n');
    for (const line of lines) {
      assert.ok(Array.from(line).length <= 16, line);
      assert.equal(line.startsWith('ー'), false, line);
    }
  });

  test('Japanese: pieces fit 2 lines of 16 and end on 。', () => {
    const pieces = splitTextForCues('あいうえお。'.repeat(10));
    assert.ok(pieces.length >= 2);
    for (const p of pieces) {
      assert.ok(Array.from(p).length <= 32, p);
      assert.ok(p.endsWith('。'), p);
    }
  });
});

describe('buildCuesFromSegments', () => {
  test('word groups split on sentence end once the cue is at least 1.2 s', () => {
    const seg = {
      start: 0,
      end: 2.8,
      text: ' Hello there friend. How are you',
      words: [
        {word: ' Hello', start: 0, end: 0.4},
        {word: ' there', start: 0.45, end: 0.9},
        {word: ' friend.', start: 0.95, end: 1.5},
        {word: ' How', start: 1.6, end: 1.9},
        {word: ' are', start: 2.0, end: 2.3},
        {word: ' you', start: 2.4, end: 2.8},
      ],
    };
    const cues = buildCuesFromSegments([seg], 10);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, 'Hello there friend.');
    assert.ok(Math.abs(cues[0].start - 10) < 1e-9);
    assert.ok(Math.abs(cues[0].end - 11.5) < 1e-9);
    assert.equal(cues[1].text, 'How are you');
    assert.ok(Math.abs(cues[1].start - 11.6) < 1e-9);
    assert.ok(Math.abs(cues[1].end - 12.8) < 1e-9);
  });

  test('word groups split on a gap larger than wordGapSplit', () => {
    const seg = {
      start: 0,
      end: 2.3,
      text: 'Hello there again',
      words: [
        {word: ' Hello', start: 0, end: 0.4},
        {word: ' there', start: 0.45, end: 0.9},
        {word: ' again', start: 1.9, end: 2.3},
      ],
    };
    const cues = buildCuesFromSegments([seg], 0);
    assert.deepEqual(cues.map((c) => c.text), ['Hello there', 'again']);
  });

  test('Japanese word tokens join without spaces', () => {
    const chars = ['今', '日', 'は', '楽', 'し', 'い', '。'];
    const seg = {
      start: 0,
      end: 2.1,
      text: '今日は楽しい。',
      words: chars.map((word, i) => ({word, start: i * 0.3, end: (i + 1) * 0.3})),
    };
    const cues = buildCuesFromSegments([seg], 0);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, '今日は楽しい。');
  });

  test('text-only segment time is split across pieces by character count', () => {
    const seg = {start: 0, end: 4, text: 'Short one. Another sentence here.'};
    const cues = buildCuesFromSegments([seg], 0);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 4);
  });
});

describe('buildCuesFromText', () => {
  test('second sentence starts in the second speech region after a 3 s gap', () => {
    const text = 'Hello there, how are you today. I am doing quite well, thanks.';
    const cues = buildCuesFromText(text, [{start: 0, end: 3}, {start: 6, end: 9}], 100, 10);
    assert.equal(cues.length, 2);
    assert.ok(Math.abs(cues[0].start - 100) < 1e-9);
    assert.ok(Math.abs(cues[0].end - 103) < 1e-9, 'first cue must not run into the gap');
    assert.ok(cues[1].start >= 106 - 1e-9 && cues[1].start < 107, `start ${cues[1].start}`);
    assert.ok(Math.abs(cues[1].end - 109) < 1e-9);
    assert.equal(cues[1].text, 'I am doing quite well, thanks.');
  });

  test('no speech regions means the whole chunk is used', () => {
    const cues = buildCuesFromText('Hello there.', [], 5, 4);
    assert.equal(cues.length, 1);
    assert.ok(Math.abs(cues[0].start - 5) < 1e-9);
    assert.ok(Math.abs(cues[0].end - 9) < 1e-9);
  });

  test('hallucinated text produces no cues', () => {
    assert.deepEqual(buildCuesFromText('Thanks for watching', [], 0, 5), []);
  });
});

describe('finalizeCues', () => {
  const input = [
    {start: 0, end: 2, text: 'a'},
    {start: 1, end: 3, text: 'Overlapping cue here'},
    {start: 3.5, end: 3.6, text: 'Short'},
    {start: 5, end: 5, text: '   '},
  ];

  test('removes overlaps, drops empty cues and enforces the minimum duration', () => {
    const snapshot = JSON.stringify(input);
    const out = finalizeCues(input);
    assert.equal(out.length, 3);
    assert.equal(JSON.stringify(input), snapshot, 'input must not change');
    for (let i = 0; i < out.length - 1; i++) {
      assert.ok(out[i].end <= out[i + 1].start - 0.08 + 1e-9, `overlap at ${i}`);
    }
    for (const cue of out) {
      assert.ok(cue.end - cue.start >= 0.8 - 1e-9 || cue.end === out[out.indexOf(cue) + 1]?.start - 0.08, cue.text);
    }
    assert.ok(Math.abs(out[2].end - 4.3) < 1e-9);
  });

  test('a short cue is extended only up to the next cue minus minGap', () => {
    const out = finalizeCues([
      {start: 0, end: 0.1, text: 'Hi'},
      {start: 0.5, end: 2, text: 'Next'},
    ]);
    assert.ok(Math.abs(out[0].end - 0.42) < 1e-9);
  });

  test('duration is clamped to maxDuration', () => {
    const out = finalizeCues([{start: 0, end: 20, text: 'x'}]);
    assert.equal(out[0].end, 7);
  });
});

describe('mergeSeam', () => {
  test('drops new cues that duplicate an overlapping existing cue', () => {
    const existing = [{start: 0, end: 3, text: 'Hello there'}];
    const incoming = [
      {start: 1, end: 2.5, text: 'Hello there'},
      {start: 2.5, end: 4, text: 'Hello there friend'},
      {start: 2.5, end: 4, text: 'Hi'},
      {start: 5, end: 6, text: 'Hello there'},
    ];
    const kept = mergeSeam(existing, incoming);
    assert.deepEqual(kept.map((c) => c.text + '@' + c.start), ['Hi@2.5', 'Hello there@5']);
  });
});

describe('buildCuesFromAlignedText', async () => {
  const {buildCuesFromAlignedText} = await import('../chrome/player/transcription/CueBuilder.mjs');
  const words = (list) => list.map(([word, start, end]) => ({word, start, end}));

  test('times untimed Japanese text with a timed transcript that spells things differently', () => {
    const segments = [
      {start: 0.5, end: 2.0, text: 'いいですね', words: words([['いい', 0.5, 1.0], ['ですね', 1.0, 2.0]])},
      {start: 2.2, end: 4.0, text: '来週の週末はどうですか', words: words([['来週', 2.2, 2.7], ['の', 2.7, 2.8], ['週末', 2.8, 3.3], ['は', 3.3, 3.4], ['どうですか', 3.4, 4.0]])},
      {start: 4.3, end: 7.0, text: '天気が良ければ公園でランチもいいかも', words: words([['天気', 4.3, 4.8], ['が', 4.8, 4.9], ['良ければ', 4.9, 5.6], ['公園', 5.6, 6.0], ['で', 6.0, 6.1], ['ランチ', 6.1, 6.6], ['もいいかも', 6.6, 7.0]])},
    ];
    const text = 'いいですね。来週の週末はどうですか？天気がよければ、公園でらんちもいいかもしれません。';
    const cues = buildCuesFromAlignedText(text, segments, 100);
    assert.ok(cues.length >= 3);
    assert.ok(Math.abs(cues[0].start - 100.5) < 0.05);
    const last = cues[cues.length - 1];
    assert.ok(last.start >= 104.2 && last.start < 104.5, `last starts at ${last.start}`);
    assert.ok(last.end <= 107.1, `last ends at ${last.end}`);
  });

  test('returns null when the timing transcript does not match the text', () => {
    const segments = [{start: 0, end: 2, text: 'hello world', words: words([['hello', 0, 1], ['world', 1, 2]])}];
    assert.strictEqual(buildCuesFromAlignedText('全然違う文章です。', segments, 0), null);
  });

  test('keeps text that aligned to nothing', () => {
    const segments = [{start: 0, end: 3, text: 'good morning everyone', words: words([['good', 0, 0.5], ['morning', 0.5, 1.2], ['everyone', 1.2, 2.0]])}];
    const cues = buildCuesFromAlignedText('Good morning everyone. Zyx qwv.', segments, 0);
    assert.strictEqual(cues.map((c) => c.text).join(' '), 'Good morning everyone. Zyx qwv.');
  });
});

describe('snapCuesToSpeech', async () => {
  const {snapCuesToSpeech} = await import('../chrome/player/transcription/CueBuilder.mjs');
  const regions = [{start: 10.8, end: 13.0}, {start: 13.6, end: 16.2}];

  test('moves an early start (in silence) to the speech onset', () => {
    const [c] = snapCuesToSpeech([{start: 10.0, end: 12.5, text: 'a'}], regions);
    assert.strictEqual(c.start, 10.8);
  });
  test('moves a slightly late start back to the onset', () => {
    const [c] = snapCuesToSpeech([{start: 11.1, end: 12.5, text: 'a'}], regions);
    assert.strictEqual(c.start, 10.8);
  });
  test('extends an early end to the end of the speech run, but not into the next cue', () => {
    const cues = snapCuesToSpeech([{start: 10.8, end: 12.4, text: 'a'}, {start: 12.6, end: 16, text: 'b'}], regions);
    assert.strictEqual(cues[0].end, 12.4);
    const [solo] = snapCuesToSpeech([{start: 10.8, end: 12.4, text: 'a'}], regions);
    assert.strictEqual(solo.end, 13.0);
  });
  test('does not steal an onset used by the previous cue', () => {
    const cues = snapCuesToSpeech([{start: 10.8, end: 11.9, text: 'a'}, {start: 12.0, end: 12.9, text: 'b'}], regions);
    assert.strictEqual(cues[1].start, 12.0);
  });
});

describe('Japanese line breaks', async () => {
  const {wrapText} = await import('../chrome/player/transcription/CueBuilder.mjs');
  test('does not split a kanji from its okurigana', () => {
    const out = wrapText('そうですね、午後から少し雨が降るみたいなので、');
    assert.ok(!out.includes('少\nし'), out);
    assert.ok(out.split('\n').every((l) => Array.from(l).length <= 16), out);
  });
});
