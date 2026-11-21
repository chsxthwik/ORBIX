// A child process that speaks JSON, one object per line, on stdin and stdout (Claude Code stream-json, Codex
// app-server, ACP agents). It runs through the backend (WSL or Windows), keeps the last lines of stderr for error
// messages, and kills its whole process tree on close.
import { EventEmitter } from 'node:events';
import { killTree } from '../backend.mjs';

const MAX_LINE = 16 * 1024 * 1024;

export class LineProcess extends EventEmitter {
  /** spawn: { cmd, args, opts } from the backend, or a function that starts the child. */
  constructor(child) {
    super();
    this.child = child;
    this.stderrTail = [];
    this.closed = false;
    this.exitCode = null;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) buf = ''; // one runaway line must not eat memory
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this._tail(line); // banners and log lines some CLIs print on stdout
          continue;
        }
        this.emit('message', msg);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this._tail(line);
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      this._tail(String(e.message || e));
      this._exit(-1);
    });
    child.on('close', (code) => this._exit(code ?? -1));
  }

  _tail(line) {
    this.stderrTail.push(line.slice(0, 2000));
    if (this.stderrTail.length > 40) this.stderrTail.shift();
    this.emit('stderr', line);
  }

  _exit(code) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.emit('exit', code);
  }

  send(obj) {
    if (this.closed) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the child: close its input, then kill the tree if it is still there after `ms`. */
  async close(ms = 1500) {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        killTree(this.child);
        resolve();
      }, ms);
      this.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** The last stderr lines, for an error message when the CLI stopped. */
  why() {
    return this.stderrTail.slice(-6).join('\n').trim();
  }
}

/**
 * JSON-RPC 2.0 over a LineProcess (Codex app-server, ACP). `onRequest(method, params)` answers requests the agent
 * sends to us (approvals, file reads); `onNotify(method, params)` gets its notifications.
 */
export class Rpc {
  constructor(lp, { onRequest, onNotify, jsonrpc = true } = {}) {
    this.lp = lp;
    this.seq = 0;
    this.pending = new Map();
    this.jsonrpc = jsonrpc;
    this.onRequest = onRequest || (async () => {
      throw Object.assign(new Error('Not supported'), { code: -32601 });
    });
    this.onNotify = onNotify || (() => {});
    lp.on('message', (m) => this._take(m));
    lp.on('exit', () => {
      const why = lp.why();
      for (const { reject } of this.pending.values()) reject(new Error(why || 'The agent stopped'));
      this.pending.clear();
    });
  }

  _frame(o) {
    return this.jsonrpc ? { jsonrpc: '2.0', ...o } : o;
  }

  call(method, params, { timeout = 120000 } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${Math.round(timeout / 1000)} s`));
      }, timeout) : null;
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      if (!this.lp.send(this._frame({ id, method, params }))) {
        this.pending.delete(id);
        clearTimeout(t);
        reject(new Error(this.lp.why() || 'The agent is not running'));
      }
    });
  }

  notify(method, params) {
    this.lp.send(this._frame({ method, ...(params === undefined ? {} : { params }) }));
  }

  async _take(m) {
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'Request failed'), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    if (m.method && m.id != null) {
      try {
        const result = await this.onRequest(m.method, m.params || {});
        this.lp.send(this._frame({ id: m.id, result: result ?? null }));
      } catch (e) {
        this.lp.send(this._frame({ id: m.id, error: { code: e.code || -32603, message: e.message || 'Failed' } }));
      }
      return;
    }
    if (m.method) this.onNotify(m.method, m.params || {});
  }
}
