/**
 * MPEG-TS audio demuxer.
 *
 * An MPEG transport stream (.ts, used by HLS) is a sequence of 188-byte
 * packets. Each packet carries a PID (a number naming which elementary
 * stream it belongs to). Audio is spread over many packets as PES
 * (Packetized Elementary Stream) packets. This module finds the audio PID,
 * strips the TS and PES headers, and returns the raw audio bytes
 * (ADTS AAC or MPEG audio frames) that WebAudio can decode.
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const SYNC_SEARCH_LIMIT = 65536;
const PAT_PID = 0;
const STREAM_TYPE_AAC_ADTS = 0x0f;
const STREAM_TYPE_MPEG1_AUDIO = 0x03;
const STREAM_TYPE_MPEG2_AUDIO = 0x04;
const PTS_CLOCK_HZ = 90000;
const TWO_POW_15 = 32768;
const TWO_POW_30 = 1073741824;

/**
 * Finds where the first TS packet starts, skipping any junk prefix.
 * @param {Uint8Array} bytes Input bytes.
 * @return {number} Byte offset of the first packet, or -1 if none found.
 */
export function findTsSyncOffset(bytes) {
  const n = bytes.length;
  const limit = Math.min(n, SYNC_SEARCH_LIMIT);
  // Fewer bytes means fewer packets can be checked, so accept less proof.
  let required = 3;
  if (n < 2 * TS_PACKET_SIZE) required = 1;
  else if (n < 3 * TS_PACKET_SIZE) required = 2;
  for (let o = 0; o < limit; o++) {
    if (bytes[o] !== TS_SYNC_BYTE) continue;
    let matches = 1;
    let ok = true;
    for (let k = 1; k < 3; k++) {
      const idx = o + k * TS_PACKET_SIZE;
      if (idx >= n) break;
      if (bytes[idx] !== TS_SYNC_BYTE) {
        ok = false;
        break;
      }
      matches++;
    }
    if (ok && matches >= required) return o;
  }
  return -1;
}

/**
 * Checks whether the bytes look like an MPEG transport stream.
 * @param {Uint8Array} bytes Input bytes.
 * @return {boolean} True if a TS sync pattern is found.
 */
export function isLikelyTs(bytes) {
  return findTsSyncOffset(bytes) >= 0;
}

/**
 * Joins several byte arrays into one new array, in order.
 * @param {Uint8Array[]} arrays Arrays to join.
 * @return {Uint8Array} A new array holding all bytes.
 */
export function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Extracts the audio elementary stream from an MPEG-TS buffer.
 * Never throws: on bad input it returns codec null and empty data.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @return {{codec: ('aac'|'mp3'|null), data: Uint8Array,
 *   firstPts: (number|null), pid: (number|null)}} Audio stream info.
 */
export function extractTsAudio(bytes) {
  try {
    return extractUnsafe(bytes);
  } catch {
    return emptyResult();
  }
}

function emptyResult() {
  return {codec: null, data: new Uint8Array(0), firstPts: null, pid: null};
}

function extractUnsafe(bytes) {
  if (!(bytes instanceof Uint8Array)) return emptyResult();
  const start = findTsSyncOffset(bytes);
  if (start < 0) return emptyResult();

  const audio = resolveAudioPid(bytes, start);
  if (!audio) return emptyResult();

  const n = bytes.length;
  // One slot per possible packet, so the range list never needs to grow.
  const maxRanges = Math.floor(n / TS_PACKET_SIZE) + 1;
  const ranges = new Int32Array(maxRanges * 2);
  let count = 0;
  let total = 0;
  let started = false;
  let firstPts = null;

  for (let p = start; p >= 0; p = nextPacketStart(bytes, p + 188)) {
    if (packetPid(bytes, p) !== audio.pid) continue;
    const ps = payloadStartOf(bytes, p);
    if (ps < 0) continue;
    const next = p + TS_PACKET_SIZE;
    let from;
    if (bytes[p + 1] & 0x40) {
      // payload_unit_start_indicator: a new PES packet begins here.
      const data = pesDataStart(bytes, ps, next);
      if (data < 0) {
        started = false;
        continue;
      }
      if (firstPts === null) firstPts = readPts(bytes, ps, next);
      from = data;
      started = true;
    } else {
      if (!started) continue;
      from = ps;
    }
    if (from >= next) continue;
    ranges[count * 2] = from;
    ranges[count * 2 + 1] = next;
    count++;
    total += next - from;
  }

  const data = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const from = ranges[i * 2];
    const to = ranges[i * 2 + 1];
    data.set(bytes.subarray(from, to), off);
    off += to - from;
  }
  return {codec: audio.codec, data, firstPts, pid: audio.pid};
}

/**
 * Walks packets until the audio PID is known. Uses the PAT (PID 0) to find
 * the PMT, then the PMT's stream types. If that fails, falls back to the
 * first PES packet with an audio stream_id (0xC0-0xDF) and sniffs its codec.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} start Offset of the first packet.
 * @return {{pid: number, codec: string}|null} Audio PID and codec.
 */
function resolveAudioPid(bytes, start) {
  let pmtPid = -1;
  let fallback = null;
  for (let p = start; p >= 0; p = nextPacketStart(bytes, p + 188)) {
    const ps = payloadStartOf(bytes, p);
    if (ps < 0) continue;
    const next = p + TS_PACKET_SIZE;
    const pid = packetPid(bytes, p);
    const pusi = (bytes[p + 1] & 0x40) !== 0;
    if (pid === PAT_PID && pusi && pmtPid < 0) {
      const s = sectionOffset(bytes, ps, next);
      if (s >= 0) pmtPid = parsePat(bytes, s, next);
    } else if (pmtPid >= 0 && pid === pmtPid && pusi) {
      const s = sectionOffset(bytes, ps, next);
      const found = s >= 0 ? parsePmt(bytes, s, next) : null;
      if (found) return found;
    } else if (fallback === null && pusi && pid !== PAT_PID) {
      if (isAudioPesStart(bytes, ps, next)) {
        fallback = {pid, ps, next};
      }
    }
  }
  if (!fallback) return null;
  const d = pesDataStart(bytes, fallback.ps, fallback.next);
  const codec = d >= 0 && isAdtsSync(bytes, d, fallback.next) ? 'aac' : 'mp3';
  return {pid: fallback.pid, codec};
}

/**
 * Returns the packet's byte offset if it is a sync byte, else -1.
 * Searches forward for the next offset that starts a full packet and is
 * followed by another sync byte (or ends the buffer exactly).
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} p Offset to start searching from.
 * @return {number} Offset of the next packet start, or -1.
 */
function nextPacketStart(bytes, p) {
  const n = bytes.length;
  for (let q = p; q + TS_PACKET_SIZE <= n; q++) {
    if (bytes[q] !== TS_SYNC_BYTE) continue;
    const after = q + TS_PACKET_SIZE;
    if (after === n || bytes[after] === TS_SYNC_BYTE) return q;
  }
  return -1;
}

function packetPid(bytes, p) {
  return ((bytes[p + 1] & 0x1f) << 8) | bytes[p + 2];
}

/**
 * Returns where the TS payload starts, or -1 if the packet has no usable
 * payload (transport error, adaptation-only, reserved, or bad length).
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} p Packet start offset.
 * @return {number} Payload start offset, or -1.
 */
function payloadStartOf(bytes, p) {
  if (bytes[p + 1] & 0x80) return -1; // transport_error_indicator
  const afc = (bytes[p + 3] >> 4) & 0x03;
  if (afc === 0 || afc === 2) return -1; // reserved, or adaptation only
  let start = p + 4;
  if (afc === 3) {
    const afLen = bytes[p + 4];
    if (afLen > 183) return -1;
    start = p + 5 + afLen;
  }
  return start < p + TS_PACKET_SIZE ? start : -1;
}

/**
 * Reads a PSI section start from a payload that begins with pointer_field.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} ps Payload start.
 * @param {number} end Packet end.
 * @return {number} Section start offset, or -1.
 */
function sectionOffset(bytes, ps, end) {
  const s = ps + 1 + bytes[ps];
  return s < end ? s : -1;
}

/**
 * Parses a PAT section and returns the PMT PID of the first real program.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} s Section start.
 * @param {number} end Packet end.
 * @return {number} PMT PID, or -1.
 */
function parsePat(bytes, s, end) {
  if (bytes[s] !== 0x00) return -1;
  const sectionLength = ((bytes[s + 1] & 0x0f) << 8) | bytes[s + 2];
  const bodyEnd = Math.min(s + 3 + sectionLength - 4, end); // minus CRC
  for (let i = s + 8; i + 4 <= bodyEnd; i += 4) {
    const programNumber = (bytes[i] << 8) | bytes[i + 1];
    if (programNumber !== 0) {
      return ((bytes[i + 2] & 0x1f) << 8) | bytes[i + 3];
    }
  }
  return -1;
}

/**
 * Parses a PMT section and returns the first audio elementary stream.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} s Section start.
 * @param {number} end Packet end.
 * @return {{pid: number, codec: string}|null} Audio stream, or null.
 */
function parsePmt(bytes, s, end) {
  if (bytes[s] !== 0x02) return null;
  const sectionLength = ((bytes[s + 1] & 0x0f) << 8) | bytes[s + 2];
  const programInfoLength = ((bytes[s + 10] & 0x0f) << 8) | bytes[s + 11];
  const bodyEnd = Math.min(s + 3 + sectionLength - 4, end); // minus CRC
  let i = s + 12 + programInfoLength;
  while (i + 5 <= bodyEnd) {
    const type = bytes[i];
    const pid = ((bytes[i + 1] & 0x1f) << 8) | bytes[i + 2];
    const esInfoLength = ((bytes[i + 3] & 0x0f) << 8) | bytes[i + 4];
    if (type === STREAM_TYPE_AAC_ADTS) return {pid, codec: 'aac'};
    if (type === STREAM_TYPE_MPEG1_AUDIO || type === STREAM_TYPE_MPEG2_AUDIO) {
      return {pid, codec: 'mp3'};
    }
    i += 5 + esInfoLength;
  }
  return null;
}

/**
 * Checks for a PES start with an audio stream_id (0xC0-0xDF).
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} ps Payload start.
 * @param {number} end Packet end.
 * @return {boolean} True if the payload starts an audio PES packet.
 */
function isAudioPesStart(bytes, ps, end) {
  if (ps + 4 > end) return false;
  if (bytes[ps] !== 0 || bytes[ps + 1] !== 0 || bytes[ps + 2] !== 1) {
    return false;
  }
  const id = bytes[ps + 3];
  return id >= 0xc0 && id <= 0xdf;
}

/**
 * Returns the offset where ES data starts after a PES header, or -1.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} ps PES start (the 0x000001 prefix).
 * @param {number} end Packet end.
 * @return {number} Offset of the first ES byte, or -1.
 */
function pesDataStart(bytes, ps, end) {
  if (ps + 9 > end) return -1;
  if (bytes[ps] !== 0 || bytes[ps + 1] !== 0 || bytes[ps + 2] !== 1) {
    return -1;
  }
  const data = ps + 9 + bytes[ps + 8]; // 9 fixed bytes + header_data_length
  return data <= end ? data : -1;
}

/**
 * Reads the PTS from a PES header, in seconds. Returns null if absent.
 * @param {Uint8Array} bytes MPEG-TS bytes.
 * @param {number} ps PES start.
 * @param {number} end Packet end.
 * @return {number|null} PTS in seconds, or null.
 */
function readPts(bytes, ps, end) {
  if (ps + 14 > end) return null;
  if (((bytes[ps + 7] >> 6) & 0x03) < 2) return null; // no PTS flag
  // PTS is 33 bits in 5 bytes, with a marker bit after each field.
  const hi = (bytes[ps + 9] >> 1) & 0x07;
  const mid = (bytes[ps + 10] << 7) | (bytes[ps + 11] >> 1);
  const lo = (bytes[ps + 12] << 7) | (bytes[ps + 13] >> 1);
  const ticks = hi * TWO_POW_30 + mid * TWO_POW_15 + lo;
  return ticks / PTS_CLOCK_HZ;
}

/**
 * True if the bytes at offset start with an ADTS header
 * (12-bit 0xFFF sync, layer bits 00). MPEG audio frames also start with
 * 0xFF, so the layer check is what tells them apart.
 * @param {Uint8Array} bytes Audio bytes.
 * @param {number} d Offset to check.
 * @param {number} end Limit.
 * @return {boolean} True if ADTS sync is present.
 */
function isAdtsSync(bytes, d, end) {
  if (d + 1 >= end) return false;
  return bytes[d] === 0xff && (bytes[d + 1] & 0xf6) === 0xf0;
}
