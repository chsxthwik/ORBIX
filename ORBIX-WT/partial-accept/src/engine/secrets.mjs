// API keys are stored encrypted with Windows DPAPI (CurrentUser scope): only this Windows account can decrypt
// them, and the file is useless if copied to another machine or account. Keys never go to the UI or the logs.
import { spawn } from 'node:child_process';

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

export const protect = (plain) => run('protect', plain).then((b64) => 'dpapi:' + b64);
export const unprotect = (stored) => {
  if (!stored?.startsWith('dpapi:')) return Promise.reject(new Error('Unsupported secret format'));
  return run('unprotect', stored.slice(6));
};
