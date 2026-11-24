// Remove a test's temporary folder. On Windows a process that has just exited (git, a shell, a server) can keep a
// handle on the folder for a moment, so retry for up to two seconds; if it is still locked after that, leave it for
// the system's temp cleanup rather than fail a run whose tests all passed.
import fs from 'node:fs';

export function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code)) throw e;
  }
}
