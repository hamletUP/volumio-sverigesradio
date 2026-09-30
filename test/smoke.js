'use strict';

// Smoke test: runs the controller against the real SR API with a mocked Volumio context.
// Usage: node test/smoke.js

const assert = require('assert');
const libQ = require('kew');
const Controller = require('../index');

const fs = require('fs');
const os = require('os');
const path = require('path');

// v-conf writes on set(); use a throwaway copy of the default config.
const configCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-')), 'config.json');
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), configCopy);

// Minimal stand-in for Volumio's favourites storage.
const volumioFavorites = [];
let mpdPushes = 0;
const mpdCommands = [];
const consumeIgnoreMeta = [];
const context = {
  logger: { info() {}, warn() {}, error: (m) => console.error('LOG ERROR', m) },
  configManager: {},
  coreCommand: {
    sharedVars: { get: () => 'sv' },
    pluginManager: {
      getConfigurationFile: () => configCopy,
      getPlugin: () => ({
        sendMpdCommand: (cmd) => { mpdCommands.push(cmd); return libQ.resolve(); },
        getState: () => libQ.resolve({ status: 'play' }),
        pushState: () => { mpdPushes++; return libQ.resolve(); }
      })
    },
    volumioAddToBrowseSources: (src) => assert.strictEqual(src.uri, 'sr'),
    pushToastMessage: () => {},
    volumioPushQueue: () => libQ.resolve(),
    playListManager: {
      favouritesPlaylistFolder: '/fav/',
      getFavouritesContent: () => libQ.resolve(volumioFavorites.slice()),
      // What Volumio's generic path does: explode the uri and store the first track.
      commonAddToPlaylist: (folder, name, service, uri) => {
        assert.strictEqual(name, 'favourites');
        return c.explodeUri(uri).then((tracks) => {
          const t = tracks[0];
          volumioFavorites.push({ service: service, uri: uri, title: t.name, artist: t.artist, album: t.album, albumart: t.albumart });
          return { service: service, uri: uri, favourite: true };
        });
      }
    },
    stateMachine: {
      setConsumeUpdateService: (svc, ignoreMeta) => { assert.strictEqual(svc, 'mpd'); consumeIgnoreMeta.push(ignoreMeta); },
      currentPosition: 0,
      playQueue: { arrayQueue: [], saveQueue() {}, defaultChannels: 2 },
      updateTrackBlock() {},
      getTrack(i) { return this.playQueue.arrayQueue[i]; }
    }
  }
};

const toPromise = (k) => new Promise((resolve, reject) => k.then(resolve).fail(reject));

let c;
(async () => {
  c = new Controller(context);
  await toPromise(c.onVolumioStart());
  await toPromise(c.onStart());

  const root = await toPromise(c.handleBrowseUri('sr'));
  console.log('root:', root.navigation.lists[0].items.map((i) => i.title).join(', '));

  const live = await toPromise(c.handleBrowseUri('sr/live'));
  console.log('live lists:', live.navigation.lists.map((l) => l.title + ' (' + l.items.length + ')').join(', '));
  const p1Live = live.navigation.lists[0].items.find((i) => i.title === 'P1');
  console.log('  P1 now:', p1Live.artist, '|', p1Live.type, p1Live.uri);
  assert.strictEqual(p1Live.type, 'webradio');
  const liveTracks = await toPromise(c.explodeUri(p1Live.uri));
  console.log('  live track:', JSON.stringify(liveTracks[0]));
  mpdCommands.length = 0;
  const sm0 = context.coreCommand.stateMachine;
  sm0.playQueue.arrayQueue = [Object.assign({}, liveTracks[0])];
  sm0.currentPosition = 0;
  await toPromise(c.clearAddPlayTrack(liveTracks[0]));
  console.log('  mpd:', mpdCommands[2], '| ignore stream metadata:', consumeIgnoreMeta.pop());
  assert.strictEqual(mpdCommands[2], 'add "https://www.sverigesradio.se/topsy/direkt/srapi/132-hi.aac"');
  await new Promise((r) => setTimeout(r, 1500));
  clearTimeout(c.liveTitleTimer);
  console.log('  live title in player:', sm0.playQueue.arrayQueue[0].name, '| artist:', sm0.playQueue.arrayQueue[0].artist, '| state pushes:', mpdPushes);
  assert.strictEqual(sm0.playQueue.arrayQueue[0].name, p1Live.artist);
  assert.strictEqual(mpdPushes, 1);

  const cats = await toPromise(c.handleBrowseUri('sr/categories'));
  console.log('categories:', cats.navigation.lists[0].items.length);

  const docu = await toPromise(c.handleBrowseUri('sr/category/82'));
  console.log('Dokumentär programs:', docu.navigation.lists[0].title, docu.navigation.lists[0].items.length);

  const channels = await toPromise(c.handleBrowseUri('sr/channels'));
  console.log('channels:', channels.navigation.lists[0].items.length);

  const p1 = await toPromise(c.handleBrowseUri('sr/channel/132'));
  console.log('P1 programs:', p1.navigation.lists[0].items.length);

  const all = await toPromise(c.handleBrowseUri('sr/programs'));
  console.log('all programs:', all.navigation.lists[0].items.length);

  const prog = await toPromise(c.handleBrowseUri('sr/program/909'));
  const episodeList = prog.navigation.lists[prog.navigation.lists.length - 1];
  const items = episodeList.items;
  console.log('P1 Dokumentär page 1:', episodeList.title, items.length, 'items; prev =', prog.navigation.prev.uri);
  console.log('  first:', items[0].title, '|', items[0].album, '|', items[0].uri);
  console.log('  last :', items[items.length - 1].title, '|', items[items.length - 1].uri);

  const page2 = await toPromise(c.handleBrowseUri('sr/program/909/2'));
  console.log('page 2 prev =', page2.navigation.prev.uri);

  const tracks = await toPromise(c.explodeUri(items[0].uri));
  console.log('explode episode:', JSON.stringify(tracks[0], null, 2));

  // On-demand (non-podcast) program: broadcast files
  const regional = await toPromise(c.handleBrowseUri('sr/program/229'));
  const rList = regional.navigation.lists[regional.navigation.lists.length - 1];
  const rTracks = await toPromise(c.explodeUri(rList.items[0].uri));
  console.log('broadcast episode url:', rTracks[0].streamUrl, rTracks[0].trackType, rTracks[0].duration);

  const folderTracks = await toPromise(c.explodeUri('sr/program/909'));
  console.log('explode program folder:', folderTracks.length, 'tracks');

  const search = await toPromise(c.search({ value: 'dokumentär' }));
  console.log('search lists:', search.map((l) => l.title + ' (' + l.items.length + ')').join(', '));
  const searchP4 = await toPromise(c.search({ value: 'p4 göteborg' }));
  console.log('search "p4 göteborg":', searchP4.map((l) => l.title + ' (' + l.items.length + ')').join(', '));

  // Series: P3 Mix has "Europe's Biggest Dance Show 2026" split into parts
  const { getPartNumber, sortSeries } = require('../lib/srApi');
  assert.strictEqual(getPartNumber("Europe's Biggest Dance Show 2026 Del 3 - NRK P3"), 3);
  assert.strictEqual(getPartNumber('Mordet 2:3'), 2);
  assert.strictEqual(getPartNumber('Ekot 08:00 Nyheter'), null);
  const sorted = sortSeries([
    { title: 'X Del 2', publishdateutc: '/Date(1000)/' },
    { title: 'X intro', publishdateutc: '/Date(500)/' },
    { title: 'X Del 1', publishdateutc: '/Date(1000)/' }
  ]).map((e) => e.title);
  assert.deepStrictEqual(sorted, ['X intro', 'X Del 1', 'X Del 2']);

  let t0 = Date.now();
  const mix = await toPromise(c.handleBrowseUri('sr/program/5047'));
  console.log('P3 Mix lists (' + (Date.now() - t0) + ' ms):', mix.navigation.lists.map((l) => l.title + ' (' + l.items.length + ')').join(', '));
  const seriesList = mix.navigation.lists[0];
  seriesList.items.forEach((i) => console.log('  series:', i.title, i.uri));
  t0 = Date.now();
  await toPromise(c.handleBrowseUri('sr/program/5047'));
  console.log('  cached re-browse:', Date.now() - t0, 'ms');

  const ebds = seriesList.items.find((i) => i.title.startsWith("Europe's Biggest Dance Show"));
  assert.ok(ebds, 'series folder found');
  const group = await toPromise(c.handleBrowseUri(ebds.uri));
  console.log('group view, prev =', group.navigation.prev.uri);
  group.navigation.lists[0].items.forEach((i) => console.log('  ', i.title));
  assert.ok(/Del 1/.test(group.navigation.lists[0].items[1].title));
  assert.ok(/Del 6/.test(group.navigation.lists[0].items[6].title));

  const groupTracks = await toPromise(c.explodeUri(ebds.uri));
  console.log('explode group:', groupTracks.length, 'tracks:', groupTracks.map((t) => t.trackType).join(','));
  assert.ok(groupTracks.every((t) => ['mp3', 'aac', 'm4a'].includes(t.trackType)));

  // Continue series regardless of entry point: start Del 3 from a "search result" list
  const sm = context.coreCommand.stateMachine;
  const ep = (id, title) => ({ service: 'sverigesradio', uri: 'sr/episode/' + id, title: title });
  const groupEpisodes = group.navigation.lists[0].items; // intro, Del 1..6
  const del = (n) => groupEpisodes[n];
  sm.playQueue.arrayQueue = [
    ep(111, 'Något annat'),
    { service: 'sverigesradio', uri: del(3).uri, title: del(3).title },
    ep(222, 'Annan sökträff'),
    { service: 'sverigesradio', uri: del(1).uri, title: del(1).title },
    { service: 'webradio', uri: 'http://example/stream', title: 'Webradio' }
  ];
  sm.currentPosition = 1;
  c.continueSeriesAfter({ uri: del(3).uri });
  await new Promise((r) => setTimeout(r, 3000));
  clearTimeout(c.seriesRecheckTimer);
  const titles = sm.playQueue.arrayQueue.map((q) => q.title);
  console.log('queue after starting Del 3 from search:');
  titles.forEach((t, i) => console.log('  ' + i + (i === sm.currentPosition ? ' ▶ ' : '   ') + t));
  assert.deepStrictEqual(titles.slice(0, 5).map((t) => (/Del (\d)/.exec(t) || [, t])[1]), ['Något annat', '3', '4', '5', '6']);
  assert.deepStrictEqual(titles.slice(5), ['Annan sökträff', 'Webradio']);

  // Idempotent: already arranged → no change
  assert.strictEqual(c.arrangeQueueForSeries(del(3).uri, [], new Set()), false);

  // Editorial collections don't trigger continuation
  const collection = await c.api.findSeriesContinuation(2864625);
  console.log('collection episode continuation:', collection);
  assert.strictEqual(collection, null);

  mpdCommands.length = 0;
  await toPromise(c.clearAddPlayTrack(tracks[0]));
  console.log('mpd:', mpdCommands);
  assert.strictEqual(consumeIgnoreMeta.pop(), true);
  assert.ok(mpdCommands[2].startsWith('add "https://'));

  // Track without streamUrl falls back to re-exploding
  mpdCommands.length = 0;
  await toPromise(c.clearAddPlayTrack({ uri: tracks[0].uri }));
  assert.ok(mpdCommands[2].startsWith('add "https://'));

  // --- Favourites ---
  const fav0 = await toPromise(c.handleBrowseUri('sr/favorites'));
  console.log('favorites (empty):', fav0.navigation.lists[0].items[0].title);

  await toPromise(c.addToFavourites({ uri: 'sr/live/132', service: 'sverigesradio' }));
  await toPromise(c.addToFavourites({ uri: 'sr/program/5047', service: 'sverigesradio' }));
  await toPromise(c.addToFavourites({ uri: ebds.uri, service: 'sverigesradio' }));
  await toPromise(c.addToFavourites({ uri: tracks[0].uri, service: 'sverigesradio' }));
  await toPromise(c.addToFavourites({ uri: 'sr/program/5047', service: 'sverigesradio' })); // duplicate ignored

  const fav = await toPromise(c.handleBrowseUri('sr/favorites'));
  console.log('favorites:');
  fav.navigation.lists.forEach((l) => l.items.forEach((i) => console.log('  [' + l.title + '] ' + i.title + ' (' + i.type + ', ' + i.uri + ')')));
  assert.deepStrictEqual(fav.navigation.lists.map((l) => l.items.length), [1, 2, 1]);
  assert.ok(fav.navigation.lists.every((l) => l.items.every((i) => i.favourite === true)));
  assert.strictEqual(fav.navigation.lists[0].items[0].title, 'P1');

  // Favourite flags show up while browsing
  const mixAgain = await toPromise(c.handleBrowseUri('sr/channel/164'));
  assert.ok(mixAgain.navigation.lists[0].items.find((i) => i.uri === 'sr/program/5047').favourite);
  const liveAgain = await toPromise(c.handleBrowseUri('sr/live'));
  assert.ok(liveAgain.navigation.lists[0].items.find((i) => i.uri === 'sr/live/132').favourite);
  assert.ok(!liveAgain.navigation.lists[0].items.find((i) => i.uri === 'sr/live/163').favourite);

  await toPromise(c.removeFromFavourites({ uri: 'sr/program/5047', service: 'sverigesradio' }));
  assert.strictEqual(c.getFolderFavorites().length, 1);
  assert.ok(JSON.parse(fs.readFileSync(configCopy, 'utf8')).favorites.value.includes(ebds.uri) || c.getFolderFavorites()[0].uri === ebds.uri);

  console.log('\nOK');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
