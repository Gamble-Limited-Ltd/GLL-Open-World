# Open World

A single-player, in-browser tycoon game set on the real Earth. Current version: **v2.23** ("Follow the Road").

Search for any real city and the game builds it from OpenStreetMap data: real streets, buildings, greens and plots, all standing on dry land. Then build your business empire there.

## Play

- Dev build (GitHub Pages): https://gamble-limited-ltd.github.io/GLL-Open-World/
- Hosted version: coming at open-world.taps-holdings.org (not live yet)
- Locally: serve the repo folder with any static web server and open `index.html`, then press PLAY NOW. It needs an internet connection.

## How the game works

The loop, as described in the in-game help:

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
| Rotate | Right-drag (or Ctrl+drag) |
| Zoom | Mouse wheel or pinch |
| Snap back to your tycoon | `C` or the crosshair button |
| Serve customers | `E` while standing at your cart |
| World map | `M` or click the minimap |
| Walk to the nearest city | The gold pill above the bottom bar (routes around water, uses bridges) |
| Teleport to a plot you own | Avatar (top right) |
| Help and tutorial | In-game help, with a REPLAY TUTORIAL button |

## Under the hood

- Static HTML and JavaScript. The whole game is `openworld.html` (about 8,000 lines), with `index.html` as the landing page.
- 3D with three.js 0.160, loaded from unpkg.
- Live calls to OpenStreetMap Overpass (map data) and Nominatim (city search). Map data is (c) OpenStreetMap contributors (ODbL).
- No accounts. Your world is saved in your browser's localStorage under the key `openworld-v2`, so it stays on that browser and device.

## Planned (not built yet)

- Sign in with a GLL account.
- Server-side saves.

## Contributing

Read `AGENTS.md` for the contributor rules. `CHANGES.md` is a short log of what changed and why.

## License

PolyForm Noncommercial 1.0.0. See the `LICENSE` file.
