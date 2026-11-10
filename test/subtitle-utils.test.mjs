import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SubtitleUtils} from '../chrome/player/utils/SubtitleUtils.mjs';

test('srt2webvtt converts cues that have no cue number', () => {
  const srt = '00:00:01,000 --> 00:00:02,500\nHello\n\n00:00:03,000 --> 00:00:04,000\nWorld';
  const vtt = SubtitleUtils.srt2webvtt(srt);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500\nHello/);
  assert.match(vtt, /00:00:03\.000 --> 00:00:04\.000\nWorld/);
});

test('srt2webvtt keeps cue numbers and accepts a dot as millisecond separator', () => {
  const srt = '1\n00:00:01.250 --> 00:00:02.750\nFirst\n\n2\n00:00:05,100 --> 00:00:06,000\nSecond';
  const vtt = SubtitleUtils.srt2webvtt(srt);
  assert.match(vtt, /00:00:01\.250 --> 00:00:02\.750\nFirst/);
  assert.match(vtt, /00:00:05\.100 --> 00:00:06\.000\nSecond/);
});

test('srt2webvtt pads missing milliseconds', () => {
  const srt = '00:00:05 --> 00:00:07.5\nNo ms';
  const vtt = SubtitleUtils.srt2webvtt(srt);
  assert.match(vtt, /00:00:05\.000 --> 00:00:07\.500\nNo ms/);
});

test('srt2webvtt handles CRLF line endings and multi-line text', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nline one\r\nline two\r\n';
  const vtt = SubtitleUtils.srt2webvtt(srt);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000\nline one\nline two/);
});

test('negative times are clamped to zero', () => {
  assert.equal(SubtitleUtils.srtTimeFormat(-0.2), '00:00:00,000');
  assert.equal(SubtitleUtils.formatVttTime(-5), '00:00:00.000');
  assert.equal(SubtitleUtils.formatVttTime(NaN), '00:00:00.000');
});

test('milliseconds are rounded and carry into seconds', () => {
  assert.equal(SubtitleUtils.formatVttTime(1.9996), '00:00:02.000');
  assert.equal(SubtitleUtils.srtTimeFormat(1.9996), '00:00:02,000');
  assert.equal(SubtitleUtils.formatVttTime(59.9999), '00:01:00.000');
  assert.equal(SubtitleUtils.formatVttTime(3599.9999), '01:00:00.000');
});

test('formatVttTime and srtTimeFormat produce HH:MM:SS with milliseconds', () => {
  assert.equal(SubtitleUtils.formatVttTime(3723.456), '01:02:03.456');
  assert.equal(SubtitleUtils.srtTimeFormat(3723.456), '01:02:03,456');
  assert.equal(SubtitleUtils.vttTimeFormat(3723.456), '01:02:03.456');
});

test('cuesToVtt writes a WEBVTT document with one block per cue', () => {
  const vtt = SubtitleUtils.cuesToVtt([
    {startTime: 1, endTime: 2.5, text: 'Hi'},
    {startTime: 3, endTime: 4, text: 'There'},
  ]);
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHi\n\n00:00:03.000 --> 00:00:04.000\nThere\n\n');
});

test('cuesToVtt escapes --> inside text and collapses blank lines', () => {
  const vtt = SubtitleUtils.cuesToVtt([
    {startTime: 0, endTime: 1, text: 'a --> b\n\n\nc'},
  ]);
  assert.equal(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na → b\nc\n\n');
  assert.equal(vtt.split('-->').length - 1, 1);
});

test('cuesToVtt matches srt2webvtt output for a cue without a number', () => {
  // srt2webvtt keeps cue numbers as VTT identifiers, so use a number-less cue here
  const srt = '00:00:01,000 --> 00:00:02,000\nHello\n';
  const cues = [{startTime: 1, endTime: 2, text: 'Hello'}];
  assert.equal(SubtitleUtils.cuesToVtt(cues), SubtitleUtils.srt2webvtt(srt));
});
