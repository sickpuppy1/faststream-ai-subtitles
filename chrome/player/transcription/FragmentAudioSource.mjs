import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {ReferenceTypes} from '../enums/ReferenceTypes.mjs';
import {decodeToMono16k, TARGET_SAMPLE_RATE} from './AudioDecoder.mjs';
import {concatBytes, extractTsAudio, isLikelyTs} from './TsAudioDemuxer.mjs';

const FRAGMENT_MODES = [
  PlayerModes.ACCELERATED_MP4,
  PlayerModes.ACCELERATED_HLS,
  PlayerModes.ACCELERATED_DASH,
  PlayerModes.ACCELERATED_YT,
  PlayerModes.ACCELERATED_VM,
];

// Decode one extra fragment before the requested range when the range starts
// this close to a fragment boundary, so codec warm-up never lands on speech.
const PREROLL_SECONDS = 0.5;

// ADTS sampling_frequency_index table (ISO 14496-3).
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Wraps raw AAC frames from an MP4 in 7-byte ADTS headers so decodeAudioData
 * can decode an arbitrary run of frames without the file's moov box.
 */
function buildAdts(frames, objectType, sampleRate, channels) {
  const rateIndex = ADTS_RATES.indexOf(sampleRate);
  if (rateIndex === -1) return null;
  let total = 0;
  for (const f of frames) total += f.length + 7;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const f of frames) {
    const len = f.length + 7;
    out[pos] = 0xFF;
    out[pos + 1] = 0xF1;
    out[pos + 2] = ((objectType - 1) << 6) | (rateIndex << 2) | (channels >> 2);
    out[pos + 3] = ((channels & 3) << 6) | (len >> 11);
    out[pos + 4] = (len >> 3) & 0xFF;
    out[pos + 5] = ((len & 7) << 5) | 0x1F;
    out[pos + 6] = 0xFC;
    out.set(f, pos + 7);
    pos += len;
  }
  return out;
}

/**
 * Reads audio straight out of FastStream's download cache, so audio can be
 * transcribed long before the playhead reaches it.
 */
export class FragmentAudioSource {
  constructor(client) {
    this.client = client;
    this.containerByLevel = new Map();
  }

  static isSupported(client) {
    return FRAGMENT_MODES.includes(client.source?.mode);
  }

  /**
   * Picks the fragment list that carries audio: a separate audio rendition when
   * there is one (DASH, YouTube, HLS with EXT-X-MEDIA audio), else the video
   * fragments (HLS with muxed audio).
   * @return {{levelID: string, fragments: Array, init: Object|null}|null}
   */
  getTrack() {
    const client = this.client;
    const audioLevelID = client.getCurrentAudioLevelID();
    let levelID = null;
    if (audioLevelID !== null && client.getFragments(audioLevelID)?.length) {
      levelID = audioLevelID;
    } else {
      levelID = client.getCurrentVideoLevelID();
    }
    const list = levelID === null ? null : client.getFragments(levelID);
    if (!list) return null;
    // fragmentsStore arrays are indexed by sequence number and can be sparse.
    const fragments = list.filter((f) => f && f.sn !== -1).sort((a, b) => a.start - b.start);
    if (!fragments.length) return null;
    return {levelID, fragments, init: client.getFragment(levelID, -1) || null};
  }

  get duration() {
    return this.client.duration;
  }

  /**
   * Decodes [start, end) of the current audio track to 16 kHz mono PCM.
   * @return {Promise<{status: 'ok', pcm: Float32Array, start: number, end: number}|{status: 'waiting'|'unavailable'}>}
   */
  async read(start, end) {
    if (this.client.source?.mode === PlayerModes.ACCELERATED_MP4) {
      return this.readMp4(start, end);
    }
    const track = this.getTrack();
    if (!track) return {status: 'unavailable'};

    const {fragments, init, levelID} = track;
    let first = fragments.findIndex((f) => f.end > start);
    if (first === -1) return {status: 'unavailable'};
    if (first > 0 && start - fragments[first].start < PREROLL_SECONDS) first--;

    const needed = [];
    for (let i = first; i < fragments.length && fragments[i].start < end; i++) {
      needed.push(fragments[i]);
    }
    const all = init ? [init, ...needed] : needed;
    if (!needed.length || all.some((f) => f.status !== DownloadStatus.DOWNLOAD_COMPLETE)) {
      return {status: 'waiting'};
    }

    // Pin so FastStream's buffer-behind cleanup can't free them mid-read.
    all.forEach((f) => f.addReference(ReferenceTypes.TRANSCRIBER));
    try {
      const parts = [];
      for (const f of all) {
        const entry = this.client.downloadManager.getEntry(f.getContext());
        if (!entry) return {status: 'waiting'};
        parts.push(new Uint8Array(await entry.getDataFromBlob('arraybuffer')));
      }

      const container = this.containerByLevel.get(levelID) || (isLikelyTs(parts[parts.length - 1]) ? 'ts' : 'mp4');
      this.containerByLevel.set(levelID, container);

      let bytes;
      if (container === 'ts') {
        // MPEG-TS can't be decoded by WebAudio; pull out the raw AAC/MP3 stream.
        bytes = concatBytes(parts.map((p) => extractTsAudio(p).data));
      } else {
        bytes = concatBytes(parts);
      }
      if (!bytes.length) return {status: 'unavailable'};

      const pcm = await decodeToMono16k(bytes);
      const pcmStart = needed[0].start;
      const from = Math.max(0, Math.round((start - pcmStart) * TARGET_SAMPLE_RATE));
      const to = Math.min(pcm.length, Math.round((end - pcmStart) * TARGET_SAMPLE_RATE));
      if (to <= from) return {status: 'unavailable'};
      return {
        status: 'ok',
        pcm: pcm.subarray(from, to),
        start: pcmStart + from / TARGET_SAMPLE_RATE,
        end: pcmStart + to / TARGET_SAMPLE_RATE,
      };
    } finally {
      all.forEach((f) => f.removeReference(ReferenceTypes.TRANSCRIBER));
    }
  }

  /**
   * Progressive MP4: the player downloads the file in byte-range fragments, and
   * mp4box has parsed the sample table, so we know exactly where each audio
   * frame of [start, end) lives.
   */
  async readMp4(start, end) {
    const player = this.client.player;
    const audio = player?.audioTracks?.[player.currentAudioTrack || 0];
    const codec = audio?.track?.codec || '';
    const match = /^mp4a\.40\.(\d+)/.exec(codec);
    if (!audio || !match) return {status: 'unavailable'};
    // HE-AAC (5/29) can't be signalled in ADTS; its AAC-LC core still decodes fine.
    const objectType = [5, 29].includes(Number(match[1])) ? 2 : Number(match[1]);
    const sampleRate = audio.track.audio?.sample_rate;
    const channels = audio.track.audio?.channel_count || 2;

    const samples = audio.samples;
    const time = (s) => s.cts / s.timescale;
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (time(samples[mid]) < start - 0.1) lo = mid + 1;
      else hi = mid;
    }
    const picked = [];
    for (let i = lo; i < samples.length && time(samples[i]) < end; i++) picked.push(samples[i]);
    if (!picked.length) return {status: 'unavailable'};

    const levelID = this.client.getCurrentVideoLevelID();
    const fragments = (this.client.getFragments(levelID) || []).filter(Boolean);
    if (!fragments.length) return {status: 'waiting'};
    const fragSize = fragments[0].rangeEnd - fragments[0].rangeStart;
    const firstByte = picked[0].offset;
    const lastByte = picked[picked.length - 1].offset + picked[picked.length - 1].size;
    const needed = [];
    for (let i = Math.floor(firstByte / fragSize); i <= Math.floor((lastByte - 1) / fragSize); i++) {
      const f = this.client.getFragment(levelID, i);
      if (!f || f.status !== DownloadStatus.DOWNLOAD_COMPLETE) return {status: 'waiting'};
      needed.push(f);
    }

    needed.forEach((f) => f.addReference(ReferenceTypes.TRANSCRIBER));
    try {
      const parts = [];
      for (const f of needed) {
        const entry = this.client.downloadManager.getEntry(f.getContext());
        if (!entry) return {status: 'waiting'};
        parts.push(new Uint8Array(await entry.getDataFromBlob('arraybuffer')));
      }
      const region = concatBytes(parts);
      const regionStart = needed[0].rangeStart;
      const frames = picked.map((s) => region.subarray(s.offset - regionStart, s.offset - regionStart + s.size));
      const adts = buildAdts(frames, objectType, sampleRate, channels);
      if (!adts) return {status: 'unavailable'};

      const pcm = await decodeToMono16k(adts);
      const pcmStart = time(picked[0]);
      const from = Math.max(0, Math.round((start - pcmStart) * TARGET_SAMPLE_RATE));
      const to = Math.min(pcm.length, Math.round((end - pcmStart) * TARGET_SAMPLE_RATE));
      if (to <= from) return {status: 'unavailable'};
      return {
        status: 'ok',
        pcm: pcm.subarray(from, to),
        start: pcmStart + from / TARGET_SAMPLE_RATE,
        end: pcmStart + to / TARGET_SAMPLE_RATE,
      };
    } finally {
      needed.forEach((f) => f.removeReference(ReferenceTypes.TRANSCRIBER));
    }
  }

  destroy() {
    this.containerByLevel.clear();
  }
}
