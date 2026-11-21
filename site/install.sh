#!/usr/bin/env bash
# ORBIX Cloud: install ORBIX as a service on a Linux machine you own (Ubuntu or Debian with systemd).
#
#   curl -fsSL https://orbix-agent.vercel.app/install.sh | bash
#
# What it does, and nothing else:
#   - checks for Node.js 20 or newer, git and tar (installs Node 22 from NodeSource with apt if it is missing)
#   - clones (or updates) ORBIX into ~/.orbix-app from https://github.com/chsxthwik/ORBIX
#   - writes a systemd user service, orbix.service, that runs `node src/headless.mjs` as you
#   - starts it and prints the address and the token to add in the app (Settings → Machines)
# It listens on 127.0.0.1:47821 only. Reach it with Tailscale (`tailscale serve --bg 47821`), an SSH tunnel, or
# HTTPS in front of it. Uninstall: systemctl --user disable --now orbix && rm -rf ~/.orbix-app (data: ~/.orbix).
set -euo pipefail

REPO="${ORBIX_REPO:-https://github.com/chsxthwik/ORBIX.git}"
APP="${ORBIX_APP_DIR:-$HOME/.orbix-app}"
DATA="${ORBIX_DATA:-$HOME/.orbix}"
LISTEN="${ORBIX_LISTEN:-127.0.0.1:47821}"
HOSTS="${ORBIX_HOSTS:-}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'ORBIX install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux. On Windows, install the ORBIX app instead."
command -v systemctl >/dev/null || die "systemd is needed to keep ORBIX running. Run it by hand instead: node $APP/src/headless.mjs"
command -v git >/dev/null || die "git is missing: sudo apt-get install -y git"
command -v tar >/dev/null || die "tar is missing: sudo apt-get install -y tar"

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  say "Installing Node.js 22 (NodeSource, needs sudo)…"
  command -v apt-get >/dev/null || die "Node.js 20+ is missing and this is not an apt system. Install Node.js 20 or newer, then run this again."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node_ok || die "Node.js 20+ is still missing."
fi

if [ -d "$APP/.git" ]; then
  say "Updating ORBIX in $APP…"
  git -C "$APP" pull --ff-only --quiet
else
  say "Getting ORBIX into $APP…"
  git clone --depth 1 --quiet "$REPO" "$APP"
fi

mkdir -p "$DATA" "$HOME/.config/systemd/user"
chmod 700 "$DATA"
cat > "$HOME/.config/systemd/user/orbix.service" <<UNIT
[Unit]
Description=ORBIX server (agents that keep working while your PC sleeps)
After=network-online.target

[Service]
Environment=ORBIX_DATA=$DATA
Environment=ORBIX_LISTEN=$LISTEN
Environment=ORBIX_HOSTS=$HOSTS
WorkingDirectory=$APP
ExecStart=$(command -v node) $APP/src/headless.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

# Keep it running after you log out of the machine.
loginctl enable-linger "$USER" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now orbix.service >/dev/null
systemctl --user restart orbix.service

for _ in $(seq 1 30); do
  [ -s "$DATA/server-token" ] && curl -fsS "http://${LISTEN}/api/ping" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://${LISTEN}/api/ping" >/dev/null 2>&1 || die "ORBIX did not start. See: journalctl --user -u orbix -n 50"

TOKEN="$(cat "$DATA/server-token")"
say "ORBIX is running on this machine."
echo "  Address (here):  http://${LISTEN}"
echo "  Token:           ${TOKEN}"
echo
echo "Next, make it reachable from your PC, for example with Tailscale:"
echo "  sudo tailscale serve --bg ${LISTEN##*:}      → https://$(hostname).<your-tailnet>.ts.net"
echo "  then restart with ORBIX_HOSTS set to that name:"
echo "  ORBIX_HOSTS=$(hostname).<your-tailnet>.ts.net bash install.sh"
echo
echo "In the ORBIX app: Settings → Machines → Add a machine, with that address and the token above."
echo "Agents run here with this machine's logins: sign in to Claude Code, Codex or OpenCode on it if you use them."
