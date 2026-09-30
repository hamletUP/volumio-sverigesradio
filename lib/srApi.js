'use strict';

// Thin client for Sveriges Radio Open API v2 (https://api.sr.se/api/v2/).
// Uses only Node core modules so it runs on the Node 14 shipped with Volumio 3.

const https = require('https');
const querystring = require('querystring');

const API_BASE = 'https://api.sr.se/api/v2/';
const REQUEST_TIMEOUT_MS = 15000;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_CONCURRENCY = 8;
const MAX_KNOWN_EPISODES = 3000;

function SrApi(options) {
  options = options || {};
  this.cacheTtlMs = options.cacheTtlMs || 10 * 60 * 1000;
  this.audioQuality = options.audioQuality || 'hi';
  this.cache = new Map();
  // Episodes seen in any listing, so queueing a whole list doesn't need one request per episode.
  this.knownEpisodes = new Map();
}

SrApi.prototype.get = function (path, params, ttlMs, bypassCache) {
  const query = querystring.stringify(Object.assign({ format: 'json' }, params || {}));
  const url = API_BASE + path + '?' + query;

  const cached = this.cache.get(url);
  if (!bypassCache && cached && cached.expires > Date.now()) {
    return Promise.resolve(cached.data);
  }

  return httpGetJson(url).then((data) => {
    this.cache.set(url, { data: data, expires: Date.now() + (ttlMs || this.cacheTtlMs) });
    return data;
  });
};

SrApi.prototype.clearCache = function () {
  this.cache.clear();
  this.knownEpisodes.clear();
};

SrApi.prototype.remember = function (episodes) {
  episodes.forEach((e) => {
    this.knownEpisodes.delete(e.id);
    this.knownEpisodes.set(e.id, e);
  });
  while (this.knownEpisodes.size > MAX_KNOWN_EPISODES) {
    this.knownEpisodes.delete(this.knownEpisodes.keys().next().value);
  }
  return episodes;
};

SrApi.prototype.getCategories = function () {
  return this.get('programcategories', { pagination: 'false' })
    .then((data) => data.programcategories || []);
};

SrApi.prototype.getChannels = function () {
  return this.get('channels', { pagination: 'false' })
    .then((data) => data.channels || []);
};

// All non-archived programs that have listenable episodes, optionally filtered.
SrApi.prototype.getPrograms = function (filter) {
  const params = Object.assign({ pagination: 'false', isarchived: 'false' }, filter || {});
  return this.get('programs/index', params)
    .then((data) => (data.programs || [])
      .filter((p) => p.hasondemand || p.haspod)
      .sort((a, b) => a.name.localeCompare(b.name, 'sv')));
};

SrApi.prototype.getProgram = function (programId) {
  return this.get('programs/' + encodeURIComponent(programId), {})
    .then((data) => data.program);
};

SrApi.prototype.getEpisodes = function (programId, page, size) {
  return this.get('episodes/index', {
    programid: programId,
    page: page || 1,
    size: size || 50,
    audioquality: this.audioQuality
  }).then((data) => ({
    episodes: this.remember(data.episodes || []),
    pagination: data.pagination || {}
  }));
};

// Full episode details (includes episodegroups, which listings lack).
SrApi.prototype.getEpisodeDetails = function (episodeId) {
  return this.get('episodes/get', { id: episodeId, audioquality: this.audioQuality }, DETAIL_TTL_MS)
    .then((data) => data.episode);
};

// What each channel is broadcasting right now: Map channelId -> scheduled episode.
SrApi.prototype.getRightNow = function (fresh) {
  return this.get('scheduledepisodes/rightnow', { pagination: 'false' }, 60 * 1000, fresh)
    .then((data) => new Map((data.channels || [])
      .filter((c) => c.currentscheduledepisode)
      .map((c) => [c.id, c.currentscheduledepisode])));
};

// Live stream for a channel. Redirects to the CDN; AAC 320/128/32 kbit/s for hi/normal/lo.
SrApi.prototype.getLiveUrl = function (channelId) {
  const suffix = { hi: '-hi', normal: '', lo: '-lo' }[this.audioQuality] || '';
  return 'https://www.sverigesradio.se/topsy/direkt/srapi/' + encodeURIComponent(channelId) + suffix + '.aac';
};

// Any version of the episode with playable audio; avoids a request when it was already listed.
SrApi.prototype.getEpisode = function (episodeId) {
  const known = this.knownEpisodes.get(parseInt(episodeId, 10));
  if (known) return Promise.resolve(known);
  return this.getEpisodeDetails(episodeId);
};

SrApi.prototype.searchEpisodes = function (query, size) {
  return this.get('episodes/search/', { query: query, size: size || 30, audioquality: this.audioQuality })
    .then((data) => this.remember(data.episodes || []));
};

// An episode group ("avsnittsgrupp") is SR's own grouping: a series or an editorial collection.
// Episodes are returned in series order (see sortSeries).
SrApi.prototype.getEpisodeGroup = function (groupId) {
  return this.get('episodes/group', { id: groupId, pagination: 'false', audioquality: this.audioQuality })
    .then((data) => {
      const group = data.episodegroup || {};
      return {
        id: group.id,
        title: group.title,
        description: group.description,
        episodes: sortSeries(this.remember(group.episodes || []))
      };
    });
};

// If the episode is part of a numbered series, returns the series and the parts that
// follow it: { group, following: [episodes], memberIds: Set }. Otherwise null.
// Unnumbered groups (editorial collections like "Upptäck fler dokumentärer") are ignored.
SrApi.prototype.findSeriesContinuation = function (episodeId) {
  const id = parseInt(episodeId, 10);

  return this.getEpisodeDetails(id).then((episode) => {
    const groupRefs = (episode && episode.episodegroups) || [];

    const tryGroup = (index) => {
      if (index >= groupRefs.length) return null;
      return this.getEpisodeGroup(groupRefs[index].id).then((group) => {
        const position = group.episodes.findIndex((e) => e.id === id);
        const numbered = group.episodes.filter((e) => getPartNumber(e.title) !== null).length;
        if (position === -1 || numbered < 2 || numbered * 2 < group.episodes.length) {
          return tryGroup(index + 1);
        }
        return {
          group: group,
          following: group.episodes.slice(position + 1).filter((e) => getEpisodeAudio(e)),
          memberIds: new Set(group.episodes.map((e) => e.id))
        };
      }, () => tryGroup(index + 1));
    };

    return tryGroup(0);
  });
};

// Distinct episode groups that the given episodes belong to, ordered by the first
// episode (in the given order) that belongs to each.
SrApi.prototype.findEpisodeGroups = function (episodeIds) {
  const groupsPerEpisode = new Array(episodeIds.length);
  let next = 0;

  const worker = () => {
    const index = next++;
    if (index >= episodeIds.length) return Promise.resolve();
    return this.getEpisodeDetails(episodeIds[index])
      .then((episode) => (episode && episode.episodegroups) || [], () => [])
      .then((found) => {
        groupsPerEpisode[index] = found;
        return worker();
      });
  };

  const workers = [];
  for (let i = 0; i < DETAIL_CONCURRENCY; i++) workers.push(worker());

  return Promise.all(workers).then(() => {
    const groups = new Map();
    groupsPerEpisode.forEach((found) => found.forEach((g) => {
      if (!groups.has(g.id)) groups.set(g.id, { id: g.id, title: g.name });
    }));
    return Array.from(groups.values());
  });
};

// --- Episode helpers ---------------------------------------------------------

// Returns { url, duration } for the best playable file of an episode, or null.
// Podcast files are preferred; broadcast (on-demand) files are used otherwise.
function getEpisodeAudio(episode) {
  if (!episode) return null;

  const pod = episode.listenpodfile || episode.downloadpodfile;
  if (pod && pod.url) {
    return { url: pod.url, duration: pod.duration || 0 };
  }

  const broadcast = episode.broadcast;
  if (broadcast && Array.isArray(broadcast.broadcastfiles) && broadcast.broadcastfiles.length > 0) {
    const file = broadcast.broadcastfiles[0];
    return { url: file.url, duration: file.duration || (broadcast.playlist && broadcast.playlist.duration) || 0 };
  }

  return null;
}

// SR uses the Microsoft JSON date format: "/Date(1790514480000)/".
function parseSrDate(value) {
  if (!value) return null;
  const match = /\/Date\((-?\d+)\)\//.exec(value);
  if (match) return new Date(parseInt(match[1], 10));
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

// Part number from titles like "Del 3", "del 3 av 6", "Avsnitt 3", "Part 3", "3/6", "3:6".
function getPartNumber(title) {
  if (!title) return null;
  const named = /\b(?:del|avsnitt|part|episode|kapitel)\s+(\d{1,3})\b/i.exec(title);
  if (named) return parseInt(named[1], 10);

  // "N/M", "N:M", "N av M": only when it reads as part-of-total, so "08:00" isn't part 8.
  const fraction = /(?:^|[\s(])([1-9]\d{0,2})\s*(\/|:|av|of)\s*(\d{1,3})(?=[\s),.]|$)/i.exec(title);
  if (fraction) {
    const part = parseInt(fraction[1], 10);
    const total = parseInt(fraction[3], 10);
    const maxTotal = fraction[2] === ':' ? 20 : 50;
    if (part <= total && total <= maxTotal) return part;
  }
  return null;
}

function getStartTime(episode) {
  const date = parseSrDate((episode.broadcasttime && episode.broadcasttime.starttimeutc) || episode.publishdateutc);
  return date ? date.getTime() : 0;
}

// Series order: by part number when both episodes have one, otherwise oldest first.
function sortSeries(episodes) {
  return episodes.slice().sort((a, b) => {
    const partA = getPartNumber(a.title);
    const partB = getPartNumber(b.title);
    if (partA !== null && partB !== null && partA !== partB) return partA - partB;
    return getStartTime(a) - getStartTime(b) || a.title.localeCompare(b.title, 'sv');
  });
}

function formatDate(date) {
  if (!date) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function httpGetJson(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'volumio-sverigesradio' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpGetJson(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('SR API ' + res.statusCode + ' for ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Invalid JSON from SR API: ' + e.message));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('SR API timeout for ' + url)));
    req.on('error', reject);
  });
}

module.exports = SrApi;
module.exports.getEpisodeAudio = getEpisodeAudio;
module.exports.parseSrDate = parseSrDate;
module.exports.formatDate = formatDate;
module.exports.getPartNumber = getPartNumber;
module.exports.sortSeries = sortSeries;
