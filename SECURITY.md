# Security

ORBIX runs a local server that can start an AI agent (which can run commands and edit files), so it is built to be reachable only from the local browser UI:

- Binds to `127.0.0.1` only.
- Every API call needs a random per-launch token delivered as an HttpOnly, SameSite=Strict cookie.
- `Host` and `Origin` are checked (DNS-rebinding and cross-site protection); state-changing calls also need a custom header.
- A strict Content-Security-Policy is served with the UI (scripts and styles from the app only, no inline code, no workers, and the UI itself cannot be framed); all UI text is inserted as text nodes, never as HTML. Every answer also sends `nosniff`, `X-Frame-Options: DENY`, `no-referrer` and a same-origin resource policy.
- Frames: in a web browser the UI may only frame pages on `localhost` and `127.0.0.1` (the Browser tab's preview of web apps on this computer). In the Windows app the Browser tab is a built-in browser (`electron/browser.mjs`): a `<webview>` that can show any `http`/`https` page, in its own session (`persist:orbix-browser`) apart from ORBIX's window. Its pages get no preload and no Node, run sandboxed with web security on, get no permissions except full screen and clipboard writes (no camera, microphone, location or notifications), and cannot navigate to anything but `http`/`https`; pop-ups open in the same view. Only the ORBIX window can change its download folder or clear its data (Settings → Browser).
- Links from replies open in your default browser, or in the built-in browser if you choose that in Settings → Browser. ORBIX listens only on loopback, and each request needs the session token.
- API keys are verified with the provider, then stored encrypted with Windows DPAPI (current user only). They are decrypted in memory once per run, never sent to the UI, never logged, and only sent to the provider you chose.
- The ORBIX agent asks before every write, edit or command unless you switch it to automatic in Settings.
- Deleting conversations only accepts files inside the app's own sessions folder and is logged to `logs/server.log` in the data folder. The log is capped at 1 MB (one older copy is kept); API keys, agent shell commands and MCP server arguments are never written to it.
- Sign-ins: ChatGPT, xAI, OpenCode and OpenRouter.
  - OpenRouter uses OpenRouter's official PKCE flow; the local callback needs a one-time state that expires after 10 minutes, checks the format of what comes back, and forgets the verifier after use.
  - ChatGPT uses the sign-in of the OpenAI Codex CLI (its public client registration and its `localhost:1455` redirect), because OpenAI does not register third-party apps. It is unofficial and can stop working when OpenAI changes it. The callback listens on loopback only, for one sign-in at a time, and closes when done; if the browser cannot reach it, the address can be pasted into ORBIX instead.
  - xAI and OpenCode use a device code: you confirm a short code on the provider's site, and nothing listens locally. They also use the public client registration of the vendor's own command-line tool.
  - Sign-in tokens are stored like API keys and renewed before they expire.
- `web_fetch` refuses local and private network addresses (also when hidden in IPv6 forms, and when a name resolves to one) unless you typed that host yourself or approve it.
- MCP servers listed in a project's `.mcp.json` only start after you allow them; the question shows the whole command and its environment (secret-looking values masked). A changed config asks again.
- The agent's file tools do not open network shares (`\\host\share`) outside the project's own share, so a path planted in a web page or file cannot make Windows send your credentials to another host.
- The Changes panel runs git with repository programs off (`core.fsmonitor`, external diff, textconv), and file diffs stay inside the project folder.
- Updates come only from this repository's GitHub releases over HTTPS. A downloaded installer runs only if its SHA-512 matches the release's `latest.yml`, and it is never downgraded or taken from a pre-release. A copy run from source never updates itself.
- The installer contains only the app itself (`electron`, `src`, `web`, icons and license files): no user data, tests, logs or caches.

## Reporting a vulnerability

Please report privately (do not open a public issue) by contacting the maintainers through the repository's security-advisory feature. Include steps to reproduce. We aim to acknowledge reports within a few days.

## Scope notes

- The agent runs with the permissions of your Windows user (and your WSL user). Review what you ask it to do.
- Session files can contain secrets that appeared in your conversations. Treat the `sessions` folder in the data folder (`%LOCALAPPDATA%\ORBIX` for the installed app) as sensitive.
