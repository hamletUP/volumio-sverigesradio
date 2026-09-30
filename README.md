# Sveriges Radio för Volumio

> Inofficiellt plugin, inte utvecklat av eller knutet till Sveriges Radio.

Volumio-plugin (music_service) för Sveriges Radio: direktsändningar från alla kanaler samt program- och poddarkivet. Pluginet använder [Sveriges Radios öppna API](https://api.sr.se/api/documentation/v2/).

## Funktioner

- **Mina favoriter** överst på startsidan: kanaler, program, serier och avsnitt du har markerat med ♥ eller "Lägg till i favoriter" i menyn. Hjärtat i spelaren fungerar både för avsnitt och direktsändningar.
- **Direkt**: alla kanaler grupperade (Rikskanaler, P4 lokalt, Fler kanaler, Minoritet och språk, Extrasändningar när något sänds) med vad som går just nu. Titeln i spelaren följer tablån och byts när nästa program börjar. Paus på en direktsändning stoppar och ansluter live igen vid play.
- **Kategorier** → program → avsnitt
- **Kanaler** (P1, P2, P3, alla P4 …) → program → avsnitt
- **Alla program A–Ö**
- **Sök** via Volumios sökfält: matchar programnamn och söker bland avsnitt
- Avsnitten listas nyast först, med sidbläddring ("Äldre avsnitt")
- **Serier**: programmets serier och samlingar (SR:s "avsnittsgrupper") visas överst. I en serie ligger delarna i ordning, så klickar du på Del 1 spelas Del 2, 3 … automatiskt efteråt. Spelar du hela seriemappen köas alla delar.
- **Fortsätt serien automatiskt**: spelar du en del av en numrerad serie, hur du än hittade den (sök, programlista, favoriter), läggs de följande delarna direkt efter i kön.
- Spela ett helt program: köar avsnitten på den aktuella sidan
- Poddfiler (mp3) används i första hand, annars on-demand-sändningsfiler (m4a/aac)
- Inställningar: ljudkvalitet (direkt: AAC 320/128/32 kbit/s), antal avsnitt per sida, visa serier av/på, fortsätt serie av/på

## Installation på Volumio

Inofficiellt plugin. Samma release fungerar för Volumio 3 och 4:

| Version | Status |
| --- | --- |
| Volumio 3 (buster, Node 14) | Testat (3.912) |
| Volumio 4 (bookworm, Node 20) | Otestat: bör fungera (endast Node core-moduler, inga native-beroenden). Rapportera gärna. |

Volumios pluginhanterare kontrollerar `engines` (`node >=14`, `volumio >=3`) vid installation och uppgradering. Pluginet installeras därför på båda versionerna och följer med vid uppgradering från 3 till 4. Kräver SSH, som slås på via `http://volumio.local/dev`.

**Från en release-zip:**

```bash
ssh volumio@volumio.local
wget https://github.com/hamletUP/volumio-sverigesradio/releases/download/v0.1.0/sverigesradio-0.1.0.zip
mkdir sverigesradio && cd sverigesradio && unzip ../sverigesradio-0.1.0.zip
volumio plugin install
```

**Från källkoden:**

```bash
ssh volumio@volumio.local
git clone https://github.com/hamletUP/volumio-sverigesradio.git sverigesradio
cd sverigesradio && npm install --production
volumio plugin install
```

Aktivera sedan pluginet under **Plugins → Installed plugins**. "Sveriges Radio" dyker upp under **Browse**.

Vid utveckling: efter ändringar kör `volumio plugin refresh` och `volumio vrestart`. Loggar: `journalctl -f | grep '\[SR\]'`.

## Släppa en ny version

1. Höj `version` i `package.json` och uppdatera `volumio_info.changelog`.
2. `npm test`
3. `npm run package` bygger `dist/sverigesradio-<version>.zip`, med produktionsberoenden och filerna i zip-roten.
4. Skapa en GitHub-release med taggen `v<version>` och bifoga zip-filen.

### Volumios pluginbutik

Volumio 3-repot (`volumio/volumio-plugins-sources`) tar inte längre emot nya plugins. Butiken kräver Volumio 4 (bookworm):

1. Forka `volumio/volumio-plugins-sources-bookworm` och klona forken **på en Volumio 4-enhet**.
2. Kopiera pluginet till `sverigesradio/` och skriv bookworm-varianten av `package.json`: `node scripts/bookworm.js > <fork>/sverigesradio/package.json`. Den sätter `os`, `architectures` och `engines` enligt butikens krav.
3. Kör `volumio plugin install`, testa, avinstallera och testa igen. Ta sedan bort `node_modules`.
4. Committa, pusha och öppna en PR mot Volumios repo. Kör `volumio plugin submit` från enheten.
5. Pluginet blir då **beta** och syns med "plugin test mode" påslaget. När Volumio-teamet har granskat det blir det stabilt. Varje uppdatering kräver nytt versionsnummer, ny submit och ny PR.

> Obs: Sveriges Radio anger att deras öppna API "underhålls inte längre men går att använda tillsvidare".

## Test lokalt

```bash
npm install
npm test
```

Röktestet kör pluginets kontroller mot det riktiga API:t med en mockad Volumio-miljö och en fejkad MPD.

## Struktur

| Fil | Innehåll |
| --- | --- |
| `index.js` | Volumio-kontrollern: browse, sök, explodeUri, uppspelning via MPD |
| `lib/srApi.js` | API-klient (endast Node core-moduler) med 10 minuters cache |
| `UIConfig.json`, `config.json` | Inställningssida och standardvärden |
| `i18n/` | Svenska och engelska strängar |
| `scripts/package.sh` | Bygger release-zip |
| `scripts/bookworm.js` | `package.json` för Volumio 4-butiken |

## URI-schema

```
sr                         rotmeny
sr/favorites               mina favoriter
sr/live                    direktkanaler
sr/live/<kanal-id>         direktström
sr/categories              kategorier
sr/category/<id>           program i kategori
sr/channels                kanaler
sr/channel/<id>            program på kanal
sr/programs                alla program
sr/program/<id>[/<sida>]   avsnitt (+ serier)
sr/group/<id>              serie/samling i seriens ordning
sr/episode/<id>            spelbart avsnitt
```

## Hur serier detekteras

API:ts avsnittslistor saknar serieinformation. Den finns bara i `episodes/get` (fältet `episodegroups`). När ett program öppnas hämtas därför detaljerna för avsnitten på sidan (8 parallella anrop, cachas i 24 timmar). Det tar cirka 0,3–0,6 s första gången. Därefter hämtas grupperna via `episodes/group`.

Gruppen levereras osorterad. Ordningen byggs av numret i titeln ("Del 3", "Avsnitt 3", "2:3", "3/8", "Del 2 av 6") när båda avsnitten har ett sådant, och annars av sändningstid, äldst först.

Grupper kan även vara redaktionella samlingar (t.ex. "Upptäck fler dokumentärer"). De visas i samma lista.

## Fortsätt serien automatiskt

När ett avsnitt börjar spelas slår pluginet upp dess grupper i bakgrunden. Gruppen räknas som en numrerad serie om minst två delar och minst hälften av gruppen har delnummer i titeln. Samlingar som "Upptäck fler dokumentärer" räknas alltså inte. För en serie skrivs kön om till:

```
[allt före aktuellt avsnitt] [aktuellt avsnitt] [följande delar i ordning] [resten av kön utan seriens andra delar]
```

Inget före aktuellt avsnitt ändras, så Volumios position stämmer. Kontrollen körs en gång till efter 5 s eftersom Volumio lägger till resten av en klickad lista först när uppspelningen redan har startat. Omordningen görs inte i shuffle-läge.

## Favoriter

- **Avsnitt och kanaler** sparas i Volumios egna favoriter. De syns alltså även under Volumios "Favoriter" och följer med i Volumios backup och MyVolumio.
- **Program och serier** är mappar. Volumios generiska favoritspår kan inte spara mappar, så de typas som `folder-with-favourites` och sparas av pluginet (`favorites` i `config.json`) via `addToFavourites`/`removeFromFavourites`.
- "Mina favoriter" visar båda källorna. Objekt som redan är favoriter märks med `favourite: true` i alla listor, så att menyn erbjuder "Ta bort ur favoriter".
- Direktsändningar tar metadata från kön, precis som avsnitt, så att spelarens `uri` blir `sr/live/<id>` och hjärtat sparar rätt kanal. Titeln hålls aktuell med `scheduledepisodes/rightnow`: den kontrolleras precis efter att programmet slutar och MPD:s tillstånd skickas om.
