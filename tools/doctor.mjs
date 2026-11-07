// `npm run doctor`: the same environment checks as Settings → Diagnostics, printed in the console.
// Nothing is started or changed (no agent session).
import { Backend } from '../src/backend.mjs';
import { Store } from '../src/store.mjs';
import { EngineConfig } from '../src/engine/store.mjs';
import { collect } from '../src/diagnostics.mjs';

const store = new Store();
const backend = new Backend(store.data.backend);
const report = await collect({ backend, engineCfg: new EngineConfig(), envInfo: {}, port: '-', procs: new Map() });
for (const c of report.checks) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
  if (c.fix) console.log(`      fix: ${c.fix}`);
}
console.log('');
for (const [k, v] of Object.entries(report.info)) console.log(`${k.padEnd(18)} ${v}`);
process.exit(report.ok ? 0 : 1);
