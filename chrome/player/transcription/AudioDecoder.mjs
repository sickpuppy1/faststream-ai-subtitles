export const TARGET_SAMPLE_RATE = 16000;

let decodeContext = null;

function getDecodeContext() {
  if (!decodeContext) {
    // decodeAudioData resamples to the context's rate, so a 16 kHz offline
    // context gives us speech-model-ready audio without a separate resampler.
    decodeContext = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  }
  return decodeContext;
}

/**
 * Decodes a compressed audio stream (MP4/fMP4, WebM, ADTS AAC, MP3) to 16 kHz mono PCM.
 * @param {Uint8Array} bytes
 * @return {Promise<Float32Array>}
 */
export async function decodeToMono16k(bytes) {
  // decodeAudioData detaches the buffer it is given, so hand it a private copy.
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audioBuffer = await getDecodeContext().decodeAudioData(copy);
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const out = new Float32Array(audioBuffer.length);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      out[i] += data[i];
    }
  }
  const scale = 1 / channels;
  for (let i = 0; i < out.length; i++) {
    out[i] *= scale;
  }
  return out;
}
