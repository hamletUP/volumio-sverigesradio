# Sveriges Radio for Volumio

> Unofficial plugin. Not developed by or affiliated with Sveriges Radio.

A Volumio music service plugin for [Sveriges Radio](https://www.sverigesradio.se), the Swedish public broadcaster. It plays live channels and lets you browse the program and podcast archive. It uses the [Sveriges Radio Open API](https://api.sr.se/api/documentation/v2/).

The plugin UI is available in Swedish and English and follows Volumio's language setting.

## Features

- **Favourites** at the top of the start page: channels, programs, series and episodes you have marked with ♥ or "Add to favourites" in the item menu. The heart in the player works for both episodes and live streams.
- **Live**: all channels, grouped as national, P4 local, more channels, minority languages, and extra broadcasts while something is on air. Each channel shows what is on now. The player title follows the schedule and changes when the next program starts. Pausing a live stream stops it, and play rejoins the live broadcast.
- **Categories** → programs → episodes
- **Channels** (P1, P2, P3, all P4 stations …) → programs → episodes
- **All programs A–Z**
- **Search** from Volumio's search field: matches channel and program names and searches episodes
- Episodes are listed newest first, with paging ("Older episodes")
- **Series**: a program's series and collections (SR "episode groups") are shown at the top. Parts are listed in order, so starting part 1 plays parts 2, 3 … automatically afterwards. Playing the series folder queues all parts.
- **Continue series automatically**: when you play a part of a numbered series, however you found it (search, program list, favourites), the following parts are queued right after it.
- Playing a whole program queues the episodes on the current page
- Podcast files (MP3) are preferred, with on-demand broadcast files (M4A/AAC) as fallback
- Settings: audio quality (live: AAC 320/128/32 kbit/s), episodes per page, show series on/off, continue series on/off

## Installation

One release works for both Volumio 3 and 4:

| Version | Status |
| --- | --- |
| Volumio 3 (buster, Node 14) | Tested (3.912) |
| Volumio 4 (bookworm, Node 20) | Untested. It should work, since it uses only Node core modules and has no native dependencies. Reports welcome. |

Volumio's plugin manager checks `engines` (`node >=14`, `volumio >=3`) on install and on system upgrade. The plugin therefore installs on both versions and stays enabled when you upgrade from 3 to 4.

Installation requires SSH, which you can enable at `http://volumio.local/dev`.

**From a release zip:**

```bash
ssh volumio@volumio.local
wget https://github.com/hamletUP/volumio-sverigesradio/releases/download/v0.1.0/sverigesradio-0.1.0.zip
mkdir sverigesradio && cd sverigesradio && unzip ../sverigesradio-0.1.0.zip
volumio plugin install
```

**From source:**

```bash
ssh volumio@volumio.local
git clone https://github.com/hamletUP/volumio-sverigesradio.git sverigesradio
cd sverigesradio && npm install --production
volumio plugin install
```

Then enable the plugin under **Plugins → Installed plugins**. "Sveriges Radio" appears under **Browse**.

For development, run `volumio plugin refresh` and `volumio vrestart` after changes. To follow the logs, run `journalctl -f | grep '\[SR\]'`.

## Releasing a new version

1. Bump `version` in `package.json` and update `volumio_info.changelog`.
2. Run `npm test`.
3. Run `npm run package`. It builds `dist/sverigesradio-<version>.zip` with production dependencies and the files at the zip root.
4. Create a GitHub release tagged `v<version>` and attach the zip.

### Volumio plugin store

The Volumio 3 repository (`volumio/volumio-plugins-sources`) no longer accepts new plugins, so the store requires Volumio 4 (bookworm):

1. Fork `volumio/volumio-plugins-sources-bookworm` and clone the fork **on a Volumio 4 device**.
2. Copy the plugin to `sverigesradio/` and write the bookworm variant of `package.json` with `node scripts/bookworm.js > <fork>/sverigesradio/package.json`. It sets `os`, `architectures` and `engines` as the store requires.
3. Run `volumio plugin install`, test, uninstall and test again. Then remove `node_modules`.
4. Commit, push and open a PR against Volumio's repository. Run `volumio plugin submit` from the device.
5. The plugin is then in **beta** and visible with "plugin test mode" enabled. It becomes stable once the Volumio team has reviewed it. Every update needs a new version number, a new submit and a new PR.

> Note: Sveriges Radio states that its Open API "is no longer maintained but can be used until further notice".

## Local testing

```bash
npm install
npm test
```

The smoke test runs the plugin controller against the live SR API, with a mocked Volumio environment and a fake MPD.

## Project structure

| File | Contents |
| --- | --- |
| `index.js` | Volumio controller: browse, search, explodeUri, playback through MPD, favourites |
| `lib/srApi.js` | API client (Node core modules only) with caching |
| `UIConfig.json`, `config.json` | Settings page and defaults |
| `i18n/` | Swedish and English strings |
| `scripts/package.sh` | Builds the release zip |
| `scripts/bookworm.js` | `package.json` for the Volumio 4 store |

## URI scheme

```
sr                         root menu
sr/favorites               favourites
sr/live                    live channels
sr/live/<channelId>        live stream
sr/categories              categories
sr/category/<id>           programs in a category
sr/channels                channels
sr/channel/<id>            programs on a channel
sr/programs                all programs
sr/program/<id>[/<page>]   episodes (and the program's series)
sr/group/<id>              series or collection, in series order
sr/episode/<id>            playable episode
```

## How series are detected

The API's episode listings carry no series information. It is only available from `episodes/get` (the `episodegroups` field). When a program is opened, the plugin therefore fetches the details of the episodes on the page, with 8 requests in parallel and a 24-hour cache. This takes about 0.3–0.6 s the first time. The groups themselves are then fetched from `episodes/group`.

Groups are returned unsorted. They are ordered by the part number in the title ("Del 3", "Avsnitt 3", "Part 3", "2:3", "3/8", "Del 2 av 6") when both episodes have one, and otherwise by broadcast time, oldest first.

Groups can also be editorial collections (such as "Upptäck fler dokumentärer", "Discover more documentaries"). These are shown in the same list.

## Continue series automatically

When an episode starts playing, the plugin looks up its groups in the background. A group counts as a numbered series if at least two episodes, and at least half of the group, have a part number in the title. Collections are therefore ignored. For a series, the queue is rewritten as:

```
[everything before the current episode] [current episode] [following parts, in order] [rest of the queue, without other parts of the series]
```

Nothing before the current episode changes, so Volumio's queue position stays valid. The check runs once more after 5 s, because Volumio appends the rest of a clicked list only after playback has started. The queue is not reordered in shuffle mode.

## Favourites

- **Episodes and channels** are stored in Volumio's own favourites. They also appear under Volumio's "Favourites" and are included in Volumio backups and MyVolumio.
- **Programs and series** are folders, which Volumio's generic favourites cannot store. They are typed as `folder-with-favourites` and stored by the plugin (`favorites` in `config.json`) through `addToFavourites`/`removeFromFavourites`.
- The plugin's favourites view shows both sources. Items that are already favourites are flagged with `favourite: true` in every list, so the menu offers "Remove from favourites".
- Live streams take their metadata from the queue, like episodes, so the player's `uri` is `sr/live/<id>` and the heart saves the right channel. The title is kept current from `scheduledepisodes/rightnow`, which is checked just after each program ends before MPD's state is pushed again.

## License

[MIT](LICENSE)
