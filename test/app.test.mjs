// Starting ORBIX (src/app.mjs), shared by the command line and the Windows app: one server per data folder, a lock
// file while it runs, and a clean stop. ORBIX_DATA points at a temp folder; nothing outside it is touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-app-'));
process.env.ORBIX_DATA = TMP;
const { startOrbix, ping } = await import('../src/app.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('starts a server, reuses it for a second start, and stops cleanly', async () => {
  const first = await startOrbix({ port: 0 });
  try {
    assert.equal(first.existing, false);
    const { port, searchParams } = new URL(first.url);
    assert.ok(searchParams.get('t'));
    assert.equal(await ping(Number(port)), true);
    const lock = JSON.parse(fs.readFileSync(path.join(TMP, 'instance.json'), 'utf8'));
    assert.equal(lock.port, Number(port));

    // A second start for the same data folder finds the running server instead of starting another.
    const second = await startOrbix({ port: 0 });
    assert.equal(second.existing, true);
    assert.equal(second.url, first.url);
  } finally {
    await first.stop();
  }
  assert.equal(fs.existsSync(path.join(TMP, 'instance.json')), false);
  assert.equal(await ping(Number(new URL(first.url).port)), false);
});
