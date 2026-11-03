// Small OS helpers: open web links in the user's default browser, and start the native desktop host.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, log } from './util.mjs';

/** Open an http(s) URL in the user's default browser (where they are already signed in). */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Only http(s) links can be opened');
  // rundll32 takes the URL as a plain argv entry, so `&` and quotes need no shell escaping.
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('open url failed', e.message));
  child.unref();
}

const HOST_EXE = path.join(ROOT, 'bin', 'ORBIX.exe');

/** Start the native Windows desktop app (bin/ORBIX.exe). Returns false when it has not been built yet. */
export function launchDesktop(extraArgs = []) {
  if (!fs.existsSync(HOST_EXE)) return false;
  const child = spawn(HOST_EXE, extraArgs, { detached: true, stdio: 'ignore', cwd: ROOT });
  child.on('error', (e) => log('desktop host failed', e.message));
  child.unref();
  return true;
}
