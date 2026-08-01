# Trailmark

An offline hiking companion. Load a GPX route, download its map tiles to your
phone, then track your position along it with no signal.

## Why it can't live in Google Drive

Google deprecated web hosting in Drive in August 2015 and switched it off
entirely on 31 August 2016. Drive now treats an uploaded `.html` as a document:
clicking it opens Drive's internal viewer, which strips `<script>` tags and
blocks external resources. There is no setting that changes this.

Browsers also only grant GPS access on **secure origins** — an `https://` page.
A file opened from your phone's storage is a `file://` page, so location is
blocked outright. That's the "Origin does not have permission" error.

So this needs real static hosting. GitHub Pages is free and gives you HTTPS.

## Putting it online (about 5 minutes)

1. Create a free account at github.com if you don't have one.
2. Click **+ → New repository**. Name it `trailmark`. Set it to **Public**.
   Tick nothing else. Create it.
3. On the empty repo page click **uploading an existing file**.
4. Drag in all of these, then **Commit changes**:
   - `index.html`
   - `app.js`
   - `sw.js`
   - `manifest.json`
   - `icon-192.png`
   - `icon-512.png`
5. Go to **Settings → Pages**. Under *Source* pick **Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
6. Wait a minute or two, then open
   `https://YOUR-USERNAME.github.io/trailmark/`

That URL is your app. Bookmark it.

### Install it to your home screen

- **iPhone (Safari):** open the URL → Share → *Add to Home Screen*
- **Android (Chrome):** open the URL → ⋮ menu → *Install app*

Installed, it opens full-screen with no browser chrome and keeps working with
no signal.

## Using it

**Load a route.** Tap *Routes* → *Choose a .gpx file*. Export GPX from OS Maps,
Komoot, AllTrails, Strava, plotaroute — anything that produces GPX. Routes are
stored on the device and persist between sessions.

**Download the map.** Tap *Offline* → pick a detail level → *Download for
offline*. Do this on wi-fi before you leave. Rough sizes for a 20 km walk:

| Detail   | Tiles  | Size    |
|----------|--------|---------|
| Light    | ~250   | ~5 MB   |
| Standard | ~700   | ~14 MB  |
| Fine     | ~1,600 | ~31 MB  |

Longer routes scale up proportionally. Downloads are capped at 3,000 tiles —
if you hit it, drop a detail level or split the route in two.

**Test it properly:** put the phone in aeroplane mode at home and check the map
still draws before you rely on it.

**Track.** Tap *Start tracking*. It shows your position, snaps it to the route
to work out how far you've come, warns when you stray more than 75 m off the
line, and estimates your finish time — from your actual pace once you've been
going a while, from Naismith's rule before that.

**No GPS?** Tap anywhere on the elevation strip to set your position by hand.
Everything else keeps working.

## The grid reference

The big monospace readout is your live OS grid reference. That is the thing to
read out if you ever have to phone 999 and ask for Mountain Rescue or the
Coastguard. It's computed via a Helmert transform from WGS84 to OSGB36 and
checked against known points (Ben Nevis summit → NN 166 712, Seaford seafront →
TV 487 982). Accurate to a few metres; it returns blank outside Great Britain.

## Map tiles

Tiles come from OpenStreetMap and OpenTopoMap — free, volunteer-funded
community servers. The app throttles downloads and caps them deliberately.
Please keep it to routes you're actually walking rather than pre-loading whole
counties. If you ever want heavy use, plug in a paid tile provider's URL in the
`TILE_SOURCES` object at the top of `app.js`.

Toggle between topo (contours, paths — better for hills) and street with the
▦ button.

## The sample GPX

`seven-sisters-SAMPLE.gpx` is a **rough hand-plotted line**, not a surveyed
route. It measures 17.8 km against the real walk's 21.2 km because it cuts
corners, and it under-reports ascent. It's there so you can test the app works
before you trust it. For the actual walk, export the real GPX from OS Maps.

## What this is and isn't

It's a route-follower: it tells you where you are relative to a line you
planned. It is not a replacement for a paper OS map and compass, and it can't
route-find or reroute you. Chalk clifftops and hill fog are both unforgiving —
carry the paper map.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and styling |
| `app.js` | Map renderer, tile cache, GPX parsing, GPS tracking |
| `sw.js` | Service worker — makes the app itself load offline |
| `manifest.json` | Home-screen install metadata |
| `icon-*.png` | App icons |
