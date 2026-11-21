// Your 👍 and 👎 per model, counted on this PC (localStorage, nothing is sent). Settings → Models lists them.
import { lsGet, lsSet } from './dom.js';

const KEY = 'ratings';

/** Move one reply's mark from `prev` to `next` (1, -1 or 0) in the model's count. */
export function rateModel(model, prev, next) {
  if (!model || prev === next) return;
  const all = lsGet(KEY, {});
  const c = all[model] || { up: 0, down: 0 };
  if (prev === 1) c.up = Math.max(0, c.up - 1);
  if (prev === -1) c.down = Math.max(0, c.down - 1);
  if (next === 1) c.up++;
  if (next === -1) c.down++;
  if (c.up || c.down) all[model] = c;
  else delete all[model];
  lsSet(KEY, all);
}

/** Every rated model, most rated first: [{ model, up, down }]. */
export const modelRatings = () =>
  Object.entries(lsGet(KEY, {}))
    .map(([model, c]) => ({ model, up: c?.up | 0, down: c?.down | 0 }))
    .filter((r) => r.up || r.down)
    .sort((a, b) => b.up + b.down - (a.up + a.down) || a.model.localeCompare(b.model));

export const clearRatings = () => lsSet(KEY, {});
