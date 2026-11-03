# Contributing

Thanks for helping! The project is intentionally small: no npm dependencies, no bundler, no framework.

## Layout

- `host/Program.cs`: the native window (C# 5, WinForms + WebView2). Built by `npm run build` with the compiler that ships with Windows.
- `src/*.mjs`: the local Node server: `main.mjs` (start, single instance), `server.mjs` (`AppServer`: HTTP API, static UI, SSE events), `backend.mjs` (WSL or Windows, path translation), `fsapi.mjs` / `gitapi.mjs` (file browser, Changes panel), `diagnostics.mjs`, and the optional OMP CLI (`proc.mjs`, `auth.mjs`, `ompcfg.mjs`, `sessions.mjs`).
- `src/engine/*.mjs`: the ORBIX agent. `proc.mjs` (`AgentProc`) is the agent loop; `slash.mjs` slash commands; `tools.mjs`, `webfetch.mjs`, `subagent.mjs`, `mcp.mjs` its tools; `providers.mjs`, `anthropic.mjs`, `openai.mjs`, `catalog.mjs` the model APIs; `store.mjs` saved chats and keys. It emits the same events as an OMP process (engine id `builtin` on the wire), so the UI treats both alike.
- `web/`: the UI (plain ES modules + CSS). `web/js/store.js` turns the event stream into state; `session.js` and `tools.js` render it.
- `tools/`: build, packaging (bundles a checksum-verified Node.js), icon and doctor scripts.

## Ground rules

1. Keep it dependency-free and light. Prefer a small helper over a library.
2. Never insert untrusted text with `innerHTML`; use the `h()` helper (text nodes only).
3. Show real data only. If something is unknown, say so; never invent values.
4. Everything the app writes goes under its own `data/` folder (or `ORBIX_DATA`). Nothing in WSL except what the optional OMP CLI itself writes.
5. Destructive actions need an explicit confirmation and must be logged.

## Try your change

`node src/main.mjs --no-window` starts the server alone and prints its URL. `npm run doctor` prints the Diagnostics checks. `npm run build` rebuilds the exe; `npm run package` makes the portable zip.

## Tests

`npm test` runs the regression suite in `test/` (Node's built-in runner, no dependencies, no network, no provider keys, nothing written outside a temp folder: each file points `ORBIX_DATA` at one). Add a test with every fix. A pure helper that has a test is exported so the test can import it; keep other helpers private, and keep an export when a test imports it.

## License of contributions

ORBIX is licensed under FSL-1.1-MIT (see `LICENSE`). By sending a pull request you agree that your contribution is licensed under the same terms and that the maintainer may also offer it under other licenses, including commercial ones.

## Releasing (maintainer)

1. Bump the version in `package.json`, add a section to `CHANGELOG.md`, run `npm test`.
2. `npm run package` builds `release\ORBIX-<version>-win-x64.zip` and stamps the version, size and SHA-256 into `site\index.html`.
3. Create a GitHub release `v<version>` and attach the zip.
4. Deploy the site: from the `site` folder run `vercel deploy --prod`.
