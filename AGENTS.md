# AGENTS.md

Shared notes for every agent and human working on Open World. Read this first. Edit it when something here becomes wrong.

## The project
- Open World: 3D Earth strategy game by Kayne (`kayneheffelfinger-cyber`), who owns it and is the main dev. Gamble Limited Ltd. hosts and helps (hosting, error fixing, repo cleanup, docs).
- Plain HTML/JS, no build step. The game is `openworld.html`; `game.html` must stay an identical copy. `index.html` is the homepage, `admin.html` the owner panel, `version.json` the update feed.
- Backend for Kayne's dev: Supabase (`supabase-setup.sql`) on GitHub Pages. Gamble Limited's prod runs on its own server with its own simple database and GATE sign-in; that code lives outside this repo.
- License: PolyForm Noncommercial 1.0.0 (see LICENSE). Hosting by Gamble Limited is covered by the owner's separate agreement with James.
- Play money only. No real-money features.

## Branches
- `main` = what is (or can be) on prod. It is deployed by the server pulling `main`. Do not push broken code to it.
- `TopTierDevelopment-Thiessen` = Kayne's top-tier dev branch (deployed to GitHub Pages).
- Everyone else works on a branch and opens a PR into `main`. Kayne can merge to `main` without anyone's review.
- Always `git fetch` before starting; Kayne pushes at any time.

## Working together
- Use GitHub issues and PRs. Assign the person who needs to act (use the assignee setting). Kayne's agents: assign Kayne or James (`TheGeneral4757`) as fits.
- Found a bug? Open an issue, assign whoever owns it.
- Keep `openworld.html` and `game.html` in sync, bump `version.json`, and note the change in `CHANGES.md`.
- Do not commit secrets, passwords or keys. Do not reuse code from other people's games.
