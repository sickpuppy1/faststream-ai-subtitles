import {WebVTT} from './modules/vtt.mjs';
import {SubtitleUtils} from './utils/SubtitleUtils.mjs';

export class SubtitleTrack {
  static nextId = 1;

  constructor(label, language) {
    this.id = SubtitleTrack.nextId++;
    this.label = label;
    this.language = language;
    this.kind = 'user'; // 'user' or 'ai'
    this.isLive = false; // live tracks grow while audio is transcribed, so they are never deduped
    this.cues = [];
    this.regions = [];
  }

  /**
   * Creates a cue object that the subtitle renderer understands.
   * @param {number} start - Start time in seconds.
   * @param {number} end - End time in seconds.
   * @param {string} text - Cue text (WebVTT markup allowed).
   * @return {VTTCue} The cue.
   */
  static makeCue(start, end, text) {
    return new window.VTTCue(start, end, text);
  }

  /**
   * Adds cues and keeps this.cues sorted by startTime.
   * @param {Array} cues - Cues to add.
   */
  appendCues(cues) {
    if (!cues.length) return;
    const firstNew = Math.max(1, this.cues.length);
    this.cues.push(...cues);

    // only check from the first new cue; earlier cues were already sorted
    for (let i = firstNew; i < this.cues.length; i++) {
      if (this.cues[i - 1].startTime > this.cues[i].startTime) {
        this.cues.sort((a, b) => a.startTime - b.startTime);
        break;
      }
    }
  }

  /**
   * Removes cues whose startTime is in [start, end).
   * @param {number} start - Range start in seconds (inclusive).
   * @param {number} end - Range end in seconds (exclusive).
   * @return {number} How many cues were removed.
   */
  removeCuesInRange(start, end) {
    const before = this.cues.length;
    this.cues = this.cues.filter((cue) => {
      return !(cue.startTime >= start && cue.startTime < end);
    });
    return before - this.cues.length;
  }

  clear() {
    this.cues = [];
  }

  loadURL(url) {
    return fetch(url).then((response) => {
      return response.text();
    }).then((text) => {
      this.loadText(text);
    });
  }

  shift(time) {
    this.cues.forEach((cue) => {
      cue.startTime += time;
      cue.endTime += time;
    });
  }

  loadText(text) {
    // replace, don't append, so reloading a track does not duplicate its cues
    this.cues = [];
    this.regions = [];

    if (text.substring(0, 5) === '<?xml') {
      text = SubtitleUtils.xml2vtt(text);
    } else if (text.trim().split('\n')[0].trim().substr(0, 6) !== 'WEBVTT') {
      text = SubtitleUtils.srt2webvtt(text);
    }

    // sometimes formatting in subtitles are not properly 
    // converted into webvtt, so we need to convert them manually
    text = SubtitleUtils.convertSubtitleFormatting(text)

    // eslint-disable-next-line new-cap
    const parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
    parser.onregion = (region) => {
      this.regions.push(region);
    };

    parser.oncue = (cue) => {
      this.cues.push(cue);
    };

    parser.onflush = () => {
      this.cues.sort((a, b) => {
        return a.startTime - b.startTime;
      });
    };

    parser.onparsingerror = (error) => {
      console.error(error);
    };

    parser.parse(text);
    parser.flush();
  }

  equals(otherTrack) {
    // live tracks change over time, so only the same object counts as equal
    if (this.isLive || otherTrack.isLive) {
      return this === otherTrack;
    }

    if (this.label !== otherTrack.label || this.language !== otherTrack.language) {
      return false;
    }

    if (this.cues.length !== otherTrack.cues.length) {
      return false;
    }

    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const otherCue = otherTrack.cues[i];

      if (cue.startTime !== otherCue.startTime || cue.endTime !== otherCue.endTime || cue.text !== otherCue.text) {
        return false;
      }
    }

    return true;
  }
}
