import {EventEmitter} from '../../modules/eventemitter.mjs';
import {Localize} from '../../modules/Localize.mjs';
import {WebVTT} from '../../modules/vtt.mjs';
import {SubtitleTrack} from '../../SubtitleTrack.mjs';
import {AlertPolyfill} from '../../utils/AlertPolyfill.mjs';
import {RequestUtils} from '../../utils/RequestUtils.mjs';
import {SubtitleUtils} from '../../utils/SubtitleUtils.mjs';
import {Utils} from '../../utils/Utils.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {OpenSubtitlesSearch, OpenSubtitlesSearchEvents} from './OpenSubtitlesSearch.mjs';
import {SubtitlesSettingsManager, SubtitlesSettingsManagerEvents} from './SubtitlesSettingsManager.mjs';
import {SubtitleSyncer} from './SubtitleSyncer.mjs';

export class SubtitlesManager extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;

    this.tracks = [];
    this.activeTracks = [];
    this.isTestSubtitleActive = false;

    this.aiButton = null;
    this.transcriptionEngine = null;
    this.renderLoopCancel = null;

    this.subtitleTrackListElements = [];
    this.subtitleTrackDisplayElements = [];

    this.settingsManager = new SubtitlesSettingsManager();
    this.settingsManager.on(SubtitlesSettingsManagerEvents.SETTINGS_CHANGED, this.onSettingsChanged.bind(this));
    this.settingsManager.loadSettings();

    this.openSubtitlesSearch = new OpenSubtitlesSearch(client.version);
    this.openSubtitlesSearch.on(OpenSubtitlesSearchEvents.TRACK_DOWNLOADED, this.onSubtitleTrackDownloaded.bind(this));

    this.subtitleSyncer = new SubtitleSyncer(client);

    this.setupUI();
  }

  loadTrackAndActivateBest(subtitleTrack, autoset = false) {
    const returnedTrack = this.addTrack(subtitleTrack);
    if (returnedTrack !== subtitleTrack) {
      return returnedTrack;
    }

    const defLang = this.settingsManager.getSettings().defaultLanguage;
    if (autoset && this.activeTracks.length <= 1 && this.client.options.autoEnableBestSubtitles) {
      if (Localize.getLanguageMatchLevel(subtitleTrack.language, defLang) > 0) {
        // check if active tracks exist with same language
        const existingActive = this.activeTracks.find((t) => {
          return t.language && subtitleTrack.language && t.language.substring(0, defLang.length) === defLang;
        });
        if (!existingActive) {
          this.activateTrack(subtitleTrack);
        } else {
          // Check if existing has "auto" in label, if new one doesn't, prefer new one
          if (existingActive.label && existingActive.label.toLowerCase().includes('auto') &&
              subtitleTrack.label && !subtitleTrack.label.toLowerCase().includes('auto')) {
            this.deactivateTrack(existingActive);
            this.activateTrack(subtitleTrack);
          }
        }
      }
    }

    return returnedTrack;
  }

  addTrack(track) {
    const existing = this.tracks.find((t) => t.equals(track));
    if (existing) {
      return existing;
    }

    this.tracks.push(track);

    this.updateTrackList();
    this.client.interfaceController.showControlBar();
    this.client.interfaceController.queueControlsHide(1000);

    return track;
  }

  activateTrack(track) {
    if (this.tracks.indexOf(track) === -1) {
      console.error('Cannot activate track that is not loaded', track);
      return;
    }

    if (this.activeTracks.indexOf(track) === -1) {
      this.activeTracks.push(track);
      this.updateTrackList();
    }
  }

  deactivateTrack(track) {
    const ind = this.activeTracks.indexOf(track);
    if (ind !== -1) {
      this.activeTracks.splice(ind, 1);
      this.updateTrackList();
    }
  }

  toggleSubtitles() {
    if (this.activeTracks.length === 0) {
      if (this.lastActiveTracks) {
        this.lastActiveTracks.forEach((track) => {
          this.activateTrack(track);
        });
        this.lastActiveTracks = null;
      } else {
        this.activateTrack(this.tracks[0]);
      }
    } else {
      this.lastActiveTracks = this.activeTracks.slice();
      this.activeTracks.length = 0;
      this.updateTrackList();
    }
  }

  clearTracks() {
    this.tracks.length = 0;
    this.activeTracks.length = 0;
    this.updateTrackList();
    this.subtitleSyncer.stop();
  }

  removeTrack(track) {
    let ind = this.tracks.indexOf(track);
    if (ind !== -1) this.tracks.splice(ind, 1);
    ind = this.activeTracks.indexOf(track);
    if (ind !== -1) this.activeTracks.splice(ind, 1);
    this.updateTrackList();
    this.subtitleSyncer.toggleTrack(track, true);
  }

  onSettingsChanged(settings) {
    this.openSubtitlesSearch.setLanguageInputValue(settings.defaultLanguage);
    this.refreshSubtitleStyles();
    this.renderSubtitles(true);
  }

  /**
   * Connects an AI transcription engine to the "AI subtitles" menu button.
   * The engine must emit 'state' events with {enabled, status, message?}
   * and have a toggle() method.
   * @param {Object} engine - The transcription engine.
   */
  bindTranscriptionEngine(engine) {
    this.transcriptionEngine = engine;
    engine.on('state', (state) => this.updateAIButton(state));
  }

  /**
   * Updates the AI subtitles button label and shows errors.
   * @param {Object} state - {enabled: boolean, status: 'idle'|'working'|'error', message?: string}
   */
  updateAIButton(state) {
    if (!this.aiButton) return;

    const label = Localize.getMessage(state.enabled ? 'player_aisubs_stop' : 'player_aisubs_start');
    this.aiButton.textContent = state.enabled && state.status === 'working' ? label + ' …' : label;

    if (state.status === 'error' && state.message) {
      AlertPolyfill.toast('error', state.message);
    }
  }

  /**
   * Called when a track's cues change (for example while AI subtitles stream in).
   * Re-renders if the track is on screen; refreshes the list only when the
   * track went from no cues to some cues.
   * @param {SubtitleTrack} track - The changed track.
   */
  refreshTrack(track) {
    if (this.activeTracks.indexOf(track) !== -1) {
      this.renderSubtitles();
    }

    const count = track.cues.length;
    const previousCount = track._lastRefreshedCount || 0;
    if (previousCount === 0 && count > 0) {
      this.updateTrackList();
    }
    track._lastRefreshedCount = count;
  }

  onSubtitleTrackDownloaded(track) {
    this.activateTrack(this.addTrack(track));
  }

  onCaptionsButtonInteract(e) {
    if (e.shiftKey) {
      this.openSubtitlesSearch.toggleUI();
      e.stopPropagation();
      return;
    }

    if (!this.isOpen()) {
      this.openUI();
    } else {
      this.closeUI();
    }
    e.stopPropagation();
  }

  closeUI() {
    if (DOMElements.subtitlesMenu.style.display === 'none') {
      return false;
    }
    DOMElements.subtitlesMenu.style.display = 'none';
    WebUtils.setLabels(DOMElements.subtitles, Localize.getMessage('player_subtitlesmenu_open_label'));
    return true;
  }

  openUI() {
    this.emit('open', {
      target: DOMElements.subtitles,
    });
    DOMElements.subtitlesMenu.style.display = '';

    WebUtils.setLabels(DOMElements.subtitles, Localize.getMessage('player_subtitlesmenu_close_label'));
  }

  isOpen() {
    return DOMElements.subtitlesMenu.style.display !== 'none';
  }

  setupUI() {
    DOMElements.subtitles.addEventListener('click', this.onCaptionsButtonInteract.bind(this));
    DOMElements.subtitles.tabIndex = 0;

    DOMElements.subtitles.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.onCaptionsButtonInteract(e);
      }
    });

    DOMElements.subtitlesOptionsTestButton.addEventListener('click', (e) => {
      this.isTestSubtitleActive = !this.isTestSubtitleActive;
      if (this.isTestSubtitleActive) {
        DOMElements.subtitlesOptionsTestButton.textContent = Localize.getMessage('player_subtitlesmenu_testbtn_stop');
        DOMElements.playerContainer.style.backgroundImage = 'linear-gradient(to right, black, white)';
      } else {
        DOMElements.subtitlesOptionsTestButton.textContent = Localize.getMessage('player_subtitlesmenu_testbtn');
        DOMElements.playerContainer.style.backgroundImage = '';
      }

      this.renderSubtitles(true);
    });
    WebUtils.setupTabIndex(DOMElements.subtitlesOptionsTestButton);

    const filechooser = document.createElement('input');
    filechooser.type = 'file';
    filechooser.style.display = 'none';
    filechooser.accept = '.vtt, .srt';
    filechooser.ariaHidden = true;
    filechooser.ariaLabel = 'Upload subtitle file';

    filechooser.addEventListener('change', () => {
      const files = filechooser.files;
      if (!files || !files[0]) return;
      const file = files[0];
      const name = file.name;
      //  var ext = name.substring(name.length - 4);

      const reader = new FileReader();
      reader.onload = () => {
        const dt = reader.result;
        const track = new SubtitleTrack(name, null);
        track.loadText(dt);

        this.addTrack(track);
      };
      reader.readAsText(file);
    });
    DOMElements.playerContainer.appendChild(filechooser);

    const filebutton = document.createElement('div');
    filebutton.classList.add('subtitle-menu-option');
    WebUtils.setupTabIndex(filebutton);
    filebutton.textContent = Localize.getMessage('player_subtitlesmenu_uploadbtn');

    filebutton.addEventListener('click', (e) => {
      filechooser.click();
    });
    DOMElements.subtitlesView.appendChild(filebutton);

    const urlbutton = document.createElement('div');
    urlbutton.classList.add('subtitle-menu-option');
    urlbutton.textContent = Localize.getMessage('player_subtitlesmenu_urlbtn');
    WebUtils.setupTabIndex(urlbutton);
    urlbutton.addEventListener('click', async (e) => {
      const url = await AlertPolyfill.prompt(Localize.getMessage('player_subtitlesmenu_urlprompt'), '', undefined, 'url');

      if (url) {
        AlertPolyfill.toast('info', Localize.getMessage('player_subtitles_addtrack_downloading'));
        RequestUtils.requestSimple(url, (err, req, body) => {
          if (!err && body) {
            try {
              const track = new SubtitleTrack('URL Track', null);
              track.loadText(body);

              this.addTrack(track);

              AlertPolyfill.toast('success', Localize.getMessage('player_subtitles_addtrack_success'));
            } catch (e) {
              AlertPolyfill.toast('error', Localize.getMessage('player_subtitles_addtrack_error'), e?.message);
            }
          } else {
            AlertPolyfill.toast('error', Localize.getMessage('player_subtitles_addtrack_error'), err?.message);
          }
        });
      }
    });

    DOMElements.subtitlesView.appendChild(urlbutton);

    // AI subtitles toggle. The label follows the engine state (see updateAIButton).
    const aiButton = document.createElement('div');
    aiButton.classList.add('subtitle-menu-option');
    aiButton.textContent = Localize.getMessage('player_aisubs_start');
    WebUtils.setupTabIndex(aiButton);
    aiButton.addEventListener('click', (e) => {
      this.transcriptionEngine?.toggle();
      e.stopPropagation();
    });
    DOMElements.subtitlesView.appendChild(aiButton);
    this.aiButton = aiButton;

    const internetbutton = document.createElement('div');
    internetbutton.textContent = Localize.getMessage('player_subtitlesmenu_searchbtn');
    internetbutton.classList.add('subtitle-menu-option');
    internetbutton.classList.add('disable-when-mini');
    WebUtils.setupTabIndex(internetbutton);
    internetbutton.addEventListener('click', (e) => {
      this.openSubtitlesSearch.toggleUI();
    });
    DOMElements.subtitlesView.appendChild(internetbutton);

    const clearbutton = document.createElement('div');
    clearbutton.textContent = Localize.getMessage('player_subtitlesmenu_clearbtn');
    WebUtils.setupTabIndex(clearbutton);
    clearbutton.classList.add('subtitle-menu-option');

    clearbutton.addEventListener('click', (e) => {
      this.clearTracks();
    });
    DOMElements.subtitlesView.appendChild(clearbutton);

    const optionsbutton = document.createElement('div');
    optionsbutton.classList.add('subtitle-menu-option');
    optionsbutton.textContent = Localize.getMessage('player_subtitlesmenu_settingsbtn');
    WebUtils.setupTabIndex(optionsbutton);

    optionsbutton.addEventListener('click', (e) => {
      this.settingsManager.openUI();
    });

    WebUtils.setupTabIndex(DOMElements.subtitlesOptionsBackButton);

    DOMElements.subtitlesView.appendChild(optionsbutton);

    DOMElements.subtitlesMenu.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    window.addEventListener('resize', () => {
      this.checkTrackBounds();
    });

    DOMElements.subtitlesMenu.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    DOMElements.subtitlesMenu.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
  }

  createTrackEntryElements(i) {
    const trackElement = document.createElement('div');
    trackElement.classList.add('subtitle-track-element');

    trackElement.addEventListener('click', (e) => {
      const track = this.tracks[i];
      const ind = this.activeTracks.indexOf(track);
      if (ind !== -1) {
        this.deactivateTrack(track);
      } else {
        this.activateTrack(track);
      }
      e.stopPropagation();
    });

    WebUtils.setupTabIndex(trackElement);

    const trackName = document.createElement('div');
    trackElement.appendChild(trackName);
    trackName.classList.add('subtitle-track-name');

    const resyncTool = document.createElement('div');
    resyncTool.title = Localize.getMessage('player_subtitlesmenu_resynctool_label');
    resyncTool.className = 'fluid_button fluid_button_wand subtitle-resync-tool subtitle-tool';
    trackElement.appendChild(resyncTool);
    // svg use
    const svgIconHourglass = WebUtils.createSVGIcon('assets/fluidplayer/static/icons.svg#hourglass');
    resyncTool.appendChild(svgIconHourglass);

    resyncTool.addEventListener('click', (e) => {
      this.subtitleSyncer.toggleTrack(this.tracks[i]);
      e.stopPropagation();
    }, true);

    const downloadTrack = document.createElement('div');
    downloadTrack.title = Localize.getMessage('player_subtitlesmenu_savetool_label');
    downloadTrack.className = 'fluid_button fluid_button_download subtitle-download-tool subtitle-tool';

    // svg use
    const svgIconDownload = WebUtils.createSVGIcon('assets/fluidplayer/static/icons.svg#download');
    downloadTrack.appendChild(svgIconDownload);

    trackElement.appendChild(downloadTrack);

    downloadTrack.addEventListener('click', async (e) => {
      e.stopPropagation();
      const suggestedName = trackElement.textContent.replaceAll(' ', '_');
      const dlname = chrome?.extension?.inIncognitoContext ? suggestedName : await AlertPolyfill.prompt(Localize.getMessage('player_filename_prompt'), suggestedName);

      if (!dlname) {
        return;
      }

      const srt = SubtitleUtils.cuesToSrt(this.tracks[i].cues);
      const blob = new Blob([srt], {
        type: 'text/plain',
      });
      const url = window.URL.createObjectURL(blob);
      await Utils.downloadURL(url, dlname + '.srt');
      window.URL.revokeObjectURL(url);
    }, true);

    const removeTrack = document.createElement('div');
    removeTrack.classList.add('subtitle-remove-tool');
    removeTrack.classList.add('subtitle-tool');
    removeTrack.title = Localize.getMessage('player_subtitlesmenu_removetool_label');
    trackElement.appendChild(removeTrack);

    removeTrack.addEventListener('click', (e) => {
      this.removeTrack(this.tracks[i]);
      e.stopPropagation();
    }, true);


    const shiftLTrack = document.createElement('div');
    shiftLTrack.classList.add('subtitle-shiftl-tool');
    shiftLTrack.classList.add('subtitle-tool');
    shiftLTrack.title = Localize.getMessage('player_subtitlesmenu_shifttool_label', ['-0.2']);
    trackElement.appendChild(shiftLTrack);

    shiftLTrack.addEventListener('click', (e) => {
      this.tracks[i].shift(-0.2);
      this.renderSubtitles();
      this.client.interfaceController.setStatusMessage('subtitles', Localize.getMessage('player_subtitlesmenu_shifttool_message', ['-0.2']), 'info', 700);
      e.stopPropagation();
    }, true);

    const shiftRTrack = document.createElement('div');
    shiftRTrack.classList.add('subtitle-shiftr-tool');
    shiftRTrack.classList.add('subtitle-tool');
    shiftRTrack.title = Localize.getMessage('player_subtitlesmenu_shifttool_label', ['+0.2']);
    trackElement.appendChild(shiftRTrack);

    shiftRTrack.addEventListener('click', (e) => {
      this.tracks[i].shift(0.2);
      this.renderSubtitles();
      this.client.interfaceController.setStatusMessage('subtitles', Localize.getMessage('player_subtitlesmenu_shifttool_message', ['+0.2']), 'info', 700);
      e.stopPropagation();
    }, true);


    trackElement.addEventListener('mouseenter', () => {
      trackElement.focus();
    });

    trackElement.addEventListener('mouseleave', () => {
      trackElement.blur();
    });


    trackElement.addEventListener('keydown', (e) => {
      if (e.code === 'Delete' || e.code === 'Backspace') {
        e.stopPropagation();
        removeTrack.click();
      } else if (e.code === 'BracketRight') {
        e.stopPropagation();
        shiftRTrack.click();
      } else if (e.code === 'BracketLeft') {
        e.stopPropagation();
        shiftLTrack.click();
      } else if (e.code === 'KeyD') {
        e.stopPropagation();
        downloadTrack.click();
      } else if (e.code === 'KeyR') {
        e.stopPropagation();
        resyncTool.click();
      }
    });

    return {
      trackElement,
      update: () => {
        const track = this.tracks[i];
        const activeIndex = this.activeTracks.indexOf(track);
        const nameCandidate = (track.language ? ('(' + track.language + ') ') : '') + (track.label || `Track ${i + 1}`);
        let name = nameCandidate;
        // limit to 30 chars
        if (name.length > 30) {
          name = name.substring(0, 30) + '...';
        }

        if (activeIndex !== -1) {
          trackElement.classList.add('subtitle-track-active');

          if (this.activeTracks.length > 1) {
            trackName.textContent = (activeIndex + 1) + ': ' + name;
          } else {
            trackName.textContent = name;
          }
        } else {
          trackElement.classList.remove('subtitle-track-active');
          trackName.textContent = name;
        }

        trackName.title = nameCandidate;
      },
    };
  }

  updateTrackList() {
    const cachedElements = this.subtitleTrackListElements;
    const tracks = this.tracks;

    // Remove extra elements
    for (let i = cachedElements.length - 1; i >= tracks.length; i--) {
      const el = cachedElements[i];
      el.trackElement.remove();
      cachedElements.splice(i, 1);
    }

    // Add new elements
    for (let i = cachedElements.length; i < tracks.length; i++) {
      const elements = this.createTrackEntryElements(i);
      cachedElements.push(elements);
      DOMElements.subtitlesList.appendChild(elements.trackElement);
    }

    // Update elements
    for (let i = 0; i < tracks.length; i++) {
      cachedElements[i].update();
    }

    this.renderSubtitles();

    // every path that changes activeTracks ends here, so sync the render loop here
    if (this.activeTracks.length) {
      this.startRenderLoop();
    } else {
      this.stopRenderLoop();
    }
  }

  /**
   * Starts a per-frame subtitle render loop if the video is playing and at
   * least one track is active. Safe to call repeatedly.
   */
  startRenderLoop() {
    if (this.renderLoopCancel || !this.activeTracks.length) return;

    const video = this.client.currentVideo;
    if (!video || video.paused || video.ended) return;

    const tick = () => {
      this.renderLoopCancel = null;
      const currentVideo = this.client.currentVideo;
      if (!this.activeTracks.length || !currentVideo || currentVideo.paused || currentVideo.ended) return;

      this.renderSubtitles();
      this.scheduleRenderFrame(tick);
    };

    this.scheduleRenderFrame(tick);
  }

  /**
   * Stops the render loop started by startRenderLoop.
   */
  stopRenderLoop() {
    if (this.renderLoopCancel) {
      this.renderLoopCancel();
      this.renderLoopCancel = null;
    }
  }

  /**
   * Schedules one callback for the next video frame, or the next animation
   * frame when requestVideoFrameCallback is not available.
   * @param {Function} callback - Called once on the next frame.
   */
  scheduleRenderFrame(callback) {
    const video = this.client.currentVideo;
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      const handle = video.requestVideoFrameCallback(callback);
      this.renderLoopCancel = () => video.cancelVideoFrameCallback(handle);
    } else {
      const handle = requestAnimationFrame(callback);
      this.renderLoopCancel = () => cancelAnimationFrame(handle);
    }
  }

  applyStyles(trackContainer) {
    return this.settingsManager.applyStyles(trackContainer);
  }

  refreshSubtitleStyles() {
    this.subtitleTrackDisplayElements.forEach((el) => {
      this.applyStyles(el);
    });
  }

  createSubtitleDisplayElements(i) {
    const trackContainer = document.createElement('div');
    trackContainer.className = 'subtitle-track';
    this.applyStyles(trackContainer);

    const wrapper = document.createElement('div');
    wrapper.className = 'subtitle-track-wrapper';
    wrapper.appendChild(trackContainer);

    wrapper.style.marginBottom = '5px';


    let yStart = 0;

    const mouseup = (e) => {
      DOMElements.playerContainer.removeEventListener('mousemove', mousemove);
      DOMElements.playerContainer.removeEventListener('mouseup', mouseup);
      e.stopPropagation();
    };

    const mousemove = (e) => {
      // drag by adjusting margin-bottom
      const oldDiff = yStart - e.clientY;
      let diff = oldDiff;
      let current = wrapper;
      do {
        const marginBottom = parseInt(current.style.marginBottom) || 0;
        const newMarginBottom = Math.max(marginBottom + diff, 5);
        current.style.marginBottom = newMarginBottom + 'px';
        diff -= (newMarginBottom - marginBottom);
        current = current.nextElementSibling;
      } while (current && diff < 0);

      const adjustedDiff = oldDiff - diff;

      const previousSibling = wrapper.previousElementSibling;
      if (previousSibling) {
        const previousMarginBottom = parseInt(previousSibling.style.marginBottom) || 0;
        const newPreviousMarginBottom = Math.max(previousMarginBottom - adjustedDiff, 5);
        previousSibling.style.marginBottom = newPreviousMarginBottom + 'px';
      }

      yStart = e.clientY;
      this.checkTrackBounds();
      e.stopPropagation();
    };

    wrapper.addEventListener('mousedown', (e) => {
      yStart = e.clientY;
      DOMElements.playerContainer.addEventListener('mousemove', mousemove);
      DOMElements.playerContainer.addEventListener('mouseup', mouseup);
      e.stopPropagation();
    });


    return {
      trackContainer,
      wrapper,
    };
  }

  // Make sure subtitles are not outside of the video
  checkTrackBounds() {
    const trackElements = this.subtitleTrackDisplayElements;
    const playerHeight = DOMElements.playerContainer.offsetHeight - parseInt(window.getComputedStyle(DOMElements.subtitlesContainer).bottom);

    let totalTrackHeight = 0;
    for (let i = 0; i < trackElements.length; i++) {
      const trackWrapper = trackElements[i].parentElement;
      const marginBottom = parseInt(trackWrapper.style.marginBottom);
      totalTrackHeight += trackWrapper.offsetHeight + marginBottom;
    }

    let shrinkAmount = Math.max(totalTrackHeight - playerHeight, 0);
    // shrink margin-bottom from topmost track downwards
    for (let i = 0; i < trackElements.length && shrinkAmount > 0; i++) {
      const trackWrapper = trackElements[i].parentElement;
      const marginBottom = parseInt(trackWrapper.style.marginBottom) || 0;
      const newMarginBottom = Math.max(marginBottom - shrinkAmount, 5);
      trackWrapper.style.marginBottom = newMarginBottom + 'px';
      shrinkAmount -= (marginBottom - newMarginBottom);
    }
  }

  getSubtitlesVisibleNow() {
    const cachedElements = this.subtitleTrackDisplayElements;
    return cachedElements.map((el, i) => {
      return {
        track: this.activeTracks[i],
        visible: el.style.opacity !== '0',
        text: el.textContent,
        marginBottom: parseInt(el.parentElement.style.marginBottom),
      };
    });
  }

  /**
   * Returns the cues that should be on screen at a given time, in startTime order.
   * A cue is shown when startTime <= time <= endTime. Walks back from the last
   * cue that has started, so a long cue is still found when short cues overlap it.
   * @param {Array} cues - Cues sorted by startTime.
   * @param {number} time - Playback time in seconds.
   * @return {Array} Cues to show.
   */
  static getCuesAtTime(cues, time) {
    // binary search for the first cue that starts after `time`
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].startTime <= time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const result = [];
    const earliestStart = time - 30;
    let steps = 0;
    for (let i = lo - 1; i >= 0 && steps <= 200 && cues[i].startTime >= earliestStart; i--, steps++) {
      if (cues[i].endTime >= time) {
        result.push(cues[i]);
      }
    }

    return result.reverse();
  }

  /**
   * @param {Array} a - First cue list.
   * @param {Array} b - Second cue list.
   * @return {boolean} True when both lists hold the same cue objects in the same order.
   */
  static isSameCueList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Draws the cues for every active track (and the test cue, if on).
   * Containers whose cues did not change are left alone.
   * @param {boolean} force - Re-render every container, even if nothing changed (use after style changes).
   */
  renderSubtitles(force = false) {
    const cachedElements = this.subtitleTrackDisplayElements;
    const tracks = this.activeTracks;
    let trackLen = tracks.length;

    if (this.isTestSubtitleActive) {
      trackLen++;
    }

    // true when a container was added, removed or changed, so bounds must be checked
    let anyChanged = force;

    // Remove extra elements
    for (let i = cachedElements.length - 1; i >= trackLen; i--) {
      const el = cachedElements[i];
      el.parentElement.remove();
      cachedElements.splice(i, 1);
      anyChanged = true;
    }

    // Add new elements
    for (let i = cachedElements.length; i < trackLen; i++) {
      const {trackContainer, wrapper} = this.createSubtitleDisplayElements(i);

      cachedElements.push(trackContainer);
      DOMElements.subtitlesContainer.appendChild(wrapper);
      anyChanged = true;
    }

    // Update elements
    const currentTime = this.client.currentTime;
    let subtitlesVisible = 0;

    for (let i = 0; i < tracks.length; i++) {
      const trackContainer = cachedElements[i];
      const shown = SubtitlesManager.getCuesAtTime(tracks[i].cues, currentTime);

      // same cues as last time: no DOM writes needed
      if (!force && trackContainer._shownCues && SubtitlesManager.isSameCueList(trackContainer._shownCues, shown)) {
        if (shown.length) subtitlesVisible++;
        continue;
      }

      anyChanged = true;
      trackContainer._shownCues = shown;

      if (!shown.length) {
        trackContainer.style.opacity = 0;

        // Remove all children except one
        const fillerCue = trackContainer.children[0] || document.createElement('div');
        WebUtils.replaceChildrenPerformant(trackContainer, [fillerCue]);
        if (!fillerCue.textContent) fillerCue.textContent = '|';
      } else {
        const toAdd = shown.map((cue) => {
          if (!cue.dom) {
            cue.dom = WebVTT.convertCueToDOMTree(window, cue.text);
          }
          return cue.dom;
        });

        trackContainer.style.opacity = '';

        WebUtils.replaceChildrenPerformant(trackContainer, toAdd);
        subtitlesVisible++;
      }
    }


    if (this.isTestSubtitleActive) {
      const trackContainer = cachedElements[trackLen - 1];

      // forget the real cues so the next normal render rewrites this container
      trackContainer._shownCues = null;
      anyChanged = true;
      trackContainer.style.opacity = '';

      if (!this.testCue) {
        const cue = document.createElement('div');
        cue.textContent = Localize.getMessage('player_testsubtitle');
        this.testCue = cue;
      }

      WebUtils.replaceChildrenPerformant(trackContainer, [this.testCue]);
      subtitlesVisible++;
    }

    const display = subtitlesVisible ? '' : 'none';
    if (DOMElements.subtitlesContainer.style.display !== display) {
      DOMElements.subtitlesContainer.style.display = display;
    }

    if (subtitlesVisible) {
      const margin = this.settingsManager.getSettings().bottomMargin;
      const bottom = margin === '40px' ? '' : margin;
      if (DOMElements.subtitlesContainer.style.bottom !== bottom) {
        DOMElements.subtitlesContainer.style.bottom = bottom;
      }
    }

    if (anyChanged) {
      this.checkTrackBounds();
    }
  }

  mediaInfoSet() {
    this.openSubtitlesSearch.setMediaInfo(this.client.mediaInfo);
  }
}
