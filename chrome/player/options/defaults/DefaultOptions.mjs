import {YoutubeClients} from '../../enums/YoutubeClients.mjs';
import {EnvUtils} from '../../utils/EnvUtils.mjs';
import {ClickActions} from './ClickActions.mjs';
import {ColorThemes} from './ColorThemes.mjs';
import {DaltonizerTypes} from './DaltonizerTypes.mjs';
import {DefaultKeybinds} from './DefaultKeybinds.mjs';
import {MiniplayerPositions} from './MiniplayerPositions.mjs';
import {VisChangeActions} from './VisChangeActions.mjs';

export const DefaultOptions = {
  dev: false,
  replaceDelay: 500,
  playMP4URLs: false,
  playStreamURLs: false,
  analyzeVideos: false,
  downloadAll: true,
  previewEnabled: true,
  autoEnableBestSubtitles: false,
  storeProgress: true,
  autoplayYoutube: EnvUtils.isExtension(),
  autoplayNext: false,
  defaultYoutubeClient: YoutubeClients.WEB,
  defaultQuality: `Auto`,
  colorTheme: ColorThemes.DEFAULT,
  autoEnableURLs: [],
  customSourcePatterns: ``,
  keybinds: DefaultKeybinds,
  videoBrightness: 1,
  videoContrast: 1,
  videoSaturation: 1,
  videoGrayscale: 0,
  videoSepia: 0,
  videoInvert: 0,
  videoHueRotate: 0,
  videoDaltonizerType: DaltonizerTypes.NONE,
  videoDaltonizerStrength: 1,
  videoZoom: 1,
  maxSpeed: -1,
  maxVideoSize: 5000000000, // 5GB max size
  seekStepSize: 2,
  singleClickAction: ClickActions.PLAY_PAUSE,
  doubleClickAction: ClickActions.FULLSCREEN,
  tripleClickAction: ClickActions.HIDE_CONTROLS,
  visChangeAction: VisChangeActions.NOTHING,
  miniSize: 0.25,
  miniPos: MiniplayerPositions.BOTTOM_RIGHT,
  videoDelay: 0,
  maximumDownloaders: 6,
  youtubePlayerID: '',
  aiSubtitles: {
    autoGenerate: false, // start automatically when a video has no subtitles
    waitForFirstLine: true, // on play, wait (max 2.5 s) until the line at the playhead is ready
    preciseTiming: true, // OpenAI text-only models: also ask whisper-1 for word timestamps
    provider: 'openai', // 'openai' | 'groq' | 'custom'
    baseUrl: '', // custom OpenAI-compatible endpoint, e.g. http://127.0.0.1:8080/v1
    model: '', // '' = provider default
    language: '', // spoken language ISO 639-1, '' = auto-detect
    translateTo: '', // '' = off, else target language name, e.g. 'English'
    translateModel: '', // '' = provider default
    lookaheadSeconds: 120, // how far ahead of playback to transcribe
    concurrency: 3, // parallel requests
  },
};
