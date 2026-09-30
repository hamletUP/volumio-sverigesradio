'use strict';

const libQ = require('kew');
const fs = require('fs');
const path = require('path');
const VConf = require('v-conf');
const SrApi = require('./lib/srApi');

const SERVICE_NAME = 'sverigesradio';
const ROOT_URI = 'sr';
const PLUGIN_ICON = '/albumart?sourceicon=music_service/' + SERVICE_NAME + '/sr.svg';

module.exports = ControllerSverigesRadio;

function ControllerSverigesRadio(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.serviceName = SERVICE_NAME;
}

// --- Lifecycle ---------------------------------------------------------------

ControllerSverigesRadio.prototype.onVolumioStart = function () {
  this.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new VConf();
  this.config.loadFile(this.configFile);
  return libQ.resolve();
};

ControllerSverigesRadio.prototype.onStart = function () {
  this.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
  this.loadI18nStrings();
  this.api = new SrApi({ audioQuality: this.getAudioQuality() });
  this.addToBrowseSources();
  return libQ.resolve();
};

ControllerSverigesRadio.prototype.onStop = function () {
  clearTimeout(this.seriesRecheckTimer);
  clearTimeout(this.liveTitleTimer);
  this.commandRouter.volumioRemoveToBrowseSources(this.getI18nString('PLUGIN_NAME'));
  return libQ.resolve();
};

ControllerSverigesRadio.prototype.onRestart = function () {
  return libQ.resolve();
};

ControllerSverigesRadio.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

// --- Settings ----------------------------------------------------------------

ControllerSverigesRadio.prototype.getAudioQuality = function () {
  return this.config.get('audio_quality') || 'hi';
};

ControllerSverigesRadio.prototype.getPageSize = function () {
  const size = parseInt(this.config.get('page_size'), 10);
  return size > 0 && size <= 200 ? size : 50;
};

ControllerSverigesRadio.prototype.getDetectSeries = function () {
  return this.config.get('detect_series') !== false;
};

ControllerSverigesRadio.prototype.getContinueSeries = function () {
  return this.config.get('continue_series') !== false;
};

ControllerSverigesRadio.prototype.getUIConfig = function () {
  const defer = libQ.defer();
  const langCode = this.commandRouter.sharedVars.get('language_code');

  this.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + langCode + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then((uiconf) => {
    const quality = this.getAudioQuality();
    const qualitySelect = uiconf.sections[0].content[0];
    const selected = qualitySelect.options.find((o) => o.value === quality) || qualitySelect.options[0];
    qualitySelect.value = { value: selected.value, label: selected.label };
    uiconf.sections[0].content[1].value = this.getPageSize();
    uiconf.sections[0].content[2].value = this.getDetectSeries();
    uiconf.sections[0].content[3].value = this.getContinueSeries();
    defer.resolve(uiconf);
  }).fail((e) => {
    this.logger.error('[SR] getUIConfig failed: ' + e);
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerSverigesRadio.prototype.saveSettings = function (data) {
  const quality = data.audio_quality && data.audio_quality.value ? data.audio_quality.value : 'hi';
  this.config.set('audio_quality', quality);
  this.config.set('page_size', parseInt(data.page_size, 10) || 50);
  this.config.set('detect_series', data.detect_series !== false);
  this.config.set('continue_series', data.continue_series !== false);

  this.api = new SrApi({ audioQuality: quality });
  this.commandRouter.pushToastMessage('success', this.getI18nString('PLUGIN_NAME'), this.getI18nString('SETTINGS_SAVED'));
  return libQ.resolve();
};

// --- Browsing ----------------------------------------------------------------

ControllerSverigesRadio.prototype.addToBrowseSources = function () {
  this.commandRouter.volumioAddToBrowseSources({
    name: this.getI18nString('PLUGIN_NAME'),
    uri: ROOT_URI,
    plugin_type: 'music_service',
    plugin_name: SERVICE_NAME,
    albumart: PLUGIN_ICON
  });
};

// URI scheme:
//   sr                         root menu
//   sr/favorites               everything from SR the user has marked as favourite
//   sr/live                    live channels, with what's on now
//   sr/live/<channelId>        a live stream (playable)
//   sr/categories              program categories
//   sr/category/<id>           programs in a category
//   sr/channels                channels
//   sr/channel/<id>            programs on a channel
//   sr/programs                all programs A–Ö
//   sr/program/<id>[/<page>]   episodes of a program (plus the series they belong to)
//   sr/group/<id>              a series/collection, in series order
//   sr/episode/<id>            a single playable episode
ControllerSverigesRadio.prototype.handleBrowseUri = function (uri) {
  const parts = uri.split('/');
  let promise;

  if (uri === ROOT_URI) {
    promise = Promise.resolve(this.browseRoot());
  } else if (uri === ROOT_URI + '/favorites') {
    promise = this.browseFavorites();
  } else if (uri === ROOT_URI + '/live') {
    promise = this.browseLive();
  } else if (parts[1] === 'categories') {
    promise = this.browseCategories();
  } else if (parts[1] === 'category') {
    promise = this.browseProgramList({ programcategoryid: parts[2] }, ROOT_URI + '/categories');
  } else if (parts[1] === 'channels') {
    promise = this.browseChannels();
  } else if (parts[1] === 'channel') {
    promise = this.browseProgramList({ channelid: parts[2] }, ROOT_URI + '/channels');
  } else if (parts[1] === 'programs') {
    promise = this.browseProgramList({}, ROOT_URI);
  } else if (parts[1] === 'program') {
    promise = this.browseProgram(parts[2], parseInt(parts[3], 10) || 1);
  } else if (parts[1] === 'group') {
    promise = this.browseGroup(parts[2]);
  } else {
    promise = Promise.reject(new Error('Unknown URI ' + uri));
  }

  return this.toKew(promise.then((response) => this.markFavorites(response)), 'handleBrowseUri ' + uri);
};

// Flags episodes and channels that are in Volumio's favourites, so the UI offers "remove".
ControllerSverigesRadio.prototype.markFavorites = function (response) {
  return this.getVolumioFavorites().then((favorites) => {
    const uris = new Set(favorites.map((f) => f.uri));
    response.navigation.lists.forEach((list) => list.items.forEach((item) => {
      if (uris.has(item.uri)) item.favourite = true;
    }));
    return response;
  });
};

ControllerSverigesRadio.prototype.browseRoot = function () {
  const folder = (key, uri, icon) => ({
    service: SERVICE_NAME,
    type: 'folder',
    title: this.getI18nString(key),
    icon: icon,
    uri: uri
  });

  return this.navigation(this.getI18nString('PLUGIN_NAME'), '/', [
    folder('FAVORITES', ROOT_URI + '/favorites', 'fa fa-heart'),
    folder('LIVE', ROOT_URI + '/live', 'fa fa-microphone'),
    folder('CATEGORIES', ROOT_URI + '/categories', 'fa fa-tags'),
    folder('CHANNELS', ROOT_URI + '/channels', 'fa fa-signal'),
    folder('ALL_PROGRAMS', ROOT_URI + '/programs', 'fa fa-list')
  ], ['list']);
};

// SR channel types, in display order. Extra channels only carry occasional events,
// so they are listed only while something is on.
const LIVE_SECTIONS = [
  { type: 'Rikskanal', key: 'LIVE_NATIONAL' },
  { type: 'Lokal kanal', key: 'LIVE_LOCAL' },
  { type: 'Fler kanaler', key: 'LIVE_MORE' },
  { type: 'Minoritet och språk', key: 'LIVE_MINORITY' },
  { type: 'Extrakanaler', key: 'LIVE_EXTRA', onlyWhenOnAir: true }
];

ControllerSverigesRadio.prototype.browseLive = function () {
  return Promise.all([
    this.api.getChannels(),
    this.api.getRightNow().catch(() => new Map())
  ]).then(([channels, rightNow]) => {
    const lists = [];
    LIVE_SECTIONS.forEach((section) => {
      const items = channels
        .filter((c) => c.channeltype === section.type && c.liveaudio)
        .filter((c) => !section.onlyWhenOnAir || rightNow.has(c.id))
        .map((c) => this.channelToLiveItem(c, rightNow.get(c.id)));
      if (items.length > 0) {
        lists.push({ title: this.getI18nString(section.key), availableListViews: ['list', 'grid'], items: items });
      }
    });

    const response = this.navigation('', ROOT_URI, [], ['list']);
    response.navigation.lists = lists;
    return response;
  });
};

ControllerSverigesRadio.prototype.channelToLiveItem = function (channel, nowOnAir) {
  return {
    service: SERVICE_NAME,
    type: 'webradio',
    title: channel.name,
    artist: nowOnAir ? nowOnAir.title : '',
    albumart: channel.image || PLUGIN_ICON,
    uri: ROOT_URI + '/live/' + channel.id
  };
};

ControllerSverigesRadio.prototype.browseCategories = function () {
  return this.api.getCategories().then((categories) => this.navigation(
    this.getI18nString('CATEGORIES'),
    ROOT_URI,
    categories.map((c) => ({
      service: SERVICE_NAME,
      type: 'folder',
      title: c.name,
      icon: 'fa fa-folder-open-o',
      uri: ROOT_URI + '/category/' + c.id
    })),
    ['list']
  ));
};

ControllerSverigesRadio.prototype.browseChannels = function () {
  return this.api.getChannels().then((channels) => this.navigation(
    this.getI18nString('CHANNELS'),
    ROOT_URI,
    channels.map((c) => ({
      service: SERVICE_NAME,
      type: 'folder',
      title: c.name,
      albumart: c.image,
      uri: ROOT_URI + '/channel/' + c.id
    })),
    ['list', 'grid']
  ));
};

ControllerSverigesRadio.prototype.browseProgramList = function (filter, prevUri) {
  return this.api.getPrograms(filter).then((programs) => {
    let title = this.getI18nString('ALL_PROGRAMS');
    if (programs.length > 0 && filter.programcategoryid && programs[0].programcategory) {
      title = programs[0].programcategory.name;
    } else if (programs.length > 0 && filter.channelid && programs[0].channel) {
      title = programs[0].channel.name;
    }
    return this.navigation(title, prevUri, programs.map((p) => this.programToItem(p)), ['list', 'grid']);
  });
};

ControllerSverigesRadio.prototype.browseProgram = function (programId, page) {
  return Promise.all([
    this.api.getProgram(programId).catch(() => null),
    this.api.getEpisodes(programId, page, this.getPageSize())
  ]).then(([program, result]) => {
    const items = result.episodes
      .filter((e) => SrApi.getEpisodeAudio(e))
      .map((e) => this.episodeToItem(e, program));

    const pagination = result.pagination;
    if (pagination.totalpages && page < pagination.totalpages) {
      items.push({
        service: SERVICE_NAME,
        type: 'folder',
        title: this.getI18nString('OLDER_EPISODES') + ' (' + (page + 1) + '/' + pagination.totalpages + ')',
        icon: 'fa fa-arrow-circle-right',
        uri: ROOT_URI + '/program/' + programId + '/' + (page + 1)
      });
    }

    let prevUri = ROOT_URI + '/programs';
    if (page > 1) {
      prevUri = ROOT_URI + '/program/' + programId + '/' + (page - 1);
    } else if (program && program.programcategory) {
      prevUri = ROOT_URI + '/category/' + program.programcategory.id;
    }

    const title = program ? program.name : this.getI18nString('EPISODES');
    const response = this.navigation(title, prevUri, items, ['list']);

    if (!this.getDetectSeries()) return response;

    // Listings lack series info, so look up the episodes' groups (cached for a day).
    return this.api.findEpisodeGroups(result.episodes.map((e) => e.id))
      .then((groups) => {
        if (groups.length > 0) {
          response.navigation.lists.unshift({
            title: this.getI18nString('SERIES'),
            availableListViews: ['list'],
            items: groups.map((g) => this.groupToItem(g))
          });
        }
        return response;
      }, (err) => {
        this.logger.warn('[SR] series lookup failed: ' + err);
        return response;
      });
  });
};

ControllerSverigesRadio.prototype.browseGroup = function (groupId) {
  return this.api.getEpisodeGroup(groupId).then((group) => {
    const items = group.episodes
      .filter((e) => SrApi.getEpisodeAudio(e))
      .map((e) => this.episodeToItem(e, null));

    const first = group.episodes[0];
    const prevUri = first && first.program ? ROOT_URI + '/program/' + first.program.id : ROOT_URI;
    return this.navigation(group.title || this.getI18nString('SERIES'), prevUri, items, ['list']);
  });
};

ControllerSverigesRadio.prototype.programToItem = function (program) {
  return this.favoritableFolder({
    title: program.name,
    artist: program.channel ? program.channel.name : '',
    albumart: program.programimage,
    uri: ROOT_URI + '/program/' + program.id
  });
};

ControllerSverigesRadio.prototype.groupToItem = function (group) {
  return this.favoritableFolder({
    title: group.title,
    icon: 'fa fa-list-ol',
    uri: ROOT_URI + '/group/' + group.id
  });
};

// 'folder-with-favourites' browses like a folder but gets the UI's favourite actions.
ControllerSverigesRadio.prototype.favoritableFolder = function (fields) {
  const item = Object.assign({ service: SERVICE_NAME, type: 'folder-with-favourites' }, fields);
  if (this.isFolderFavorite(item.uri)) item.favourite = true;
  return item;
};

ControllerSverigesRadio.prototype.episodeToItem = function (episode, program) {
  const date = SrApi.formatDate(SrApi.parseSrDate(episode.publishdateutc));
  return {
    service: SERVICE_NAME,
    type: 'song',
    title: episode.title,
    artist: episode.program ? episode.program.name : '',
    album: date,
    albumart: episode.imageurl || (program && program.programimage) || PLUGIN_ICON,
    uri: ROOT_URI + '/episode/' + episode.id
  };
};

ControllerSverigesRadio.prototype.navigation = function (title, prevUri, items, views) {
  return {
    navigation: {
      prev: { uri: prevUri },
      lists: [{
        title: title,
        availableListViews: views,
        items: items
      }]
    }
  };
};

// --- Search ------------------------------------------------------------------

ControllerSverigesRadio.prototype.search = function (query) {
  const text = (query && query.value ? query.value : '').trim();
  if (!text) return libQ.resolve([]);

  const needle = text.toLocaleLowerCase('sv');
  const programsPromise = this.api.getPrograms({})
    .then((programs) => programs.filter((p) => p.name.toLocaleLowerCase('sv').includes(needle)))
    .catch(() => []);
  const episodesPromise = this.api.searchEpisodes(text, 30).catch(() => []);
  const channelsPromise = this.api.getChannels()
    .then((channels) => channels.filter((c) => c.liveaudio && c.name.toLocaleLowerCase('sv').includes(needle)))
    .catch(() => []);

  const promise = Promise.all([programsPromise, episodesPromise, channelsPromise]).then(([programs, episodes, channels]) => {
    const lists = [];
    if (channels.length > 0) {
      lists.push({
        title: this.getI18nString('PLUGIN_NAME') + ' – ' + this.getI18nString('LIVE'),
        availableListViews: ['list', 'grid'],
        items: channels.map((c) => this.channelToLiveItem(c, null))
      });
    }
    if (programs.length > 0) {
      lists.push({
        title: this.getI18nString('PLUGIN_NAME') + ' – ' + this.getI18nString('PROGRAMS'),
        availableListViews: ['list', 'grid'],
        items: programs.slice(0, 30).map((p) => this.programToItem(p))
      });
    }
    const playable = episodes.filter((e) => SrApi.getEpisodeAudio(e));
    if (playable.length > 0) {
      lists.push({
        title: this.getI18nString('PLUGIN_NAME') + ' – ' + this.getI18nString('EPISODES'),
        availableListViews: ['list'],
        items: playable.map((e) => this.episodeToItem(e, null))
      });
    }
    return lists;
  });

  return this.toKew(promise, 'search');
};

// --- Queue / playback --------------------------------------------------------

ControllerSverigesRadio.prototype.explodeUri = function (uri) {
  const parts = uri.split('/');
  let promise;

  if (parts[1] === 'live' && parts[2]) {
    promise = Promise.all([
      this.api.getChannels(),
      this.api.getRightNow().catch(() => new Map())
    ]).then(([channels, rightNow]) => {
      const channel = channels.find((c) => String(c.id) === parts[2]);
      if (!channel) throw new Error('Unknown channel ' + parts[2]);
      return [this.channelToLiveTrack(channel, rightNow.get(channel.id))];
    });
  } else if (parts[1] === 'episode') {
    promise = this.api.getEpisode(parts[2]).then((episode) => {
      const track = this.episodeToTrack(episode);
      if (!track) throw new Error('Episode ' + parts[2] + ' has no playable audio');
      return [track];
    });
  } else if (parts[1] === 'program') {
    // Playing a program folder queues the episodes on that page.
    promise = this.api.getEpisodes(parts[2], parseInt(parts[3], 10) || 1, this.getPageSize())
      .then((result) => result.episodes.map((e) => this.episodeToTrack(e)).filter(Boolean));
  } else if (parts[1] === 'group') {
    // Playing a series folder queues all parts in series order.
    promise = this.api.getEpisodeGroup(parts[2])
      .then((group) => group.episodes.map((e) => this.episodeToTrack(e)).filter(Boolean));
  } else {
    promise = Promise.reject(new Error('Cannot explode URI ' + uri));
  }

  return this.toKew(promise, 'explodeUri ' + uri);
};

ControllerSverigesRadio.prototype.episodeToTrack = function (episode) {
  const audio = SrApi.getEpisodeAudio(episode);
  if (!audio) return null;

  const date = SrApi.formatDate(SrApi.parseSrDate(episode.publishdateutc));
  // Some URLs are redirects without a file extension; fall back on SR's format hint.
  const fileName = audio.url.split('?')[0].split('/').pop();
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : (episode.audiopriority || 'mp3');

  return {
    service: SERVICE_NAME,
    type: 'track',
    uri: ROOT_URI + '/episode/' + episode.id,
    streamUrl: audio.url,
    name: episode.title,
    title: episode.title,
    artist: episode.program ? episode.program.name : this.getI18nString('PLUGIN_NAME'),
    album: date,
    albumart: episode.imageurl || PLUGIN_ICON,
    duration: audio.duration,
    trackType: ext === 'm4a' ? 'aac' : ext || 'mp3',
    samplerate: '',
    bitdepth: ''
  };
};

ControllerSverigesRadio.prototype.channelToLiveTrack = function (channel, nowOnAir) {
  return {
    service: SERVICE_NAME,
    type: 'webradio',
    trackType: 'webradio',
    radioType: SERVICE_NAME,
    uri: ROOT_URI + '/live/' + channel.id,
    name: channel.name,
    title: nowOnAir ? nowOnAir.title : channel.name,
    artist: channel.name,
    album: this.getI18nString('LIVE'),
    albumart: channel.image || PLUGIN_ICON
  };
};

ControllerSverigesRadio.prototype.isLiveUri = function (uri) {
  return uri.split('/')[1] === 'live';
};

ControllerSverigesRadio.prototype.resolveStreamUrl = function (track) {
  // Live URLs are derived on each play so a changed quality setting applies.
  if (this.isLiveUri(track.uri)) return libQ.resolve(this.api.getLiveUrl(track.uri.split('/')[2]));
  if (track.streamUrl) return libQ.resolve(track.streamUrl);
  // Queue items saved by older versions (or restored elsewhere) may lack the URL.
  return this.explodeUri(track.uri).then((tracks) => tracks[0].streamUrl);
};

ControllerSverigesRadio.prototype.clearAddPlayTrack = function (track) {
  const mpd = this.mpdPlugin;

  return this.resolveStreamUrl(track)
    .then((url) => {
      const safeUrl = url.replace(/"/g, '\\"');
      return mpd.sendMpdCommand('stop', [])
        .then(() => mpd.sendMpdCommand('clear', []))
        .then(() => mpd.sendMpdCommand('add "' + safeUrl + '"', []));
    })
    .then(() => {
      // Let MPD drive state, but keep our metadata (title, program, artwork) and our uri,
      // so favourites work from the player. Live titles are kept current by refreshLiveTitle.
      this.commandRouter.stateMachine.setConsumeUpdateService('mpd', true, false);
      return mpd.sendMpdCommand('play', []);
    })
    .then(() => {
      clearTimeout(this.liveTitleTimer);
      if (this.isLiveUri(track.uri)) {
        this.refreshLiveTitle(track.uri);
      } else {
        this.continueSeriesAfter(track);
      }
    })
    .fail((e) => {
      this.logger.error('[SR] clearAddPlayTrack failed: ' + e);
      this.commandRouter.pushToastMessage('error', this.getI18nString('PLUGIN_NAME'), this.getI18nString('PLAY_FAILED'));
      return libQ.reject(e);
    });
};

// Whatever way an episode was started (series view, search, program list, favourites),
// make sure the following parts of its series play next. Runs in the background.
ControllerSverigesRadio.prototype.continueSeriesAfter = function (track) {
  clearTimeout(this.seriesRecheckTimer);
  const episodeId = track.uri.split('/')[2];
  if (!this.getContinueSeries() || track.uri.split('/')[1] !== 'episode') return;

  this.api.findSeriesContinuation(episodeId).then((series) => {
    if (!series) return;
    const following = series.following.map((e) => this.episodeToTrack(e));

    if (this.arrangeQueueForSeries(track.uri, following, series.memberIds) && following.length > 0) {
      const message = this.getI18nString('SERIES_CONTINUES')
        .replace('{0}', following.length)
        .replace('{1}', series.group.title);
      this.commandRouter.pushToastMessage('info', this.getI18nString('PLUGIN_NAME'), message);
    }

    // Volumio appends the rest of a clicked list only after playback has started;
    // check again so those items end up after the series instead of before it.
    this.seriesRecheckTimer = setTimeout(() => {
      this.arrangeQueueForSeries(track.uri, following, series.memberIds);
    }, 5000);
  }).catch((err) => {
    this.logger.warn('[SR] series continuation failed: ' + (err && err.message ? err.message : err));
  });
};

// Rewrites the queue to: [everything up to the current episode] + [following parts] +
// [rest of the queue without other parts of the series]. Returns true if it changed.
ControllerSverigesRadio.prototype.arrangeQueueForSeries = function (currentUri, following, memberIds) {
  const stateMachine = this.commandRouter.stateMachine;
  const playQueue = stateMachine.playQueue;
  if (!playQueue || !Array.isArray(playQueue.arrayQueue)) return false;
  if (stateMachine.currentRandom === true) return false;

  const queue = playQueue.arrayQueue;
  const position = stateMachine.currentPosition;
  if (!queue[position] || queue[position].uri !== currentUri) return false;

  const isMember = (item) => {
    if (item.service !== SERVICE_NAME) return false;
    const parts = item.uri.split('/');
    return parts[1] === 'episode' && memberIds.has(parseInt(parts[2], 10));
  };
  const wanted = queue.slice(0, position + 1)
    .concat(following, queue.slice(position + 1).filter((item) => !isMember(item)));

  const unchanged = wanted.length === queue.length && wanted.every((item, i) => item.uri === queue[i].uri);
  if (unchanged) return false;

  wanted.forEach((item) => {
    if (item.channels === undefined) item.channels = playQueue.defaultChannels;
  });
  playQueue.arrayQueue = wanted;
  playQueue.saveQueue();
  this.commandRouter.volumioPushQueue(wanted);
  stateMachine.updateTrackBlock();
  return true;
};

ControllerSverigesRadio.prototype.stop = function () {
  return this.mpdPlugin.stop();
};

ControllerSverigesRadio.prototype.pause = function () {
  // Pausing a live stream would resume from a stale buffer; stop so resume rejoins live.
  const stateMachine = this.commandRouter.stateMachine;
  const current = typeof stateMachine.getTrack === 'function' ? stateMachine.getTrack(stateMachine.currentPosition) : null;
  if (current && current.uri && this.isLiveUri(current.uri)) return this.mpdPlugin.stop();
  return this.mpdPlugin.pause();
};

ControllerSverigesRadio.prototype.resume = function () {
  return this.mpdPlugin.resume();
};

ControllerSverigesRadio.prototype.seek = function (position) {
  return this.mpdPlugin.seek(position);
};

// Keeps the title of a playing live stream in step with the schedule: updates the queue
// item (which the player shows) and re-pushes MPD's state at each program change.
ControllerSverigesRadio.prototype.refreshLiveTitle = function (uri, fresh) {
  clearTimeout(this.liveTitleTimer);
  const channelId = parseInt(uri.split('/')[2], 10);

  this.api.getRightNow(fresh).then((rightNow) => {
    const stateMachine = this.commandRouter.stateMachine;
    const current = stateMachine.getTrack(stateMachine.currentPosition);
    if (!current || current.uri !== uri) return; // something else is playing now

    const onAir = rightNow.get(channelId);
    const title = onAir ? onAir.title : current.artist;
    if (current.name !== title) {
      current.name = title;
      current.title = title;
      this.mpdPlugin.getState().then((state) => this.mpdPlugin.pushState(state));
    }

    // Next check just after the current program ends; within 1–30 minutes.
    const end = onAir ? SrApi.parseSrDate(onAir.endtimeutc) : null;
    const delay = end ? end.getTime() - Date.now() + 5000 : 5 * 60 * 1000;
    this.liveTitleTimer = setTimeout(() => this.refreshLiveTitle(uri, true),
      Math.min(Math.max(delay, 60 * 1000), 30 * 60 * 1000));
  }).catch((err) => {
    this.logger.warn('[SR] live title refresh failed: ' + (err && err.message ? err.message : err));
    this.liveTitleTimer = setTimeout(() => this.refreshLiveTitle(uri, true), 5 * 60 * 1000);
  });
};

// --- Favourites --------------------------------------------------------------
//
// Episodes and live channels are stored in Volumio's own favourites (the heart in the
// player and the browse menu). Programs and series are folders, which Volumio's generic
// favourites can't represent, so the plugin stores those itself. "Mina favoriter" shows both.

ControllerSverigesRadio.prototype.isFolderUri = function (uri) {
  const kind = uri.split('/')[1];
  return kind === 'program' || kind === 'group';
};

ControllerSverigesRadio.prototype.getFolderFavorites = function () {
  try {
    const list = JSON.parse(this.config.get('favorites') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
};

ControllerSverigesRadio.prototype.saveFolderFavorites = function (list) {
  this.config.set('favorites', JSON.stringify(list));
};

ControllerSverigesRadio.prototype.isFolderFavorite = function (uri) {
  return this.getFolderFavorites().some((f) => f.uri === uri);
};

// Called by Volumio for every favourite added from this service (browse menu or player heart).
ControllerSverigesRadio.prototype.addToFavourites = function (data) {
  const uri = data.uri;
  const playlistManager = this.commandRouter.playListManager;

  if (!this.isFolderUri(uri)) {
    // Same storage Volumio would use without this method.
    return playlistManager.commonAddToPlaylist(playlistManager.favouritesPlaylistFolder, 'favourites', SERVICE_NAME, uri);
  }

  if (this.isFolderFavorite(uri)) return libQ.resolve({ service: SERVICE_NAME, uri: uri, favourite: true });

  const parts = uri.split('/');
  const lookup = parts[1] === 'program'
    ? this.api.getProgram(parts[2]).then((p) => ({ title: p.name, albumart: p.programimage, artist: p.channel ? p.channel.name : '' }))
    : this.api.getEpisodeGroup(parts[2]).then((g) => ({ title: g.title, icon: 'fa fa-list-ol' }));

  return this.toKew(lookup.then((info) => {
    this.saveFolderFavorites(this.getFolderFavorites().concat([Object.assign({ uri: uri }, info)]));
    return { service: SERVICE_NAME, uri: uri, favourite: true };
  }), 'addToFavourites ' + uri);
};

// Called by Volumio before it removes an entry from its own favourites.
ControllerSverigesRadio.prototype.removeFromFavourites = function (data) {
  if (data && data.uri && this.isFolderUri(data.uri)) {
    this.saveFolderFavorites(this.getFolderFavorites().filter((f) => f.uri !== data.uri));
    this.commandRouter.pushToastMessage('success', this.getI18nString('PLUGIN_NAME'), this.getI18nString('FAVORITE_REMOVED'));
  }
  return libQ.resolve();
};

ControllerSverigesRadio.prototype.getVolumioFavorites = function () {
  const playlistManager = this.commandRouter.playListManager;
  if (!playlistManager || typeof playlistManager.getFavouritesContent !== 'function') return Promise.resolve([]);
  return new Promise((resolve) => {
    playlistManager.getFavouritesContent()
      .then((items) => resolve((items || []).filter((i) => i.service === SERVICE_NAME)))
      .fail(() => resolve([]));
  });
};

ControllerSverigesRadio.prototype.browseFavorites = function () {
  return this.getVolumioFavorites().then((volumioFavorites) => {
    const lists = [];
    const addList = (key, items, views) => {
      if (items.length > 0) lists.push({ title: this.getI18nString(key), availableListViews: views, items: items });
    };

    const fav = (item) => Object.assign({ service: SERVICE_NAME, favourite: true }, item);
    const kind = (uri) => uri.split('/')[1];

    addList('LIVE', volumioFavorites.filter((f) => kind(f.uri) === 'live').map((f) => fav({
      type: 'webradio', title: f.title, albumart: f.albumart, uri: f.uri
    })), ['list', 'grid']);

    addList('PROGRAMS_AND_SERIES', this.getFolderFavorites().map((f) => fav({
      type: 'folder-with-favourites', title: f.title, artist: f.artist, albumart: f.albumart, icon: f.icon, uri: f.uri
    })), ['list', 'grid']);

    addList('EPISODES', volumioFavorites.filter((f) => kind(f.uri) === 'episode').map((f) => fav({
      type: 'song', title: f.title, artist: f.artist, album: f.album, albumart: f.albumart, uri: f.uri
    })), ['list']);

    if (lists.length === 0) {
      addList('FAVORITES', [{ service: SERVICE_NAME, type: 'folder', title: this.getI18nString('NO_FAVORITES'), icon: 'fa fa-info-circle', uri: ROOT_URI }], ['list']);
    }

    const response = this.navigation('', ROOT_URI, [], ['list']);
    response.navigation.lists = lists;
    return response;
  });
};

// --- Helpers -----------------------------------------------------------------

// Volumio expects kew promises; the API layer uses native ones.
ControllerSverigesRadio.prototype.toKew = function (promise, label) {
  const defer = libQ.defer();
  promise.then(
    (value) => defer.resolve(value),
    (err) => {
      this.logger.error('[SR] ' + label + ' failed: ' + (err && err.message ? err.message : err));
      defer.reject(err instanceof Error ? err : new Error(String(err)));
    }
  );
  return defer.promise;
};

ControllerSverigesRadio.prototype.loadI18nStrings = function () {
  const dir = path.join(__dirname, 'i18n');
  this.i18nStringsDefaults = JSON.parse(fs.readFileSync(path.join(dir, 'strings_en.json'), 'utf8'));
  try {
    const langCode = this.commandRouter.sharedVars.get('language_code');
    this.i18nStrings = JSON.parse(fs.readFileSync(path.join(dir, 'strings_' + langCode + '.json'), 'utf8'));
  } catch (e) {
    this.i18nStrings = this.i18nStringsDefaults;
  }
};

ControllerSverigesRadio.prototype.getI18nString = function (key) {
  if (this.i18nStrings && this.i18nStrings[key] !== undefined) return this.i18nStrings[key];
  return this.i18nStringsDefaults[key] !== undefined ? this.i18nStringsDefaults[key] : key;
};
