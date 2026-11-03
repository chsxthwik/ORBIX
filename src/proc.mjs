// One OMP RPC process (`omp --mode rpc-ui`). Speaks newline-delimited JSON over stdio.
import { EventEmitter } from 'node:events';
import { log, clip } from './util.mjs';
import { killTree } from './backend.mjs';

/** Reassembles protocol-v2 `rpc_chunk` frames into whole JSON frames. */
export class ChunkAssembler {
  constructor(maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.parts = new Map();
  }
  /** Returns the full JSON text when the last chunk arrives, otherwise null. */
  push(f) {
    let st = this.parts.get(f.chunkId);
    if (!st) {
      if (!(f.count > 0) || f.byteLength > this.maxBytes) throw new Error('rpc_chunk: invalid or oversized frame');
      st = { count: f.count, byteLength: f.byteLength, got: 0, bufs: new Array(f.count) };
      this.parts.set(f.chunkId, st);
    }
    if (f.index < 0 || f.index >= st.count) throw new Error('rpc_chunk: bad index');
    if (!st.bufs[f.index]) {
      st.bufs[f.index] = Buffer.from(f.data, 'base64');
      st.got++;
    }
    if (st.got < st.count) return null;
    this.parts.delete(f.chunkId);
    const whole = Buffer.concat(st.bufs);
    if (whole.length !== st.byteLength) throw new Error(`rpc_chunk: length mismatch (${whole.length} != ${st.byteLength})`);
    return whole.toString('utf8');
  }
}

/**
 * Turn OMP's startup stderr (often a Bun stack trace) into one readable error.
 * `restoreModel` is set when a resumed session's model is no longer available.
 */
export function startupError(code, tail) {
  const lines = tail.map((l) => l.trim()).filter(Boolean);
  let reason = '';
  for (let i = lines.length - 1; i >= 0 && !reason; i--) {
    const m = /^(?:[A-Za-z]*Error|error):\s*(.+)$/.exec(lines[i]);
    if (m) reason = m[1];
  }
  const err = new Error(reason ? `OMP could not start: ${reason}` : `OMP exited during startup (code ${code}).${lines.length ? '\n' + lines.slice(-6).join('\n') : ''}`);
  err.restoreModel = /Could not restore model (\S+)/.exec(reason)?.[1] || null;
  return err;
}

export class OmpProc extends EventEmitter {
  constructor({ id, backend, workspace, resume, model, thinking, noSession, extraArgs = [] }) {
    super();
    this.id = id;
    this.backend = backend;
    this.workspace = workspace;
    this.opts = { resume, model, thinking, noSession, extraArgs };
    this.child = null;
    this.ready = false;
    this.exited = false;
    this.protocol = 1;
    this.pending = new Map();
    this.seq = 0;
    this.stderrTail = [];
    this.assembler = new ChunkAssembler();
    this.streaming = false;
    this.startedAt = Date.now();
    this.info = null;
  }

  async start() {
    const bin = await this.backend.resolveOmp();
    if (!bin) {
      throw new Error(
        this.backend.isWsl
          ? `OMP was not found in WSL distro "${this.backend.distro}". Install it there (see omp.sh) or set its path in Settings.`
          : 'OMP was not found on Windows PATH. Install OMP for Windows or switch the backend to WSL in Settings.',
      );
    }
    const argv = [bin, '--mode', 'rpc-ui'];
    const o = this.opts;
    argv.push('--cwd', this.backend.execPath(this.workspace));
    if (o.resume) argv.push('--resume', o.resume);
    else if (o.noSession) argv.push('--no-session');
    if (o.model) argv.push('--model', o.model);
    if (o.thinking) argv.push('--thinking', o.thinking);
    argv.push('--allow-home', ...o.extraArgs);

    this.child = this.backend.spawn(argv, { cwd: this.workspace });
    this.child.stdout.setEncoding('utf8');
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._line(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      for (const l of d.split(/\r?\n/)) {
        if (!l.trim()) continue;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.emit('stderr', l);
      }
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (e) => this._exit(-1, e.message));
    this.child.on('close', (code) => this._exit(code ?? -1));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`OMP did not become ready in 60s.\n${this.stderrTail.slice(-8).join('\n')}`)), 60000);
      this.once('ready', () => {
        clearTimeout(t);
        resolve();
      });
      this.once('exit', (code) => {
        clearTimeout(t);
        reject(startupError(code, this.stderrTail.slice(-40)));
      });
    });

    // Opt in to chunked frames so huge payloads (big tool output, long transcripts) never exceed the 1 MiB line cap.
    try {
      await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }, 10000);
      this.protocol = 2;
    } catch (e) {
      log('protocol v2 unavailable, staying on v1:', e.message);
    }
    return this;
  }

  _line(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      log('non-JSON stdout line:', clip(line, 200));
      return;
    }
    this._frame(ev);
  }

  _frame(ev) {
    if (ev.type === 'rpc_chunk') {
      let whole;
      try {
        whole = this.assembler.push(ev);
      } catch (e) {
        log('chunk error', e.message);
        this.emit('event', { type: 'rpc_frame_error', error: e.message });
        return;
      }
      if (whole == null) return;
      try {
        return this._frame(JSON.parse(whole));
      } catch (e) {
        log('chunk JSON error', e.message);
        return;
      }
    }
    if (ev.type === 'ready') {
      this.ready = true;
      this.info = ev;
      this.emit('ready', ev);
      return;
    }
    if (ev.type === 'response' && ev.id != null && this.pending.has(ev.id)) {
      const p = this.pending.get(ev.id);
      this.pending.delete(ev.id);
      clearTimeout(p.timer);
      if (ev.success === false) {
        const err = new Error(ev.error || 'command failed');
        err.code = ev.code;
        err.response = ev;
        p.reject(err);
      } else p.resolve(ev);
      return;
    }
    if (ev.type === 'agent_start') this.streaming = true;
    else if (ev.type === 'agent_end' && ev.isTerminal !== false) this.streaming = false;
    else if (ev.type === 'prompt_result' && ev.agentInvoked === false) this.streaming = false;
    this.emit('event', ev);
  }

  /** Write one command; resolves with the matching `response` frame. */
  request(cmd, timeoutMs = 600000) {
    if (this.exited) return Promise.reject(new Error('OMP process has exited'));
    const id = cmd.id ?? `h${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Timed out waiting for "${cmd.type}" response`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ ...cmd, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Fire-and-forget write (used for extension_ui_response / host_* replies). */
  send(obj) {
    this._write(obj);
  }

  _write(obj) {
    if (this.exited || !this.child?.stdin.writable) throw new Error('OMP process is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _exit(code, msg) {
    if (this.exited) return;
    this.exited = true;
    this.streaming = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(msg || 'OMP process exited'));
    }
    this.pending.clear();
    this.emit('exit', code, msg);
  }

  /** Graceful stop: close stdin (omp drains and exits 0), then force-kill after a grace period. */
  async stop(graceMs = 4000) {
    if (this.exited) return;
    if (!this.child) return this._exit(-1, 'stopped');
    try {
      this.child.stdin.end();
    } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        killTree(this.child);
        setTimeout(resolve, 300);
      }, graceMs);
      this.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
