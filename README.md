# Open World

A single-player, in-browser tycoon game set on the real Earth. Current version: **v2.30** ("Stable Ground").

Search for any real city and the game builds it from OpenStreetMap data: real streets, buildings, greens and plots, all standing on dry land. Since v2.27 the world is 1:1 with the actual Earth — 111,320 meters per degree, 40,007 km around — with real distances between cities, a real horizon, and whole regions visible when you zoom out. Every one of the 64 catalog cities stands at its real spot as a metro-scale skyline before you ever walk there — walk in and it upgrades to the fully detailed downtown, and every inter-city road ends at a real junction with the first street of the city it serves (the skyline's sprawl streets while the city is distant, the imported true streets once you arrive).

## Play

- Dev build (GitHub Pages): https://gamble-limited-ltd.github.io/GLL-Open-World/ — always the newest features
- Hosted version: https://open-world.taps-holdings.org/ — serves `main`, which currently runs an older build than the dev branch
- The project moved to the Gamble-Limited-Ltd org: old bookmarks to `kayneheffelfinger-cyber.github.io/Open-World` no longer resolve
- Locally: serve the repo folder with any static web server and open `index.html`, then press PLAY NOW. It needs an internet connection.

Since v2.24 the game checks `version.json` on every boot: if the site is running a newer build than your browser is, it shows a one-tap **UPDATE NOW** banner that reloads through a cache-busting link — no more silently playing a stale copy while fixes ship around you.

## How the game works

The loop, as described by the in-game starter guide:

1. Buy a green **$** plot.
2. Park a food cart on it.
3. Serve the queue yourself, or hire star vendors.
4. Lease offices in the towers.
5. Trade on the exchange (limit and market orders).
6. Grow your net worth.

## Controls

| Action | How |
|---|---|
| Move your tycoon | Tap or click anywhere (the only way the tycoon walks) |
| Look around | Drag, or WASD / arrow keys / on-screen joystick |
| Rotate / tilt | Right-drag (or middle-drag / Ctrl+drag) |
| Zoom | Mouse wheel or pinch |
| Snap back to your tycoon | `C` or the crosshair button |
| Serve customers | `E` while standing at your cart |
| World map | `M` or click the minimap |
| Walk to the nearest city | The gold pill above the bottom bar (routes around water, uses bridges) — the distance shown is always your tycoon's, and it flags when the view is panned far away from them. At true scale the nearest city can be hundreds of km away: use search, the world map or orbit flight to travel |
| Help and starter guide | In-game Help — the starter guide can be replayed anytime |

## Under the hood

- Static HTML and JavaScript. The whole game is `openworld.html` (about 9,100 lines), with `index.html` as the landing page.
- 3D with three.js 0.160, loaded from unpkg.
- Live calls to OpenStreetMap Overpass (map data) and Nominatim (city search); if Overpass is unreachable, a built-in generator lays out the city instead. Map data is (c) OpenStreetMap contributors (ODbL).
- True-scale Earth (v2.27): one degree is really 111 km and the world spans 40,007 km. World coordinates reach ±20 million meters — past float32 vertex precision — so the static planet (coasts, lakes, roads, bridges) is built as 8° world tiles and city/chunk-local frames, each positioned in double precision. Near every coast the land/water gate answers from the vector coastlines the player actually sees (the 0.25° land raster only settles open ocean and deep interior), and roads that cross vector water become causeways with guard pylons.
- The world is pre-built (v2.26): all 64 cities stand in the world from the moment you enter — distant skylines use the city's true footprint spread to metro scale (true building sizes, no boot-time network calls) and are upgraded to full detail when you arrive.
- Depth-stable ground (v2.30): every world tile's land is a grid of small polygons and every city sits on an exact fine land pad, so at 1:1 scale the city floors are solid (no grass z-fight bleeding through) and the inter-city roads render all the way from each city's streets into the countryside.
- Roads meet the streets (v2.29): each land route keeps a re-trimmable final stretch before every city, so the highway always ends at a junction with the streets that are actually standing — the skyline's sprawl streets from afar, the imported city's true streets up close, ramping down to street level to merge with the real asphalt.
- On boot the game reads same-origin `version.json` and offers the one-tap self-update described above. Saves from earlier versions migrate to the true-scale world: plots keep their spot beside their city, everything else keeps its lat/lon.
- No accounts. Your world is saved in your browser's localStorage under the key `openworld-v2`, so it stays on that browser and device.

## Planned (not built yet)

- Teleport to plots you own.
- More sidewalk plots to buy.
- Sign in with a GLL account.
- Server-side saves.

## Contributing

Read `AGENTS.md` for the contributor rules. `CHANGES.md` is a short log of what changed and why.

## License

PolyForm Noncommercial 1.0.0. See the `LICENSE` file.
