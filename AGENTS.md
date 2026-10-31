# AGENTS.md

Shared rules for every agent and human on Open World. Read this first, every session. If something here is wrong, fix it in the same PR.

## The project (v2.23 on the dev branch)
- 3D Earth game by Kayne (`kayneheffelfinger-cyber`), who owns it and is the main dev. Gamble Limited Ltd. (James, `TheGeneral4757`) hosts it and helps with hosting, error fixing, repo cleanup and docs.
- Plain HTML/JS, no build step, single-player, no accounts, no backend. State lives in the browser (`localStorage` key `openworld-v2`). Only network calls: OSM Overpass and Nominatim.
- Files: `openworld.html` is the game. `game.html` must stay a byte-identical copy of it. `index.html` is the homepage, `home.html` a redirect stub, `version.json` the version feed (nothing reads it yet). `admin.html` and `supabase-setup.sql` are legacy (old multiplayer version) and should not be extended.
- License: PolyForm Noncommercial 1.0.0 (`LICENSE`). Play money only: no real-money features, ever.

## Branches and releases
- `TopTierDevelopment-Thiessen` is Kayne's dev branch and what GitHub Pages serves.
- `main` is what may go to Gamble Limited's production server, which pulls `main`. Kayne may merge to `main` himself, no review needed. Do not put broken code on `main`.
- Anyone else works on a branch and opens a PR. `git fetch` before starting: pushes can arrive at any time.
- When the game changes, bump the version everywhere it appears (`openworld.html` title and footer strings, `index.html` `?v=`, `version.json`) and add a line to `CHANGES.md`. Keep `game.html` identical.

## Rules that keep it hostable (agents: check before you commit)
- Use relative URLs only. No hardcoded hostnames (the production domain changes and may rotate). No `*.github.io` URLs in game code.
- No secrets, keys, passwords or private URLs in the repo. Do not add a backend key to any HTML file.
- No new external scripts or fonts without saying so in the PR: production adds a Content-Security-Policy, so every external host must be listed.
- Do not add inline code that depends on a specific origin. Saves are per origin, so a new domain starts empty: any save export/import feature is welcome.
- Do not copy code from other people's games.

## Ops (hosted game)
- Check, restart, stop, start or update the hosted game: `gh workflow run ops.yml -R Gamble-Limited-Ltd/GLL-Open-World -f action=<status|restart|start|stop|sync>`, then `gh run watch`. `sync` pulls the latest `main` now (it also happens every 5 minutes by itself).
- Only those five actions exist. There is no server access; ask James (`TheGeneral4757`) for anything else.

## Working together
- Use GitHub issues and PRs. Assign whoever has to act (gear icon). Needs Kayne: assign `kayneheffelfinger-cyber`. Needs James: assign `TheGeneral4757`.
- Found a bug or a problem? Open an issue, assign the person who owns it.
- Claude (James's agent) only runs when James mentions `@claude`. It works on a branch and opens a PR.
- Big jobs (hosting, cleanup, CI, docs, error fixing) are Gamble Limited's; gameplay and design are Kayne's.
