// Small OS helper for opening the local web app in the user's default browser.
import { spawn } from 'node:child_process';
import { log } from './util.mjs';

/** Open an http(s) URL in the user's default browser (where they are already signed in). */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Only http(s) links can be opened');
  // rundll32 takes the URL as a plain argv entry, so `&` and quotes need no shell escaping.
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log('open url failed', e.message));
  child.unref();
}

