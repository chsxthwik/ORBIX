// The Terminal: real shells under the conversation, one or more per project. On Linux, in WSL and for a project inside
// a WSL distribution, each runs in a real pseudo-terminal: a small Python helper inside Linux forks your login shell
// (zsh, bash…, with your prompt, colours, history, vim, htop) on a pty and copies bytes both ways. The window size
// travels in-band as a private escape sequence the helper takes out of the input stream. A Windows folder gets
// PowerShell in line mode (no pty on Windows without a native module): the page edits the line and sends it on Enter.
import { uid } from './util.mjs';
import { killTree, wslUncPath, POSIX } from './backend.mjs';

const MAX_BUFFER = 256 * 1024;
const MAX_PER_PROJECT = 8;

// Runs inside Linux. Kept to the standard library; sent base64-encoded so no quoting can break it on the way.
const HELPER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, pwd, re, errno
cols, rows = int(sys.argv[1]), int(sys.argv[2])
try:
    sh = pwd.getpwuid(os.getuid()).pw_shell or '/bin/bash'
except Exception:
    sh = '/bin/bash'
if not os.path.exists(sh):
    sh = '/bin/bash'
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.environ['TERM_PROGRAM'] = 'ORBIX'
    for k in ('PAGER', 'GIT_PAGER', 'MANPAGER', 'SYSTEMD_PAGER'):
        os.environ.pop(k, None)
    os.execvp(sh, ['-' + os.path.basename(sh)])
def size(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(2, r), max(2, c), 0, 0))
    except Exception:
        pass
size(cols, rows)
src, dst = sys.stdin.buffer.fileno(), sys.stdout.buffer.fileno()
def put(f, data):
    while data:
        try:
            n = os.write(f, data)
        except OSError as e:
            if e.errno == errno.EAGAIN:
                select.select([], [f], [])
                continue
            raise
        data = data[n:]
RX = re.compile(rb'\x1b\]5379;(\d+);(\d+)\x07')
held = b''
while True:
    try:
        r, _, _ = select.select([fd, src], [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            d = b''
        if not d:
            break
        put(dst, d)
    if src in r:
        d = os.read(src, 65536)
        if not d:
            break
        held += d
        while True:
            m = RX.search(held)
            if not m:
                break
            if m.start():
                put(fd, held[:m.start()])
            size(int(m.group(1)), int(m.group(2)))
            held = held[m.end():]
        i = held.rfind(b'\x1b]5379')
        if i >= 0 and b'\x07' not in held[i:]:
            if i:
                put(fd, held[:i])
            held = held[i:]
        elif held:
            put(fd, held)
            held = b''
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
try:
    _, st = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os, 'waitstatus_to_exitcode') else 0)
except Exception:
    sys.exit(0)
`;
const HELPER_ARG = `import base64;exec(base64.b64decode('${Buffer.from(HELPER).toString('base64')}'))`;
const clampSize = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.max(lo, Math.min(hi, Math.round(+n))) : d);

export class Ptys {
  /** emit(msg): send { g: 'pty', ... } to every window. */
  constructor({ backend, emit }) {
    this.backend = backend;
    this.emit = emit;
    this.byId = new Map();
  }

  view(t, withBuffer = true) {
    return { id: t.id, ws: t.ws, n: t.n, mode: t.mode, shell: t.shell, alive: !!t.child, ...(withBuffer ? { buffer: t.buffer } : {}) };
  }

  /** The terminals of project `ws`, oldest first. */
  list(ws) {
    return [...this.byId.values()].filter((t) => t.ws === ws).map((t) => this.view(t));
  }

  open(ws, { cols, rows } = {}) {
    if (!ws) throw Object.assign(new Error('Choose a project first'), { status: 400 });
    const mine = [...this.byId.values()].filter((t) => t.ws === ws);
    if (mine.length >= MAX_PER_PROJECT) throw Object.assign(new Error(`At most ${MAX_PER_PROJECT} terminals per project`), { status: 400 });
    const n = Math.max(0, ...mine.map((t) => t.n)) + 1;
    const t = { id: uid('pty'), ws, n, buffer: '', child: null, mode: 'pty', shell: '', cols: clampSize(cols, 20, 500, 100), rows: clampSize(rows, 4, 300, 30), out: '', flush: null };
    this.byId.set(t.id, t);
    this._spawn(t);
    return this.view(t);
  }

  get(id) {
    const t = this.byId.get(String(id || ''));
    if (!t) throw Object.assign(new Error('That terminal was closed'), { status: 410 });
    return t;
  }

  _spawn(t) {
    const b = this.backend;
    const unc = !b.isWsl && !POSIX && wslUncPath(t.ws);
    const argv = ['python3', '-c', HELPER_ARG, String(t.cols), String(t.rows)];
    let child;
    if (b.isWsl || POSIX) {
      child = b.spawn(argv, { cwd: t.ws, quiet: true });
      t.mode = 'pty';
    } else if (unc) {
      child = b.spawn(['wsl.exe', '-d', unc.distro, '--cd', unc.linux, '-e', ...argv], { quiet: true });
      t.mode = 'pty';
    } else {
      child = b.spawn(['powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { cwd: t.ws, env: { TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }, quiet: true });
      t.mode = 'line';
      t.shell = 'PowerShell';
      child.stdin.write("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\n");
      this._prompt(t, child);
    }
    t.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this._out(t, d));
    child.stderr.on('data', (d) => this._out(t, t.mode === 'line' ? d.replace(/\r?\n/g, '\r\n') : d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => this._out(t, `\r\n\x1b[31mThe shell could not start: ${e.message}\x1b[0m\r\n`));
    child.on('close', (code) => {
      if (t.child !== child) return;
      t.child = null;
      if (t.mode === 'pty' && code === 127 && !t.buffer.trim()) this._out(t, '\r\n\x1b[33mPython 3 is needed in Linux for the terminal: sudo apt install python3\x1b[0m\r\n');
      this._out(t, `\r\n\x1b[2m[process exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      this._flush(t);
      this.emit({ g: 'pty', id: t.id, exit: code ?? 0 });
    });
  }

  _prompt(t, child = t.child) {
    child?.stdin.write('Write-Host -NoNewline ("PS " + (Get-Location).Path + "> ")\n');
  }

  _out(t, data) {
    if (!data) return;
    if (t.mode === 'line') data = data.replace(/(?<!\r)\n/g, '\r\n');
    t.buffer = (t.buffer + data).slice(-MAX_BUFFER);
    t.out += data;
    // A burst of output goes out as one message every few milliseconds, not one per chunk.
    t.flush ||= setTimeout(() => this._flush(t), 6);
  }

  _flush(t) {
    clearTimeout(t.flush);
    t.flush = null;
    if (!t.out) return;
    const out = t.out;
    t.out = '';
    this.emit({ g: 'pty', id: t.id, out });
  }

  /** Keystrokes (pty) or a whole line (line mode). */
  input(id, data) {
    const t = this.get(id);
    const s = String(data ?? '');
    if (s.length > 200000) throw Object.assign(new Error('That is too much input at once'), { status: 400 });
    if (!t.child) {
      if (!s) return {};
      this._spawn(t); // a key in an ended terminal starts a new shell there
      return {};
    }
    t.child.stdin.write(t.mode === 'line' ? s.replace(/\r/g, '') + '\n' : s);
    if (t.mode === 'line') this._prompt(t);
    return {};
  }

  resize(id, cols, rows) {
    const t = this.get(id);
    t.cols = clampSize(cols, 20, 500, t.cols);
    t.rows = clampSize(rows, 4, 300, t.rows);
    if (t.mode === 'pty') t.child?.stdin.write(`\x1b]5379;${t.cols};${t.rows}\x07`);
    return {};
  }

  /** Ctrl+C in line mode: there is no pty to deliver it, so the shell restarts in the project folder. */
  interrupt(id) {
    const t = this.get(id);
    const old = t.child;
    t.child = null;
    if (old) killTree(old);
    this._out(t, '^C\r\n');
    this._spawn(t);
    return {};
  }

  close(id) {
    const t = this.byId.get(String(id || ''));
    if (!t) return {};
    const c = t.child;
    t.child = null;
    clearTimeout(t.flush);
    if (c) killTree(c);
    this.byId.delete(t.id);
    return {};
  }

  closeAll() {
    for (const id of [...this.byId.keys()]) this.close(id);
  }
}
