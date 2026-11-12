# Contributing

Thanks for helping. The project is small on purpose: no runtime npm dependencies, no bundler, no framework. Electron and electron-builder are the only development dependencies; they make the Windows app.

## Layout

- `electron/`: the Windows app. `main.mjs` starts the server and opens the window; `preload.cjs` is the only bridge to the page (theme colours of the title bar).
- `src/*.mjs`: the local Node server: `app.mjs` (start, single instance), `server.mjs` (`AppServer`: HTTP API, static UI, SSE events), `backend.mjs` (WSL or Windows, path translation), `fsapi.mjs` / `gitapi.mjs` (file browser, Changes panel) and `diagnostics.mjs`.
- `src/engine/*.mjs`: the ORBIX agent. `proc.mjs` (`AgentProc`) is the agent loop; `slash.mjs` slash commands; `tools.mjs`, `webfetch.mjs`, `subagent.mjs`, `mcp.mjs` its tools; `providers.mjs`, `anthropic.mjs`, `openai.mjs`, `catalog.mjs` the model APIs; `store.mjs` saved chats and keys. The UI drives it through JSON requests and its event stream (engine id `builtin` on the wire).
- `web/`: the UI (plain ES modules + CSS). `web/js/store.js` turns the event stream into state; `session.js` and `tools.js` render it.
- `tools/`: `shots.mjs`, which takes the README and website screenshots from a real ORBIX on sample data.

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

There is no CI. Run `npm test` yourself before you open a pull request. `.github/CODEOWNERS` asks the maintainer to review every change.

## License of contributions

ORBIX is licensed under FSL-1.1-MIT (see `LICENSE`). By sending a pull request you agree that your contribution is licensed under the same terms and that the maintainer may also offer it under other licenses, including commercial ones.

## Releasing (maintainer)

1. Bump the version in `package.json`, add a section to `CHANGELOG.md`, run `npm test`.
2. Publish the source release and update the public site as needed.
3. Create a GitHub release `v<version>` and attach the zip.
4. Deploy the site: from the `site` folder run `vercel deploy --prod`.
