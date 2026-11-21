// API keys are stored encrypted with Windows DPAPI (CurrentUser scope): only this Windows account can decrypt
// them, and the file is useless if copied to another machine or account. Keys never go to the UI or the logs.
// A self-hosted server on Linux or macOS has no DPAPI: keys are sealed with AES-256-GCM under a random key kept in
// the data folder with owner-only permissions (data/secret.key, mode 0600).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';

const WINDOWS = process.platform === 'win32';
let aesKey = null;
function keyFile() {
  if (aesKey) return aesKey;
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    aesKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    aesKey = crypto.randomBytes(32);
    fs.writeFileSync(file, aesKey.toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  if (aesKey.length !== 32) throw new Error('data/secret.key is damaged');
  return aesKey;
}
const seal = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFile(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `aes:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
};
const open = (stored) => {
  const b = Buffer.from(stored.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFile(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};

const PS = (mode) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
if ('${mode}' -eq 'protect') {
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))
} else {
  [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $null, 'CurrentUser'))
}`;

function run(mode, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS(mode)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.replace(/\r?\n$/, '')) : reject(new Error('Secure storage failed' + (err ? ': ' + err.trim().split('\n')[0] : '')))));
    p.stdin.end(input);
  });
}

export const protect = (plain) => (WINDOWS ? run('protect', plain).then((b64) => 'dpapi:' + b64) : Promise.resolve().then(() => seal(plain)));
export const unprotect = (stored) => {
  if (stored?.startsWith('aes:')) return Promise.resolve().then(() => open(stored));
  if (!stored?.startsWith('dpapi:')) return Promise.reject(new Error('Unsupported secret format'));
  if (!WINDOWS) return Promise.reject(new Error('This key was saved by ORBIX on Windows and cannot be read here. Enter it again.'));
  return run('unprotect', stored.slice(6));
};
