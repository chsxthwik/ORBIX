// OMP settings via its own CLI (`omp config list|set|reset`), so we never hand-edit YAML.

/** Parser for `omp config list` output. */
export function parseConfigList(text) {
  const groups = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const sec = /^\[(.+)\]\s*$/.exec(raw);
    if (sec) {
      cur = { name: sec[1], items: [] };
      groups.push(cur);
      continue;
    }
    const m = /^\s{2}(\S+) = (.*) \(([^()]*)\)\s*$/.exec(raw);
    if (!m || !cur) continue;
    const [, key, value, typ] = m;
    let type = typ;
    let options = null;
    if (typ.includes('|')) {
      type = 'enum';
      options = typ.split('|');
    }
    cur.items.push({ key, value, type, options });
  }
  return groups.filter((g) => g.items.length);
}

async function omp(backend, args, timeout = 30000) {
  const bin = await backend.resolveOmp();
  if (!bin) throw new Error('OMP binary not found');
  return backend.exec([bin, ...args], { timeout });
}

export async function list(backend) {
  const r = await omp(backend, ['config', 'list']);
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || 'omp config list failed');
  return parseConfigList(r.stdout.toString('utf8'));
}

const KEY_RE = /^[A-Za-z0-9_.\-]+$/;

export async function set(backend, key, value) {
  if (!KEY_RE.test(key)) throw new Error('Invalid key');
  const r = await omp(backend, ['config', 'set', key, String(value)]);
  if (r.code !== 0) throw new Error((r.stderr.toString('utf8') || r.stdout.toString('utf8')).trim() || 'omp config set failed');
  return r.stdout.toString('utf8').trim();
}

export async function reset(backend, key) {
  if (!KEY_RE.test(key)) throw new Error('Invalid key');
  const r = await omp(backend, ['config', 'reset', key]);
  if (r.code !== 0) throw new Error((r.stderr.toString('utf8') || r.stdout.toString('utf8')).trim() || 'omp config reset failed');
  return r.stdout.toString('utf8').trim();
}
