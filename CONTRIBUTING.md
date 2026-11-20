# Contributing

Thanks for helping. The project is small on purpose: no bundler, no framework, and one runtime npm dependency (electron-updater, for app updates). Electron and electron-builder are the development dependencies; they make the Windows app.

## Layout

- `electron/`: the Windows app. `main.mjs` starts the server and opens the window; `updater.mjs` installs updates; `preload.cjs` is the only bridge to the page (title bar colours, zoom, updates, app versions).
- `src/*.mjs`: the local Node server: `app.mjs` (start, single instance), `server.mjs` (`AppServer`: HTTP API, static UI, SSE events), `backend.mjs` (WSL or Windows, path translation), `fsapi.mjs` / `gitapi.mjs` (file browser, Changes panel), `runs.mjs` / `runctl.mjs` (runs: storage and controller) and `diagnostics.mjs`.
- `src/engine/*.mjs`: the ORBIX agent. `proc.mjs` (`AgentProc`) is the agent loop, with its other parts beside it in `proc-models.mjs` (model, thinking levels, connections), `proc-tools.mjs` (tool calls and approvals), `proc-checks.mjs` (the check and review after a run) and `proc-usage.mjs` (tokens and cost), joined by `mixin.mjs`; `slash.mjs` slash commands; `tools.mjs`, `webfetch.mjs`, `subagent.mjs`, `mcp.mjs` its tools; `providers.mjs`, `anthropic.mjs`, `openai.mjs`, `chatgpt.mjs`, `catalog.mjs` the model APIs; `store.mjs` saved chats and keys. The UI drives it through JSON requests and its event stream.
- `web/`: the UI (plain ES modules + CSS). `web/js/store.js` turns the event stream into state; `session.js` and `tools.js` render it.
- `tools/`: `shots.mjs`, which takes the README and website screenshots from a real ORBIX on sample data.
- `e2e/`: `npm run e2e` drives the real interface in headless Chromium against a scripted model (see `docs/parity.md`).

## Ground rules

1. Keep it dependency-free and light. Prefer a small helper over a library.
2. Never insert untrusted text with `innerHTML`; use the `h()` helper (text nodes only).
3. Show real data only. If something is unknown, say so; never invent values.
4. Everything the app writes goes under its own `data/` folder (or `ORBIX_DATA`). Nothing is written inside WSL.
5. Destructive actions need an explicit confirmation and must be logged.

## Try your change

`npm install` once, then `npm start` runs the app from source, with its data in `./data`. `npm run dist` builds the installer into `dist/`.

## Tests

`npm test` runs the regression suite in `test/` (Node's built-in runner, no dependencies, no network, no provider keys, nothing written outside a temp folder: each file points `ORBIX_DATA` at one). Add a test with every fix. A pure helper that has a test is exported so the test can import it; keep other helpers private, and keep an export when a test imports it.

## Review

GitHub Actions runs `npm test` on Windows with Node 22 and 24 for every push to `main` and every pull request (`.github/workflows/test.yml`). Run it yourself first. `.github/CODEOWNERS` asks the maintainer to review every change.

## License of contributions

ORBIX is licensed under FSL-1.1-MIT (see `LICENSE`). By sending a pull request you agree that your contribution is licensed under the same terms and that the maintainer may also offer it under other licenses, including commercial ones.

## Releasing (maintainer)

1. Bump the version in `package.json`, give the `CHANGELOG.md` section its version and date, and run `npm test`.
2. If the interface changed, run `npm run shots` to retake the README and website screenshots.
3. Commit, tag `v<version>` and push.
4. `npm run release` builds the installer and publishes it with `latest.yml` and the blockmap to a GitHub release `v<version>` (it needs a `GH_TOKEN`). Installed copies update themselves from that release.
5. Deploy the site: from the `site` folder run `vercel deploy --prod`.
