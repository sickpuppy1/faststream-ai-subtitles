# AI subtitles — how it works

Generates subtitles with a speech-to-text API. When the player has already
downloaded audio (HLS, DASH, YouTube, Vimeo, MP4), it transcribes **ahead of
the playhead**, so each line exists before it is spoken. Otherwise (direct
`<video src>` playback, e.g. WebM or local files) it captures the playing audio
live (subtitles lag by about one sentence).

## 1. Flow

1. `FastStreamClient` creates one `TranscriptionEngine` and forwards events to it:
   source loaded (`onSourceReady`), seek (`onSeek`), fragment downloaded
   (`onFragmentUpdate`), the 1 s `tick`, and `play()` (`waitUntilReady`).
2. `TranscriptionEngine.start()` (menu button "Generate subtitles (AI)", or
   auto-start) reads the API key, creates a live `SubtitleTrack`, loads cached
   results, and picks a source:
   - `FragmentAudioSource` for HLS/DASH/YT/VM/MP4: reads fragment bytes from the
     download cache (`DownloadManager`), pins them so they aren't freed mid-read.
     - MPEG-TS segments → `TsAudioDemuxer` pulls out the raw AAC/MP3 stream
       (finds the TS sync byte, so segments disguised as `.jpeg`/`.png` with a
       junk header still work).
     - fMP4/WebM → init segment + media segments are concatenated as is.
     - Progressive MP4 → the AAC frames for the time range are found in the
       file's sample table (parsed by mp4box) and wrapped in 7-byte ADTS
       headers, so they decode without the rest of the file.
     - `AudioDecoder` decodes with WebAudio `decodeAudioData` on a 16 kHz
       `OfflineAudioContext` (the browser resamples), then averages to mono.
   - `LiveAudioTap` for direct sources (and as a fallback): an AudioWorklet
     (`live-tap.worklet.mjs`) taps the player's audio graph before EQ/volume;
     the main thread low-pass filters and resamples to 16 kHz and timestamps
     audio with `video.currentTime`.
3. The engine's `pump()` plans chunks from the playhead forward
   (`planNext`): it reads ~15 s of audio, asks `AudioChunker.findCutPoint` for a
   cut inside a pause, and dispatches up to `concurrency` chunks in parallel.
4. Per chunk (`process`): skip if `detectSpeech` finds < 0.3 s of speech →
   `WavEncoder` (16-bit WAV) → `TranscriptionProvider.transcribe`. With a
   text-only model (default `gpt-transcribe`) a second request to `whisper-1`
   runs in parallel just for word timestamps ("precise timing"):
   - `buildCuesFromAlignedText` aligns the two transcripts character by
     character (edit distance) and gives each line of the accurate text the
     times of the whisper words it matched.
   - `snapCuesToSpeech` then moves each cue start to the real speech onset and
     each end to the end of that speech run (energy detector).
   - The chunk at the playhead doesn't wait for whisper: it is shown with
     estimated timing and re-timed in place when whisper answers.
   Then optional translation (skipped for lines already in the target
   language) → cues are appended to the track and `SubtitlesManager.refreshTrack`
   re-renders.
5. Results are stored in IndexedDB (`TranscriptCache`), keyed by video URL +
   duration + settings, so re-watching costs nothing.
6. `SubtitlesManager` renders once per video frame (`requestVideoFrameCallback`)
   while playing, and skips DOM work when the visible cues didn't change.

## 2. Mechanism (what kind of logic each part is)

| Part | Kind |
|---|---|
| Speech detection, cut points (`AudioChunker`) | Heuristic: frame energy in dBFS vs. a threshold derived from the noise floor (10th percentile + 12 dB). No ML. |
| Transcription | External service (OpenAI, Groq, or any OpenAI-compatible server). Internals unknown to us; we only rely on the documented request/response shape. |
| Translation | External LLM (chat completions, JSON mode). |
| Hallucination filter (`CueBuilder`) | Exact rules: phrase blacklist, repetition-loop detection, plus Whisper's own confidence fields when present. |
| Text-only timing (`buildCuesFromText`) | Heuristic: text pieces spread across detected speech regions in proportion to character count. |
| Word timing (`buildCuesFromSegments`) | Uses the model's word timestamps (whisper models only). |
| Hybrid timing (`buildCuesFromAlignedText`) | Exact algorithm: Levenshtein (edit-distance) alignment of two transcripts; katakana folded to hiragana so spelling choices still match. Falls back to text-only timing when < 40% of characters match exactly. |
| Edge snapping (`snapCuesToSpeech`) | Heuristic: move starts ≤ 1 s forward / ≤ 0.5 s back to an energy onset; extend ends ≤ 1 s to the end of the speech run. |
| Japanese line breaks (`wrapText`) | Heuristic score: balance line lengths, bonus after 、。, penalty for splitting kanji from following hiragana, bonus at hiragana→kanji/katakana. |
| TS demux | Exact parsing of the MPEG-TS format (PAT/PMT/PES). |

Verified on 2026-10-20 against the real OpenAI API: `whisper-1` returns word +
segment timestamps (`verbose_json`); `gpt-transcribe`, `gpt-4o-transcribe` and
`gpt-4o-mini-transcribe` only return `json`/`text` (no timestamps), but
`gpt-transcribe` was the fastest (~0.9 s for 8 s of audio) and most accurate on
Japanese in our test. Groq is configured from its OpenAI-compatible docs and
was **not** tested here.

## 3. Rules and constants

| Constant | Value | Why |
|---|---|---|
| `FIRST_CHUNK` | 2–6 s, target 3.5 s | Short so the first line comes back fast, but ≥ 2 s so it isn't cut inside a phrase (1.2 s produced empty results in testing). |
| `NEXT_CHUNK` | 3–15 s, target 8 s | Long enough for context; cut at the longest pause so chunks line up with sentences (mixed-language chunks were mistimed otherwise). |
| Cut score | `min(pause, 1.5 s) − 0.1 × distance from target` | Long pauses outweigh hitting the target length. |
| `TIMING_MODEL` / `URGENT_TIMING_WAIT_MS` | `whisper-1` / 150 ms | Timing source for text-only models; the playhead chunk waits at most 150 ms for it, then gets re-timed later. |
| `SEEK_BACKOFF_SEC` | 1 s | After a seek, start a bit earlier so the first word isn't cut. |
| `MIN_SPEECH_SEC` | 0.3 s | Chunks with less speech are skipped (saves cost, avoids hallucinations on music/silence). |
| `START_GATE_MAX_MS` | 2.5 s | Longest `play()` waits for the first line (`waitForFirstLine` option). Measured 1.3–2.2 s in testing. |
| `AUTO_START_DELAY_MS` | 300 ms | Grace period for page-provided subtitles before auto-generation starts. |
| `lookaheadSeconds` | 120 (setting) | How far ahead to transcribe; capped by FastStream's buffer-ahead (300 s). |
| `concurrency` | 3 (setting) | Parallel API requests. |
| `MAX_ATTEMPTS` / `RETRY_DELAY_MS` | 3 / 3 s | Retry a failed chunk; 400/401/403/404 stop the engine instead. |
| Chunker: `minSilenceMs` / short pause | 250 / 100 ms | Prefer a real pause; else a gap between words; else the quietest point near the target. |
| Cue limits | 42 chars/line (16 for CJK), 2 lines, 0.8–7 s, 20 cps (8 for CJK) | Common broadcast subtitle rules. |
| Whisper filters | `no_speech_prob > 0.6` and `avg_logprob < -1`, or `compression_ratio > 2.4` | Same defaults as openai/whisper's own decoder. |
| Live tap | 7 s max chunk, emit after 0.45 s of trailing quiet | Keep live lag to about one sentence. |

## 4. Assumptions

- Fragment `start`/`end` times match the video timeline. True for DASH; for HLS
  they are summed `EXTINF` durations, which drift if the stream has
  discontinuities (cues would be offset by the drift).
- Audio is AAC/MP3 (TS) or anything Chrome's `decodeAudioData` handles
  (fMP4/WebM). AC-3/E-AC-3 in TS isn't extracted → engine falls back to live capture.
- DRM-encrypted audio can't be decoded (by design).
- The speech-energy threshold assumes speech is louder than the background.
  Loud music under speech lowers cut quality (cuts still happen, at the quietest point).
- Text-only models give no word timing; cue timing is then approximate (median
  start error ~0.1 s in testing, worse when speech has no pauses).

## 5. Decisions

- **Transcribe from downloaded bytes, not live audio.** Gives negative latency
  and makes pause/seek/speed irrelevant. Live capture is only the fallback.
- **Call the API from the player page, not the background service worker.**
  Chrome serializes extension messages to JSON (an `ArrayBuffer` arrives empty),
  and MV3 service workers can be killed during long requests.
- **API key stored separately (`aiSubtitlesApiKey`)**, so the options Export
  file never contains it.
- **Energy VAD instead of the bundled Silero model** for cutting: deterministic,
  ~1 ms per chunk, no WASM on the main thread. Silero would be better at telling
  speech from music; worth adding later.
- **Rejected:** MediaRecorder upload (compressed, whole-file latency), one big
  upload per video (25 MB limit, minutes of wait), auto-locking the language
  after the first chunk (breaks mixed-language videos).

## 6. Test results (2026-10-20)

`e2e/runner/run.mjs` plays a 204 s Japanese/English test programme (24 lines,
two music-only sections, pink-noise bed) at 1x in Chromium with the unpacked
extension, against the real OpenAI API (`gpt-transcribe` + `whisper-1` timing):

| Packaging | Lines ready before spoken | Japanese CER | English WER | Median start error | Lines invented on music |
|---|---|---|---|---|---|
| HLS MPEG-TS disguised as `.jpeg` (+ seek 60→120 s) | 17/17 | 0.9% | 0% | 0.08 s | 0 |
| HLS fMP4, separate audio | 24/24 | 1.1% | 0% | 0.13 s | 0 |
| Progressive MP4 | 24/24 | 1.1% | 0% | 0.13 s | 0 |
| Obfuscated page (`e2e/site/tough.html`), auto-detected | 24/24 | 1.1% | 0% | 0.08 s | 0 |

CER = character error rate, WER = word error rate (lower is better). The
speech is macOS text-to-speech, which is much easier than real recordings;
expect higher error rates on real, noisy, overlapping speech.
