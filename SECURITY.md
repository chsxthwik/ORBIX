# Security

ORBIX runs a local server that can start an AI agent (which can run commands and edit files), so it is built to be reachable only from the local browser UI:

- Binds to `127.0.0.1` only.
- Every API call needs a random per-launch token delivered as an HttpOnly, SameSite=Strict cookie.
- `Host` and `Origin` are checked (DNS-rebinding and cross-site protection); state-changing calls also need a custom header.
- A strict Content-Security-Policy is served with the UI (scripts and styles from the app only, no inline code, no frames or workers); all UI text is inserted as text nodes, never as HTML. Every answer also sends `nosniff`, `X-Frame-Options: DENY`, `no-referrer` and a same-origin resource policy.
- The interface is served locally to the ORBIX window, which only shows ORBIX itself; links open in your default browser. ORBIX listens only on loopback, and each request needs the session token.
- API keys are verified with the provider, then stored encrypted with Windows DPAPI (current user only). They are decrypted in memory once per run, never sent to the UI, never logged, and only sent to the provider you chose.
- The ORBIX agent asks before every write, edit or command unless you switch it to automatic in Settings.
- Deleting conversations only accepts files inside the app's own sessions folder and is logged to `data/logs/server.log`. The log is capped at 1 MB (one older copy is kept); API keys, agent shell commands and MCP server arguments are never written to it.
- Sign in with OpenRouter uses OpenRouter's official PKCE flow; the local callback needs a one-time state that expires after 10 minutes, checks the format of what comes back, and forgets the verifier after use.
- `web_fetch` refuses local and private network addresses (also when hidden in IPv6 forms, and when a name resolves to one) unless you typed that host yourself or approve it.
- MCP servers listed in a project's `.mcp.json` only start after you allow them; the question shows the whole command and its environment (secret-looking values masked). A changed config asks again.
- The agent's file tools do not open network shares (`\\host\share`) outside the project's own share, so a path planted in a web page or file cannot make Windows send your credentials to another host.
- The Changes panel runs git with repository programs off (`core.fsmonitor`, external diff, textconv), and file diffs stay inside the project folder.
- Updates come only from this repository's GitHub releases over HTTPS. A downloaded installer runs only if its SHA-512 matches the release's `latest.yml`, and it is never downgraded or taken from a pre-release. A copy run from source never updates itself.
- Release zips are checked at build time: no user data, tests, logs or caches.

## Reporting a vulnerability

Please report privately (do not open a public issue) by contacting the maintainers through the repository's security-advisory feature. Include steps to reproduce. We aim to acknowledge reports within a few days.

## Scope notes

- The agent runs with the permissions of your Windows user (and your WSL user). Review what you ask it to do.
- Session files can contain secrets that appeared in your conversations. Treat the `data/sessions` folder as sensitive.
