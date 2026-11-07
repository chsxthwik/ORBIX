// Where commands run: inside WSL ("wsl") or natively on Windows ("native"). Used by the ORBIX agent's tools, MCP
// servers, search and git. Also owns all Windows <-> Linux path translation so the rest of the app stays agnostic.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { log } from './util.mjs';

const WIN_DRIVE = /^[A-Za-z]:([\\/]|$)/;
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i;

export const isWinPath = (p) => WIN_DRIVE.test(p) || p.startsWith('\\\\');

/** Windows path (or Linux path) -> Linux path as WSL sees it. */
export function toLinuxPath(p) {
  if (!p) return p;
  const unc = WSL_UNC.exec(p);
  if (unc) return unc[2].replace(/\\/g, '/') || '/';
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
  if (m) {
    const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${m[1].toLowerCase()}${rest ? '/' + rest : ''}`;
  }
  return p.replace(/\\/g, '/');
}

/** Linux path -> a path the Windows-side Node process can open with fs. */
export function linuxToHost(p, distro) {
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
}

/** Decode bytes from wsl.exe housekeeping commands (UTF-16LE when it forgets WSL_UTF8). */
function decodeWsl(buf) {
  if (buf.length > 1 && buf.includes(0)) return buf.toString('utf16le').replace(/\u0000/g, '');
  return buf.toString('utf8');
}

// cmd.exe re-parses its command line, so every metacharacter is caret-escaped (the cross-spawn rules).
// Batch files (.cmd/.bat shims) expand %* once more, so their arguments are escaped twice.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const cmdEscape = (s) => String(s).replace(CMD_META, '^$1');
function batchArg(a) {
  const q = `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return cmdEscape(cmdEscape(q));
}

/** Kill a child and everything it started. On Windows child.kill() only ends the direct child (cmd.exe, wsl.exe). */
export function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    const k = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {
      try {
        child.kill();
      } catch {}
    });
    return;
  }
  try {
    child.kill();
  } catch {}
}

export function runProc(cmd, args, { cwd, input, timeout = 30000, env, maxBytes = 8 * 1024 * 1024, windowsVerbatimArguments } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, WSL_UTF8: '1', ...env },
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e.message)), error: e });
    }
    const out = [];
    const err = [];
    let size = 0;
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), error });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(-2, new Error('timeout'));
    }, timeout);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size <= maxBytes) out.push(d);
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// One WSL call finds HOME and proves the distro starts (each wsl.exe start costs ~50-100 ms, more when the VM is cold).
// A login shell may print banners, so the value carries a marker.
const WSL_PROBE = 'printf "ORBIX_HOME=%s\\n" "$HOME"';

/** Parse the WSL probe output into { home } (null when missing or not an absolute Linux path). */
export function parseProbe(text) {
  const v = /^ORBIX_HOME=(.*)$/m.exec(text)?.[1].trim();
  return { home: v && v.startsWith('/') ? v : null };
}

/** Parse `wsl.exe -l -v`: installed distributions (Docker's own are skipped) and the default one (marked *). */
export function parseDistroList(text) {
  const distros = [];
  let def = '';
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\*)?\s*(\S+)\s.*\s(\d+)\s*$/.exec(line); // the STATE column may be translated (and hold spaces)
    if (!m || m[2] === 'NAME') continue;
    if (m[1]) def = m[2];
    if (!/^docker-desktop/i.test(m[2])) distros.push(m[2]);
  }
  return { distros, defaultDistro: distros.includes(def) ? def : '' };
}

export class Backend {
  constructor(cfg) {
    this.update(cfg);
  }

  /** Apply a backend config. The cached HOME lookup is kept unless something changed. */
  update(cfg) {
    const kind = cfg.kind === 'native' ? 'native' : 'wsl';
    const distro = cfg.distro || '';
    if (kind === this.kind && distro === this.distro) return;
    this.kind = kind;
    this.distro = distro;
    this.forget();
  }

  /** Take over another Backend's config and its cached lookups (used by first-run detection). */
  adopt(other) {
    this.update({ kind: other.kind, distro: other.distro });
    this._home = other._home;
    this._probe = other._probe;
    this._probeAt = other._probeAt;
  }

  /** Drop cached lookups so the next call checks again (e.g. after a distro was installed or started). */
  forget() {
    this._home = null;
    this._probe = null;
    this._probing = null;
    this._gen = (this._gen || 0) + 1;
  }

  get isWsl() {
    return this.kind === 'wsl';
  }

  /** Installed WSL distributions and the default one, from a single `wsl.exe -l -v`. */
  static async wslInfo() {
    const r = await runProc('wsl.exe', ['-l', '-v'], { timeout: 15000 });
    if (r.code !== 0) return { distros: [], defaultDistro: '' };
    return parseDistroList(decodeWsl(r.stdout));
  }

  static async listDistros() {
    return (await Backend.wslInfo()).distros;
  }

  static async defaultDistro() {
    return (await Backend.wslInfo()).defaultDistro;
  }

  /**
   * { home } for this backend. A found HOME is cached until the config changes or forget() is called; an unreachable
   * distro is re-checked after 30 s. Concurrent callers share one lookup.
   */
  probe() {
    if (this._probe && (this._probe.home || Date.now() - this._probeAt < 30000)) return Promise.resolve(this._probe);
    if (!this._probing) {
      const gen = (this._gen = (this._gen || 0) + 1);
      this._probing = this._runProbe()
        .then((p) => {
          if (gen === this._gen) {
            this._probe = p;
            this._probeAt = Date.now();
            if (p.home) this._home = p.home;
          }
          return p;
        })
        .finally(() => {
          if (gen === this._gen) this._probing = null;
        });
    }
    return this._probing;
  }

  async _runProbe() {
    if (this.isWsl) {
      const r = await this.exec(['bash', '-lc', WSL_PROBE], { timeout: 30000 });
      return parseProbe(r.stdout.toString('utf8'));
    }
    return { home: os.homedir() };
  }

  /** Path as the backend process sees it. */
  execPath(p) {
    return this.isWsl ? toLinuxPath(p) : p;
  }

  /** Path the Windows-side Node can touch. */
  hostPath(p) {
    if (!p) return p;
    if (!this.isWsl) return p;
    if (isWinPath(p)) {
      const unc = WSL_UNC.exec(p);
      return unc ? linuxToHost(unc[2].replace(/\\/g, '/') || '/', unc[1]) : p;
    }
    return linuxToHost(p, this.distro);
  }

  /** Normalised identity used to match workspaces with session cwds. */
  keyPath(p) {
    const x = this.execPath(p || '');
    return this.isWsl ? x.replace(/\/+$/, '') || '/' : x.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  /** What to show the user (Windows paths for /mnt/<drive>, Linux otherwise). */
  displayPath(p) {
    if (!p) return p;
    if (!this.isWsl) return p;
    const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(p);
    return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : p;
  }

  async home() {
    if (this._home) return this._home;
    if (!this.isWsl) return (this._home = os.homedir());
    const { home } = await this.probe();
    if (!home?.startsWith('/')) throw new Error(`Can’t reach the WSL distribution "${this.distro}". Make sure it’s installed and can start.`);
    return home;
  }

  /** Build a spawn() call for running `argv` (argv[0] is a backend-side command). */
  buildSpawn(argv, { cwd } = {}) {
    if (this.isWsl) {
      const args = [];
      if (this.distro) args.push('-d', this.distro);
      if (cwd) args.push('--cd', this.execPath(cwd));
      args.push('-e', ...argv);
      return { cmd: 'wsl.exe', args, opts: {} };
    }
    const [bin, ...rest] = argv;
    if (/\.(cmd|bat)$/i.test(bin)) {
      const line = [cmdEscape(bin), ...rest.map(batchArg)].join(' ');
      return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], opts: { cwd, windowsVerbatimArguments: true } };
    }
    return { cmd: bin, args: rest, opts: { cwd } };
  }

  /** Run a shell command line (written for bash on WSL, cmd.exe or, with shell 'powershell', PowerShell on Windows) as is. */
  spawnShell(command, { cwd, env, shell } = {}) {
    // The command is not logged: it may carry a token the user typed.
    if (this.isWsl) return this.spawn(['bash', '-lc', command], { cwd, env, quiet: true });
    if (shell === 'powershell') {
      // -EncodedCommand (UTF-16LE base64) passes the script untouched: no quoting layer at all. UTF-8 output, no progress bars.
      // On its own, -EncodedCommand reports only 0 or 1; the epilogue passes on the exit code of the last native program
      // that ran (pytest, npm, git, ...), or 1 when the last command failed. An explicit `exit N` in the script still wins.
      const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $global:LASTEXITCODE = 0\n${command}\n$orbixOk = $?; if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } elseif (-not $orbixOk) { exit 1 }`;
      return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    // cmd.exe fixes its output code page when it starts, so switch the (hidden) console to UTF-8 first and run the
    // command in a second cmd. The command travels in a variable expanded late (!VAR!), so the first cmd never parses it.
    const comspec = process.env.ComSpec || 'cmd.exe';
    return spawn(comspec, ['/d /v:on /s /c "chcp 65001 >nul & cmd.exe /d /s /c !ORBIX_SHELL_CMD!"'], {
      cwd,
      env: { ...process.env, ...env, ORBIX_SHELL_CMD: `"${command}"` },
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Spawn a long-running child with piped stdio. */
  spawn(argv, { cwd, env, quiet = false } = {}) {
    const { cmd, args, opts } = this.buildSpawn(argv, { cwd });
    log('spawn', cmd, quiet ? `(${args.length} arguments)` : args.join(' ').slice(0, 300));
    return spawn(cmd, args, {
      ...opts,
      env: { ...process.env, WSL_UTF8: '1', ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Run to completion. */
  exec(argv, { cwd, input, timeout, maxBytes } = {}) {
    const { cmd, args, opts } = this.buildSpawn(argv, { cwd });
    return runProc(cmd, args, { cwd: opts.cwd, input, timeout, maxBytes, windowsVerbatimArguments: opts.windowsVerbatimArguments });
  }
}
