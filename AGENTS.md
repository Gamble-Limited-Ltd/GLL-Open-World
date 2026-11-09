# AGENTS.md

Shared rules for every agent and human on Open World. Read this first, every session. If something here is wrong, fix it in the same PR.

## The project (v2.65 on the dev branch)
- 3D Earth game by Kayne (`kayneheffelfinger-cyber`), who owns it and is the main dev. Gamble Limited Ltd. (James, `TheGeneral4757`) hosts it and helps with hosting, error fixing, repo cleanup and docs.
- Plain HTML/JS, no build step, single-player, no accounts, no backend. State lives in the browser (`localStorage` key `openworld-v2`). Only network calls: OSM Overpass, Nominatim, and same-origin `version.json` (read on boot since v2.24 for the self-update check).
- Files (since v2.60, the modular rebuild): `openworld.html` is the game — a thin page that loads `css/style.css` and `js/boot.js` (native ES modules, no bundler; the importmap points at the copy of three.js in `vendor/three/`). `game.html` is deliberately kept as the pre-v2.59 single-file baseline for A/B comparison — it is NO LONGER a copy of `openworld.html`; do not sync it. `index.html` is the homepage, `version.json` the version feed, and `privacy.html` / `terms.html` are the legal pages (linked from the landing footer and the in-game PRIVACY/TERMS boot modals — keep them true to the game's actual behavior: no accounts, local-only saves, OSM calls, play money; bump their LAST UPDATED date when they change). `admin.html` and `supabase-setup.sql` are legacy (old multiplayer version) and should not be extended.
- Module layout (dependencies point one way, bottom → top: config/util/state/save → core → world → render → systems; `js/boot.js` imports everything in the original section order and binds the late references):
  - `js/config.js` static catalog · `js/util.js` pure helpers · `js/state.js` the shared STATE object · `js/save.js` load/save + migrations
  - `js/core.js` land mask + coastlines · `js/world/` osm, earth, world, city, actors, worldforest · `js/render/` main, night
  - `js/systems/` one file per system: economy, market, eco, tutorial, openhouse, property, farmland, machines, landlord, mining, rivals, exchange, works, builder, factory, furniture, power, oilrig
  - `js/ui/dom.js` toast/modal/tooltip/veil
- **Hosted-site saves (`js/sync.js`):** on a host that serves `/api` (the hosted site) the game signs the player in with a GLL ID and keeps a server copy of the save; anywhere else (GitHub Pages, local files) it does nothing. `localStorage` stays the working copy, `saveGame()` calls `onSaved()` after writing it. The server only relies on this contract, so keep it true: the save under `openworld-v2` is a JSON object with a numeric `ts` and a `v`, under 2 MB. Everything else in the pack can change freely. `node scripts/sync-test.mjs` checks the sync logic.
- **New features go in `js/systems/` as a NEW file**, on the additive patch-chain pattern the game already uses: wrap `ECO.openEmpire` / `WORLD.update` / `clickPick` (via `patchClickPick`), attach a `window.X` QA surface, keep state in `STATE`, save through the existing pack fields. Import only from modules earlier in the list; never add a circular import. The five late-bound forward references (`ECO→PWR/LORD`, `night→PWR/MINE/BLD/EXCH/RIVALS/MACH/FURN`, `world→CITY`, `save→ACTORS`, and the system chains) resolve in `js/boot.js` — add new ones there.
- License: PolyForm Noncommercial 1.0.0 (`LICENSE`). Play money only: no real-money features, ever.

## Branches and releases
- `TopTierDevelopment-Thiessen` is Kayne's dev branch and what GitHub Pages serves.
- `main` is what may go to Gamble Limited's production server, which pulls `main`. Kayne may merge to `main` himself, no review needed. Do not put broken code on `main`.
- Anyone else works on a branch and opens a PR. `git fetch` before starting: pushes can arrive at any time.
- When the game changes, bump the version everywhere it appears (`js/config.js` `GAME_VERSION`, `js/render/night.js` What's-New card + `js/boot.js` ready log, `openworld.html` title/footer, `index.html` `?v=` and news blurb, `version.json`) and add a line to `CHANGES.md`. The `index.html` release summary (`<div class="news">`) and the boot-screen fine print (`#veil .at` in `openworld.html`) are each capped at **200 words**, CI-enforced: the new version gets a short paragraph/line, older releases compress to one line each, and the full log lives in `CHANGES.md` — when a new version ships, fold the previous lead paragraph into the one-line list. The `.at` line always keeps the map attribution ("Map data © OpenStreetMap contributors (ODbL)"). Leave `game.html` untouched (baseline).

## Rules that keep it hostable (agents: check before you commit)
- Use relative URLs only. No hardcoded hostnames (the production domain changes and may rotate). No `*.github.io` URLs in game code.
- No secrets, keys, passwords or private URLs in the repo. Do not add a backend key to any HTML file.
- No new external scripts or fonts without saying so in the PR: production adds a Content-Security-Policy, so every external host must be listed.
- Do not add inline code that depends on a specific origin. Saves are per origin, so a new domain starts empty: any save export/import feature is welcome.
- Do not copy code from other people's games.

## Ops (hosted game)
- Check, restart, stop, start or update the hosted game: `gh workflow run ops.yml -R Gamble-Limited-Ltd/GLL-Open-World -f action=<status|restart|start|stop|sync>`. The server notices within about a minute and does it. `sync` pulls the latest `main` now (it also happens every 5 minutes by itself).
- See the result: https://open-world.taps-holdings.org/__ops/status.json (container state, deployed commit, last action and who asked).
- Only those five actions exist, and only for Kayne and James. There is no server access; ask James (`TheGeneral4757`) for anything else.

## Working together
- Use GitHub issues and PRs. Assign whoever has to act (gear icon). Needs Kayne: assign `kayneheffelfinger-cyber`. Needs James: assign `TheGeneral4757`.
- Found a bug or a problem? Open an issue, assign the person who owns it.
- Claude (James's agent) only runs when James mentions `@claude`. It works on a branch and opens a PR.
- Big jobs (hosting, cleanup, CI, docs, error fixing) are Gamble Limited's; gameplay and design are Kayne's.
