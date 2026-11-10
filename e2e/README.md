# e2e test environment

Synthetic video programme with exact ground truth, packaged as HLS, disguised HLS, fMP4 HLS, DASH and MP4, plus a static server and test pages.

## Regenerate fixtures

Needs `ffmpeg`/`ffprobe` in `/usr/local/bin` (libx264, aac, drawtext) and macOS `say` (voices Kyoko and Samantha). No npm packages.

```sh
node e2e/fixtures/make-fixtures.mjs
```

Output goes to `e2e/fixtures/out/` (git-ignored). The run takes about 35 s and ends with a verification table. It exits non-zero if a check fails.

Key outputs:

- `out/groundtruth.json`: `{duration, utterances:[{start,end,text,lang}], music:[{start,end}]}`. Times are seconds on the final timeline, placed at exact sample positions (48 kHz).
- `out/mp4/video.mp4`: the master (H.264 High 3.1, AAC 128k 48 kHz, GOP 100 closed). All packagings are `-c copy` from it.
- `out/work/`: intermediate files, plus a server log and sample frames.

## Run the server

```sh
node e2e/server.mjs --port 8765            # serves e2e/ on 8765 and 8766
LATENCY_MS=60 THROTTLE_KBPS=0 node e2e/server.mjs
```

Open `http://localhost:8765/site/index.html`.

- CORS on every response, OPTIONS preflight returns 204.
- Range requests return 206 with Content-Range. Invalid ranges return 416.
- `.jpeg` segments are served as `image/jpeg`, the same as real sites do.
- `LATENCY_MS` (default 60) delays every response. `THROTTLE_KBPS` (default off) limits body speed.
- Each request is logged: method, path, range, status, time.
- Port+1 serves the same tree, so `tough-iframe.html` embeds `tough.html` cross-origin.

## What each packaging tests

| Path | Tests |
|---|---|
| `hls-ts/master.m3u8` → `video.m3u8` | Plain HLS with MPEG-TS, audio muxed in. Master has `CODECS` and `RESOLUTION`. |
| `hls-ts-disguised/` | Same TS, but segments are `segNNN.jpeg` with a 100-byte PNG prefix. Tests whether the extension finds TS inside an image-typed file. hls.js does not parse this, on purpose. |
| `hls-fmp4/master.m3u8` | fMP4 HLS with a separate audio rendition (`EXT-X-MEDIA TYPE=AUDIO`, GROUP-ID `group_aud`). |
| `dash/manifest.mpd` | DASH with separate video and audio adaptation sets (SegmentTimeline). |
| `mp4/video.mp4` | Progressive MP4 with `+faststart`. Used by `plain-mp4.html`. |

## Pages (`e2e/site/`)

- `index.html`: links to every page and manifest.
- `tough.html`: nested divs, overlays, an ad banner, a fake control bar. The HLS URL is built at runtime from shuffled base64 fragments. Plays `hls-ts-disguised` with the vendored hls.js (`vendor/hls.mjs`, copied unmodified from `chrome/player/modules/hls.mjs`). Logs the URL and hls.js errors to the console.
- `tough-iframe.html`: iframe with `tough.html` from port+1.
- `plain-mp4.html`: `<video controls>` with `mp4/video.mp4`.

## Checks

The generator prints these:

- Each packaging's duration is within 0.2 s of `groundtruth.duration`. For DASH, the check reads the MPD's video SegmentTimeline. ffprobe's DASH demuxer reports about 0.9 s short for this file, so it is not used.
- Each disguised segment starts with the PNG signature, the PNG ends at its IEND chunk, and every 188-byte TS packet after it starts with `0x47`.
