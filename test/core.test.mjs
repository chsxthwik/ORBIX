// Regression tests for the core server modules: backend path mapping, fsapi, gitapi.parseStatus,
// ompcfg.parseConfigList, sessions (parseSessionHead / collapseChains) and proc (ChunkAssembler / startupError).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Nothing here should touch the project's data/ folder; point it at a scratch dir anyway.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-test-core-'));
process.env.ORBIX_DATA = path.join(SCRATCH, 'data');
// Stop git from discovering a repository above the scratch dir (e.g. when %TEMP% sits inside a home-directory repo).
const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = path.dirname(SCRATCH);

const { Backend, isWinPath, toLinuxPath, linuxToHost, runProc } = await import('../src/backend.mjs');
const fsapi = await import('../src/fsapi.mjs');
const { parseStatus } = await import('../src/gitapi.mjs');
const { parseConfigList } = await import('../src/ompcfg.mjs');
const { parseSessionHead, collapseChains } = await import('../src/sessions.mjs');
const { ChunkAssembler, startupError } = await import('../src/proc.mjs');

after(() => {
  if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

let dirSeq = 0;
const fresh = (name = 'd') => {
  const d = path.join(SCRATCH, `${name}-${++dirSeq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ───────────────────────────── backend: path mapping ─────────────────────────────
describe('backend: isWinPath', () => {
  test('recognises drive paths (both slash styles), bare drives and UNC', () => {
    for (const p of ['C:\\Users', 'c:/Users', 'D:', 'Z:\\', '\\\\wsl.localhost\\Ubuntu\\home', '\\\\server\\share']) assert.equal(isWinPath(p), true, p);
  });
  test('rejects Linux and relative paths', () => {
    for (const p of ['/home/u', '/mnt/c/x', 'relative/dir', 'C', 'CC:\\x', 'C:x', '']) assert.equal(isWinPath(p), false, JSON.stringify(p));
  });
});

describe('backend: toLinuxPath (Windows -> WSL)', () => {
  const cases = [
    ['C:\\Users\\alex', '/mnt/c/Users/alex'],
    ['c:/Users/alex', '/mnt/c/Users/alex'],
    ['D:\\', '/mnt/d'],
    ['D:/', '/mnt/d'],
    ['D:', '/mnt/d'],
    ['C:\\Users\\alex\\', '/mnt/c/Users/alex'],
    ['C:\\Program Files\\My App\\bin', '/mnt/c/Program Files/My App/bin'],
    ['C:\\a/b\\c', '/mnt/c/a/b/c'],
    ['C:\\\\Users\\x', '/mnt/c/Users/x'],
    ['C:\\Users\\日本語\\é', '/mnt/c/Users/日本語/é'],
  ];
  for (const [input, expected] of cases) test(`${input} -> ${expected}`, () => assert.equal(toLinuxPath(input), expected));

  test('drive letter is lower-cased', () => assert.equal(toLinuxPath('E:\\X'), '/mnt/e/X'));

  test('\\\\wsl.localhost and \\\\wsl$ UNC paths map to the distro-internal path', () => {
    assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'), '/home/u/proj');
    assert.equal(toLinuxPath('\\\\wsl$\\Ubuntu\\home\\u\\proj'), '/home/u/proj');
    assert.equal(toLinuxPath('\\\\WSL.LOCALHOST\\Ubuntu-22.04\\opt\\my app'), '/opt/my app');
  });
  test('UNC distro root maps to "/"', () => {
    assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu'), '/');
    assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\'), '/');
  });
  test('UNC path that points at /mnt/<drive> inside the distro stays a /mnt path', () => {
    assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users'), '/mnt/c/Users');
  });
  test('Linux paths pass through unchanged', () => {
    for (const p of ['/', '/home/u', '/mnt/c/Users/x y', '/opt/app/']) assert.equal(toLinuxPath(p), p);
  });
  test('empty / nullish input is returned as is', () => {
    assert.equal(toLinuxPath(''), '');
    assert.equal(toLinuxPath(null), null);
    assert.equal(toLinuxPath(undefined), undefined);
  });
});

describe('backend: linuxToHost (WSL -> Windows)', () => {
  test('/mnt/<drive> paths become drive paths', () => {
    assert.equal(linuxToHost('/mnt/c/Users/alex', 'Ubuntu'), 'C:\\Users\\alex');
    assert.equal(linuxToHost('/mnt/d/My Docs/a b.txt', 'Ubuntu'), 'D:\\My Docs\\a b.txt');
  });
  test('drive root with and without trailing slash', () => {
    assert.equal(linuxToHost('/mnt/c', 'Ubuntu'), 'C:\\');
    assert.equal(linuxToHost('/mnt/c/', 'Ubuntu'), 'C:\\');
  });
  test('other Linux paths go through \\\\wsl.localhost\\<distro>', () => {
    assert.equal(linuxToHost('/home/u/proj', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj');
    assert.equal(linuxToHost('/', 'Debian'), '\\\\wsl.localhost\\Debian\\');
    assert.equal(linuxToHost('/opt/my app', 'Ubuntu-22.04'), '\\\\wsl.localhost\\Ubuntu-22.04\\opt\\my app');
  });
  test('/mnt entries that are not a single drive letter are distro paths', () => {
    assert.equal(linuxToHost('/mnt/wsl/x', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x');
    assert.equal(linuxToHost('/mnt/cc', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\mnt\\cc');
    assert.equal(linuxToHost('/mnt/C/x', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\x');
  });
  test('round trip: linuxToHost then toLinuxPath returns the original', () => {
    for (const p of ['/mnt/c/Users/x y', '/mnt/d', '/home/u/proj', '/', '/opt/a b/c']) {
      assert.equal(toLinuxPath(linuxToHost(p, 'Ubuntu')), p, p);
    }
  });
  test('round trip: toLinuxPath then linuxToHost normalises a Windows path', () => {
    assert.equal(linuxToHost(toLinuxPath('c:/Users/alex/'), 'Ubuntu'), 'C:\\Users\\alex');
    assert.equal(linuxToHost(toLinuxPath('\\\\wsl$\\Ubuntu\\home\\u'), 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\u');
  });
});

describe('backend: Backend instance path methods', () => {
  const wsl = new Backend({ kind: 'wsl', distro: 'Ubuntu' });
  const nat = new Backend({ kind: 'native' });

  test('kind defaults to wsl unless exactly "native"', () => {
    assert.equal(new Backend({}).isWsl, true);
    assert.equal(new Backend({ kind: 'bogus' }).isWsl, true);
    assert.equal(new Backend({ kind: 'native' }).isWsl, false);
  });
  test('update() switches kind', () => {
    const b = new Backend({ kind: 'wsl', distro: 'X' });
    b.update({ kind: 'native' });
    assert.equal(b.isWsl, false);
    assert.equal(b.distro, '');
  });

  test('execPath: WSL converts Windows paths, native leaves everything alone', () => {
    assert.equal(wsl.execPath('C:\\Users\\x'), '/mnt/c/Users/x');
    assert.equal(wsl.execPath('/home/u'), '/home/u');
    assert.equal(nat.execPath('C:\\Users\\x'), 'C:\\Users\\x');
  });

  test('hostPath (WSL): Linux paths are mapped to something the Windows side can open', () => {
    assert.equal(wsl.hostPath('/home/u/p'), '\\\\wsl.localhost\\Ubuntu\\home\\u\\p');
    assert.equal(wsl.hostPath('/mnt/c/Users/x'), 'C:\\Users\\x');
  });
  test('hostPath (WSL): Windows drive paths pass through', () => {
    assert.equal(wsl.hostPath('C:\\Users\\x'), 'C:\\Users\\x');
  });
  test('hostPath (WSL): wsl UNC paths are normalised to \\\\wsl.localhost, keeping their own distro', () => {
    assert.equal(wsl.hostPath('\\\\wsl$\\Ubuntu\\home\\u'), '\\\\wsl.localhost\\Ubuntu\\home\\u');
    assert.equal(wsl.hostPath('\\\\wsl.localhost\\Debian\\home\\u'), '\\\\wsl.localhost\\Debian\\home\\u');
    assert.equal(wsl.hostPath('\\\\wsl.localhost\\Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\');
  });
  test('hostPath (WSL): a UNC path into /mnt/<drive> becomes the drive path', () => {
    assert.equal(wsl.hostPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users'), 'C:\\Users');
  });
  test('hostPath (WSL): non-WSL UNC shares are untouched', () => {
    assert.equal(wsl.hostPath('\\\\server\\share\\dir'), '\\\\server\\share\\dir');
  });
  test('hostPath: empty stays empty; native is the identity', () => {
    assert.equal(wsl.hostPath(''), '');
    assert.equal(nat.hostPath('C:\\x\\y'), 'C:\\x\\y');
    assert.equal(nat.hostPath('/tmp/x'), '/tmp/x');
  });

  test('displayPath: /mnt/<drive> -> Windows form under WSL, everything else unchanged', () => {
    assert.equal(wsl.displayPath('/mnt/c/Users/x y'), 'C:\\Users\\x y');
    assert.equal(wsl.displayPath('/mnt/c'), 'C:\\');
    assert.equal(wsl.displayPath('/mnt/c/'), 'C:\\');
    assert.equal(wsl.displayPath('/home/u'), '/home/u');
    assert.equal(wsl.displayPath('/mnt/wsl/x'), '/mnt/wsl/x');
    assert.equal(wsl.displayPath('/mnt/cdrom'), '/mnt/cdrom');
    assert.equal(wsl.displayPath(''), '');
    assert.equal(nat.displayPath('/mnt/c/x'), '/mnt/c/x');
  });
  test('displayPath and execPath are inverse for drive paths', () => {
    for (const p of ['/mnt/c/Users/alex/proj one', '/mnt/e/a']) assert.equal(wsl.execPath(wsl.displayPath(p)), p);
  });

  test('keyPath (WSL): Windows and Linux spellings of one directory share a key; trailing slashes ignored', () => {
    const k = wsl.keyPath('/mnt/c/Proj');
    for (const p of ['C:\\Proj', 'c:/Proj/', '/mnt/c/Proj/', '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Proj']) assert.equal(wsl.keyPath(p), k, p);
    assert.equal(wsl.keyPath('/'), '/');
    assert.equal(wsl.keyPath('/home/u/'), '/home/u');
  });
  test('keyPath (WSL) is case sensitive, like Linux', () => {
    assert.notEqual(wsl.keyPath('/home/u/Proj'), wsl.keyPath('/home/u/proj'));
  });
  test('keyPath (native): case-insensitive and ignores trailing separators', () => {
    assert.equal(nat.keyPath('C:\\Proj\\'), nat.keyPath('c:\\PROJ'));
  });
  test('keyPath (native): backslash and forward-slash spellings of the same folder match', () => {
    assert.equal(nat.keyPath('C:\\Proj\\sub'), nat.keyPath('C:/Proj/sub'));
  });
});

describe('backend: buildSpawn', () => {
  test('WSL: distro, --cd (converted, unquoted) and -e argv in that order', () => {
    const b = new Backend({ kind: 'wsl', distro: 'Ubuntu' });
    const r = b.buildSpawn(['omp', '--mode', 'rpc-ui'], { cwd: 'C:\\My Proj' });
    assert.equal(r.cmd, 'wsl.exe');
    assert.deepEqual(r.args, ['-d', 'Ubuntu', '--cd', '/mnt/c/My Proj', '-e', 'omp', '--mode', 'rpc-ui']);
  });
  test('WSL: no distro / no cwd means no -d / --cd', () => {
    const b = new Backend({ kind: 'wsl' });
    assert.deepEqual(b.buildSpawn(['ls']).args, ['-e', 'ls']);
  });
  test('native: plain executable is spawned directly with the cwd', () => {
    const b = new Backend({ kind: 'native' });
    const r = b.buildSpawn(['C:\\bin\\omp.exe', 'a b', '--x'], { cwd: 'C:\\w' });
    assert.equal(r.cmd, 'C:\\bin\\omp.exe');
    assert.deepEqual(r.args, ['a b', '--x']);
    assert.equal(r.opts.cwd, 'C:\\w');
  });

  // Minimal MSVCRT / CommandLineToArgvW parser, to check what a program would really receive.
  const parseArgv = (line) => {
    const out = [];
    let cur = '';
    let inArg = false;
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') (n++, i++);
        if (line[i] === '"') {
          cur += '\\'.repeat(n >> 1);
          if (n & 1) cur += '"';
          else q = !q;
        } else {
          cur += '\\'.repeat(n);
          i--;
        }
        inArg = true;
      } else if (c === '"') (q = !q, (inArg = true));
      else if (c === ' ' && !q) {
        if (inArg) out.push(cur);
        cur = '';
        inArg = false;
      } else (cur += c, (inArg = true));
    }
    if (inArg) out.push(cur);
    return out;
  };
  const uncaret = (s) => s.replace(/\^(.)/g, '$1');
  const nasty = ['plain', 'with space', 'a&b', 'x|y', '%PATH%', '!var!', 'quote"inside', 'trail\\', 'dir with space\\', '^caret', 'a>b<c', '"; calc & "', '(paren)', 'semi;colon,comma', 'star*q?', 'back\\\\"slash', '`tick`', ''];

  for (const ext of ['cmd', 'BAT']) {
    test(`native .${ext} shim: runs through cmd.exe /d /s /c with verbatim arguments`, () => {
      const b = new Backend({ kind: 'native' });
      const r = b.buildSpawn([`C:\\Program Files\\omp\\omp.${ext}`, 'x'], { cwd: 'C:\\w' });
      assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
      assert.equal(r.args.length, 4);
      assert.equal(r.opts.windowsVerbatimArguments, true);
      assert.equal(r.opts.cwd, 'C:\\w');
      assert.ok(r.args[3].startsWith('"') && r.args[3].endsWith('"'));
    });
  }

  test('native .cmd shim: no cmd.exe metacharacter survives unescaped, whatever the arguments are', () => {
    const b = new Backend({ kind: 'native' });
    const { args } = b.buildSpawn(['C:\\Program Files\\omp\\omp.cmd', ...nasty]);
    const line = args[3].slice(1, -1);
    const bare = line.replace(/\^./g, '');
    assert.ok(!/[()\][%!"<>&|;,*?`^]/.test(bare), `unescaped metacharacter left in: ${bare}`);
  });

  test('native .cmd shim: after cmd.exe and the batch %* expansion peel off their escape layers, the target receives the original arguments', () => {
    const b = new Backend({ kind: 'native' });
    const { args } = b.buildSpawn(['C:\\Program Files\\omp\\omp.cmd', ...nasty]);
    const line = args[3].slice(1, -1);
    // layer 1: cmd.exe parsing of the command line; layer 2: %* expansion inside the .cmd
    const seenByTarget = uncaret(uncaret(line));
    // The first token is the shim path itself (escaped once); strip it, then parse the rest as a C runtime command line.
    const afterBin = seenByTarget.slice(seenByTarget.indexOf('omp.cmd') + 'omp.cmd'.length + 1);
    assert.deepEqual(parseArgv(afterBin), nasty);
  });
});

// ───────────────────────────── backend: runProc ─────────────────────────────
describe('backend: runProc', () => {
  const node = process.execPath;
  test('captures stdout, stderr and the exit code', async () => {
    const r = await runProc(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout.toString(), 'out');
    assert.equal(r.stderr.toString(), 'err');
  });
  test('feeds `input` to stdin', async () => {
    const r = await runProc(node, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'héllo' });
    assert.equal(r.stdout.toString('utf8'), 'héllo');
  });
  test('a command that does not exist resolves with code -1 and an error instead of throwing', async () => {
    const r = await runProc('orbix-no-such-binary-xyz', []);
    assert.equal(r.code, -1);
    assert.ok(r.error);
  });
  test('a hung process is killed after `timeout` and reported as code -2', async () => {
    const t0 = Date.now();
    const r = await runProc(node, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 300 });
    assert.equal(r.code, -2);
    assert.equal(r.error.message, 'timeout');
    assert.ok(Date.now() - t0 < 5000);
  });
  test('stdout beyond maxBytes is dropped, not buffered', async () => {
    const r = await runProc(node, ['-e', 'for (let i = 0; i < 50; i++) process.stdout.write("x".repeat(1000))'], { maxBytes: 5000 });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5000, `got ${r.stdout.length}`);
  });
  test('sets WSL_UTF8=1 for the child so wsl.exe emits UTF-8', async () => {
    const r = await runProc(node, ['-e', 'process.stdout.write(process.env.WSL_UTF8 || "")']);
    assert.equal(r.stdout.toString(), '1');
  });
});

// ───────────────────────────── fsapi ─────────────────────────────
describe('fsapi: joinPath', () => {
  test('Windows parents join with a backslash and never double the separator', () => {
    assert.equal(fsapi.joinPath('C:\\', 'x'), 'C:\\x');
    assert.equal(fsapi.joinPath('C:\\Users\\', 'x'), 'C:\\Users\\x');
    assert.equal(fsapi.joinPath('C:\\Users', 'a b.txt'), 'C:\\Users\\a b.txt');
    assert.equal(fsapi.joinPath('C:\\Users\\\\', 'x'), 'C:\\Users\\x');
    assert.equal(fsapi.joinPath('C:/Users/', 'x'), 'C:/Users\\x');
  });
  test('UNC parents keep the UNC prefix', () => {
    assert.equal(fsapi.joinPath('\\\\wsl.localhost\\Ubuntu\\', 'home'), '\\\\wsl.localhost\\Ubuntu\\home');
    assert.equal(fsapi.joinPath('\\\\wsl.localhost\\Ubuntu\\home', 'u'), '\\\\wsl.localhost\\Ubuntu\\home\\u');
  });
  test('Linux parents join with a forward slash; "/" does not produce "//"', () => {
    assert.equal(fsapi.joinPath('/', 'etc'), '/etc');
    assert.equal(fsapi.joinPath('/home/u', 'x y'), '/home/u/x y');
    assert.equal(fsapi.joinPath('/home/u/', 'x'), '/home/u/x');
    assert.equal(fsapi.joinPath('/home/u//', 'x'), '/home/u/x');
  });
});

describe('fsapi: parentPath', () => {
  test('Windows paths', () => {
    assert.equal(fsapi.parentPath('C:\\Users\\x'), 'C:\\Users');
    assert.equal(fsapi.parentPath('C:\\Users\\x\\'), 'C:\\Users');
    assert.equal(fsapi.parentPath('C:\\Users'), 'C:\\');
    assert.equal(fsapi.parentPath('c:/Users/x'), 'c:/Users');
  });
  test('a drive root has no parent (the UI then shows the drive list)', () => {
    for (const p of ['C:\\', 'C:/', 'D:']) assert.equal(fsapi.parentPath(p), '', p);
  });
  test('UNC paths climb up to the distro root, which has no parent', () => {
    assert.equal(fsapi.parentPath('\\\\wsl.localhost\\Ubuntu\\home\\u'), '\\\\wsl.localhost\\Ubuntu\\home');
    assert.equal(fsapi.parentPath('\\\\wsl.localhost\\Ubuntu\\home'), '\\\\wsl.localhost\\Ubuntu\\');
    assert.equal(fsapi.parentPath('\\\\wsl.localhost\\Ubuntu\\'), '');
    assert.equal(fsapi.parentPath('\\\\server\\share'), '');
  });
  test('Linux paths', () => {
    assert.equal(fsapi.parentPath('/home/u/proj'), '/home/u');
    assert.equal(fsapi.parentPath('/home/u/proj/'), '/home/u');
    assert.equal(fsapi.parentPath('/home'), '/');
    assert.equal(fsapi.parentPath('/'), '');
  });
  test('empty path has no parent', () => assert.equal(fsapi.parentPath(''), ''));
  test('walking up from any path terminates at the root listing', () => {
    for (const start of ['C:\\a\\b\\c', '/a/b/c', '\\\\wsl.localhost\\Ubuntu\\a\\b']) {
      let p = start;
      for (let i = 0; i < 10 && p; i++) p = fsapi.parentPath(p);
      assert.equal(p, '', start);
    }
  });
});

describe('fsapi: normalizeForUi', () => {
  const wsl = new Backend({ kind: 'wsl', distro: 'Ubuntu' });
  const nat = new Backend({ kind: 'native' });
  test('under WSL, /mnt/<drive> paths are shown as Windows paths; other paths are unchanged', () => {
    assert.equal(fsapi.normalizeForUi('/mnt/c/Users/x', wsl), 'C:\\Users\\x');
    assert.equal(fsapi.normalizeForUi('/home/u', wsl), '/home/u');
  });
  test('natively nothing is rewritten', () => {
    assert.equal(fsapi.normalizeForUi('/mnt/c/Users/x', nat), '/mnt/c/Users/x');
    assert.equal(fsapi.normalizeForUi('C:\\x', nat), 'C:\\x');
  });
});

describe('fsapi: listDir', () => {
  const nat = new Backend({ kind: 'native' });
  let root;
  before(() => {
    root = fresh('list');
    for (const f of ['b.txt', 'A.txt', 'file10.txt', 'file2.txt', '.hidden', 'ünï.txt', '$RECYCLE.BIN']) fs.writeFileSync(path.join(root, f), 'x');
    for (const d of ['Zeta', 'alpha', '10dir', '2dir', '.config', 'node_modules', '.git', '$RECYCLE.BIN-not', 'with space']) fs.mkdirSync(path.join(root, d));
    fs.mkdirSync(path.join(root, 'System Volume Information'));
  });

  test('directories first, then files; natural, case-insensitive order inside each group', async () => {
    const r = await fsapi.listDir(nat, root);
    const names = r.entries.map((e) => e.name);
    const dirs = names.filter((_, i) => r.entries[i].dir);
    const files = names.filter((_, i) => !r.entries[i].dir);
    assert.deepEqual(names, [...dirs, ...files]);
    assert.deepEqual(dirs.filter((n) => /^(2dir|10dir|alpha|Zeta)$/.test(n)), ['2dir', '10dir', 'alpha', 'Zeta']);
    assert.deepEqual(files.filter((n) => /^(A|b|file2|file10)\.txt$/.test(n)), ['A.txt', 'b.txt', 'file2.txt', 'file10.txt']);
  });

  test('hidden files and folders (including .git and node_modules) are listed', async () => {
    const names = (await fsapi.listDir(nat, root)).entries.map((e) => e.name);
    for (const n of ['.hidden', '.config', '.git', 'node_modules']) assert.ok(names.includes(n), n);
  });

  test('Windows housekeeping folders are hidden, but a plain file with that name is not', async () => {
    const r = await fsapi.listDir(nat, root);
    assert.ok(!r.entries.some((e) => e.dir && (e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information')));
    assert.ok(r.entries.some((e) => !e.dir && e.name === '$RECYCLE.BIN'));
  });

  test('entries carry full paths built with joinPath; spaces and unicode survive', async () => {
    const r = await fsapi.listDir(nat, root);
    const sp = r.entries.find((e) => e.name === 'with space');
    assert.equal(sp.path, fsapi.joinPath(root, 'with space'));
    assert.ok(fs.statSync(sp.path).isDirectory());
    assert.ok(r.entries.some((e) => e.name === 'ünï.txt'));
  });

  test('result reports its own path and the parent', async () => {
    const r = await fsapi.listDir(nat, root);
    assert.equal(r.path, root);
    assert.equal(r.parent, fsapi.parentPath(root));
    assert.equal(r.parent, path.dirname(root));
  });

  test('dirsOnly returns only directories', async () => {
    const r = await fsapi.listDir(nat, root, { dirsOnly: true });
    assert.ok(r.entries.length > 0);
    assert.ok(r.entries.every((e) => e.dir));
    assert.ok(!r.entries.some((e) => e.name === 'A.txt'));
  });

  test('an empty directory lists no entries', async () => {
    assert.deepEqual((await fsapi.listDir(nat, fresh('empty'))).entries, []);
  });

  test('symlinks are classified by their target; broken links are files', async (t) => {
    const d = fresh('links');
    fs.mkdirSync(path.join(d, 'realdir'));
    fs.writeFileSync(path.join(d, 'realfile'), 'x');
    try {
      fs.symlinkSync(path.join(d, 'realdir'), path.join(d, 'ln-dir'), 'dir');
      fs.symlinkSync(path.join(d, 'realfile'), path.join(d, 'ln-file'), 'file');
      fs.symlinkSync(path.join(d, 'gone'), path.join(d, 'ln-broken'), 'file');
    } catch {
      return t.skip('cannot create symlinks here');
    }
    const by = Object.fromEntries((await fsapi.listDir(nat, d)).entries.map((e) => [e.name, e.dir]));
    assert.equal(by['ln-dir'], true);
    assert.equal(by['ln-file'], false);
    assert.equal(by['ln-broken'], false);
  });

  test('a missing directory rejects with status 404 and the path in the message', async () => {
    const p = path.join(root, 'does-not-exist');
    await assert.rejects(() => fsapi.listDir(nat, p), (e) => e.status === 404 && e.message.includes(p));
  });

  test('a file path rejects with status 404', async () => {
    await assert.rejects(() => fsapi.listDir(nat, path.join(root, 'A.txt')), (e) => e.status === 404);
  });

  test('empty path lists the roots: no parent, home first, drives have kind "drive"', async () => {
    const r = await fsapi.listDir(nat, '');
    assert.equal(r.path, '');
    assert.equal(r.parent, null);
    assert.equal(r.entries[0].kind, 'home');
    assert.equal(r.entries[0].path, os.homedir());
    for (const e of r.entries.filter((x) => x.kind === 'drive')) assert.match(e.path, /^[C-Z]:\\$/);
    assert.ok(r.entries.every((e) => e.dir === true));
  });

  test('WSL backend on Windows: Linux /mnt path in, Windows paths out', { skip: process.platform !== 'win32' }, async (t) => {
    if (!/^[A-Za-z]:[\\/]/.test(root)) return t.skip('temp dir is not on a drive letter');
    const wsl = new Backend({ kind: 'wsl', distro: 'Ubuntu' });
    const r = await fsapi.listDir(wsl, toLinuxPath(root));
    assert.equal(r.path.toLowerCase(), root.toLowerCase());
    const a = r.entries.find((e) => e.name === 'A.txt');
    assert.equal(a.path.toLowerCase(), path.join(root, 'A.txt').toLowerCase());
    assert.equal(r.parent.toLowerCase(), path.dirname(root).toLowerCase());
  });
});

describe('fsapi: readFile', () => {
  const nat = new Backend({ kind: 'native' });
  let root;
  before(() => {
    root = fresh('read');
  });
  const put = (name, data) => {
    const f = path.join(root, name);
    fs.writeFileSync(f, data);
    return f;
  };

  test('text file: content, size, lowercase extension, mtime', async () => {
    const f = put('Note.MD', 'héllo\n日本');
    const r = await fsapi.readFile(nat, f);
    assert.equal(r.content, 'héllo\n日本');
    assert.equal(r.truncated, false);
    assert.equal(r.size, Buffer.byteLength('héllo\n日本'));
    assert.equal(r.ext, 'md');
    assert.equal(r.path, f);
    assert.equal(typeof r.mtime, 'number');
    assert.equal(r.binary, undefined);
  });

  test('a device such as NUL is refused instead of being read', async () => {
    const dev = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
    await assert.rejects(fsapi.readFile(nat, dev), (e) => e.status === 400);
  });
  test('empty file reads as an empty string, not binary', async () => {
    const r = await fsapi.readFile(nat, put('empty.txt', ''));
    assert.equal(r.content, '');
    assert.equal(r.truncated, false);
  });

  test('a NUL byte near the start marks the file binary and returns no content', async () => {
    const r = await fsapi.readFile(nat, put('blob.bin', Buffer.from([0x50, 0x4b, 0, 3, 4, 0xff])));
    assert.equal(r.binary, true);
    assert.equal(r.content, undefined);
  });

  test('files over 2 MiB are truncated to 2 MiB and flagged; exactly 2 MiB is not', async () => {
    const MAX = 2 * 1024 * 1024;
    const big = await fsapi.readFile(nat, put('big.txt', Buffer.alloc(MAX + 10, 'a')));
    assert.equal(big.truncated, true);
    assert.equal(big.content.length, MAX);
    assert.equal(big.size, MAX + 10);
    const exact = await fsapi.readFile(nat, put('exact.txt', Buffer.alloc(MAX, 'a')));
    assert.equal(exact.truncated, false);
    assert.equal(exact.content.length, MAX);
  });

  test('images come back as data URLs with the right MIME type (case-insensitive extension)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const r = await fsapi.readFile(nat, put('pic.PNG', png));
    assert.equal(r.image, true);
    assert.equal(r.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal((await fsapi.readFile(nat, put('a.jpg', 'x'))).dataUrl.split(';')[0], 'data:image/jpeg');
    assert.equal((await fsapi.readFile(nat, put('a.jpeg', 'x'))).dataUrl.split(';')[0], 'data:image/jpeg');
    assert.equal((await fsapi.readFile(nat, put('a.svg', '<svg/>'))).dataUrl.split(';')[0], 'data:image/svg+xml');
    assert.equal((await fsapi.readFile(nat, put('a.ico', 'x'))).dataUrl.split(';')[0], 'data:image/x-icon');
  });

  test('images over 6 MiB are reported as tooLarge without a data URL', async () => {
    const r = await fsapi.readFile(nat, put('huge.png', Buffer.alloc(6 * 1024 * 1024 + 1)));
    assert.equal(r.image, true);
    assert.equal(r.tooLarge, true);
    assert.equal(r.dataUrl, undefined);
  });

  test('a directory is a 400, a missing file a 404', async () => {
    await assert.rejects(() => fsapi.readFile(nat, root), (e) => e.status === 400);
    await assert.rejects(() => fsapi.readFile(nat, path.join(root, 'missing.txt')), (e) => e.status === 404);
  });

  test('WSL backend on Windows reads a /mnt path', { skip: process.platform !== 'win32' }, async (t) => {
    if (!/^[A-Za-z]:[\\/]/.test(root)) return t.skip('temp dir is not on a drive letter');
    const f = put('wsl.txt', 'via wsl');
    const wsl = new Backend({ kind: 'wsl', distro: 'Ubuntu' });
    const r = await fsapi.readFile(wsl, toLinuxPath(f));
    assert.equal(r.content, 'via wsl');
  });
});

describe('fsapi: findFiles (directory walk, no git repository)', () => {
  const nat = new Backend({ kind: 'native' });
  let root;
  const touch = (rel) => {
    const f = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  };
  before(() => {
    root = fresh('find');
    for (const f of [
      'lib/main', 'src/main.mjs', 'src/domain.mjs', 'main-dir/other.txt', 'm_a_i_n.txt', 'zzz.txt', 'README.md', '.env',
      'src/util/helpers.mjs', 'a/b/c/shallow.txt',
      'node_modules/pkg/index.js', '.hidden/secret.txt', '.git/config', '$RECYCLE.BIN/x.txt',
      'd1/d2/d3/d4/d5/d6/d7/d8/deep.txt',
    ]) touch(f);
  });

  test('ranks exact basename, prefix, basename-contains, path-contains, then subsequence matches', async () => {
    const r = await fsapi.findFiles(nat, root, 'main');
    assert.deepEqual(r, ['lib/main', 'src/main.mjs', 'src/domain.mjs', 'main-dir/other.txt', 'm_a_i_n.txt']);
  });

  test('matching is case-insensitive and results use forward slashes', async () => {
    assert.deepEqual(await fsapi.findFiles(nat, root, 'readme.MD'), ['README.md']);
    assert.ok((await fsapi.findFiles(nat, root, 'helpers')).includes('src/util/helpers.mjs'));
  });

  test('a query with no match gives an empty list', async () => {
    assert.deepEqual(await fsapi.findFiles(nat, root, 'qqqqqq'), []);
  });

  test('an empty query lists everything, shortest path first', async () => {
    const r = await fsapi.findFiles(nat, root, '');
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].length <= r[i].length, `${r[i - 1]} before ${r[i]}`);
    assert.ok(r.includes('zzz.txt'));
  });

  test('limit caps the number of results and keeps the best ones', async () => {
    assert.deepEqual(await fsapi.findFiles(nat, root, 'main', 2), ['lib/main', 'src/main.mjs']);
    assert.equal((await fsapi.findFiles(nat, root, '', 3)).length, 3);
  });

  test('the walk skips node_modules, .git, hidden folders and recycle bin, but lists hidden files', async () => {
    const all = await fsapi.findFiles(nat, root, '', 1000);
    assert.ok(all.includes('.env'));
    for (const bad of ['node_modules/pkg/index.js', '.hidden/secret.txt', '.git/config', '$RECYCLE.BIN/x.txt']) assert.ok(!all.includes(bad), bad);
  });

  test('the walk is depth-bounded: very deep files are not returned, moderately nested ones are', async () => {
    const all = await fsapi.findFiles(nat, root, '', 1000);
    assert.ok(all.includes('a/b/c/shallow.txt'));
    assert.ok(!all.includes('d1/d2/d3/d4/d5/d6/d7/d8/deep.txt'));
  });

  test('inside a git repository it honours .gitignore and lists untracked files', { skip: !gitAvailable && 'git not installed' }, async () => {
    const repo = fresh('gitfind');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\nbuild/\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), '');
    fs.mkdirSync(path.join(repo, 'build'));
    fs.writeFileSync(path.join(repo, 'build', 'out.js'), '');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'kept.js'), '');
    fs.writeFileSync(path.join(repo, 'top.js'), '');
    const all = await fsapi.findFiles(nat, repo, '', 100);
    assert.deepEqual([...all].sort(), ['.gitignore', 'src/kept.js', 'top.js']);
  });
});

// ───────────────────────────── gitapi.parseStatus ─────────────────────────────
describe('gitapi: parseStatus', () => {
  const z = (...parts) => parts.join('\0') + '\0';
  const byPath = (r) => Object.fromEntries(r.files.map((f) => [f.path, f]));

  test('empty output', () => {
    assert.deepEqual(parseStatus(''), { branch: '', upstream: '', ahead: 0, behind: 0, files: [] });
  });

  test('clean branch tracking an upstream', () => {
    const r = parseStatus(z('## main...origin/main'));
    assert.deepEqual(r, { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, files: [] });
  });

  test('ahead / behind / both / two-digit counts', () => {
    assert.deepEqual(pick(parseStatus(z('## main...origin/main [ahead 2]'))), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 });
    assert.deepEqual(pick(parseStatus(z('## main...origin/main [behind 12]'))), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 12 });
    assert.deepEqual(pick(parseStatus(z('## dev...fork/dev [ahead 3, behind 1]'))), { branch: 'dev', upstream: 'fork/dev', ahead: 3, behind: 1 });
    function pick(r) {
      return { branch: r.branch, upstream: r.upstream, ahead: r.ahead, behind: r.behind };
    }
  });

  test('upstream that was deleted on the remote ([gone]) keeps the names and zero counts', () => {
    const r = parseStatus(z('## feat...origin/feat [gone]'));
    assert.equal(r.branch, 'feat');
    assert.equal(r.upstream, 'origin/feat');
    assert.equal(r.ahead + r.behind, 0);
  });

  test('branch without upstream; names with slashes', () => {
    const r = parseStatus(z('## feature/login-form'));
    assert.equal(r.branch, 'feature/login-form');
    assert.equal(r.upstream, '');
  });

  test('unborn branch headers ("No commits yet on", "Initial commit on")', () => {
    assert.equal(parseStatus(z('## No commits yet on main')).branch, 'main');
    assert.equal(parseStatus(z('## Initial commit on master')).branch, 'master');
  });

  test('detached HEAD', () => {
    const r = parseStatus(z('## HEAD (no branch)'));
    assert.equal(r.branch, 'HEAD (no branch)');
    assert.equal(r.upstream, '');
    assert.equal(r.ahead, 0);
  });

  test('modified, added, deleted, and both-sides-modified entries: staged / unstaged flags', () => {
    const r = parseStatus(z('## main', ' M a.txt', 'M  b.txt', 'MM c.txt', 'A  d.txt', ' D e.txt', 'D  f.txt'));
    const f = byPath(r);
    const flags = (n) => [f[n].x, f[n].y, f[n].staged, f[n].unstaged, f[n].untracked, f[n].from];
    assert.deepEqual(flags('a.txt'), [' ', 'M', false, true, false, null]);
    assert.deepEqual(flags('b.txt'), ['M', ' ', true, false, false, null]);
    assert.deepEqual(flags('c.txt'), ['M', 'M', true, true, false, null]);
    assert.deepEqual(flags('d.txt'), ['A', ' ', true, false, false, null]);
    assert.deepEqual(flags('e.txt'), [' ', 'D', false, true, false, null]);
    assert.deepEqual(flags('f.txt'), ['D', ' ', true, false, false, null]);
    assert.equal(r.files.length, 6);
  });

  test('untracked files are neither staged nor unstaged', () => {
    const f = parseStatus(z('## main', '?? new.txt')).files[0];
    assert.deepEqual([f.path, f.untracked, f.staged, f.unstaged], ['new.txt', true, false, false]);
  });

  test('a rename consumes the following NUL field as the old path and does not create a bogus entry', () => {
    const r = parseStatus(z('## main', 'R  new name.txt', 'old name.txt', ' M other.txt'));
    assert.equal(r.files.length, 2);
    assert.deepEqual([r.files[0].path, r.files[0].from, r.files[0].staged, r.files[0].unstaged], ['new name.txt', 'old name.txt', true, false]);
    assert.equal(r.files[1].path, 'other.txt');
    assert.equal(r.files[1].from, null);
  });

  test('rename + worktree modification (RM) and copies (C) also carry their source', () => {
    const r = parseStatus(z('## main', 'RM b.txt', 'a.txt', 'C  d.txt', 'c.txt', '?? e.txt'));
    assert.deepEqual(r.files.map((f) => [f.path, f.from]), [['b.txt', 'a.txt'], ['d.txt', 'c.txt'], ['e.txt', null]]);
    assert.deepEqual([r.files[0].staged, r.files[0].unstaged], [true, true]);
  });

  test('an unstaged rename (" R", produced by `git add -N` on the new name) also carries its source path', () => {
    // Captured from git 2.53: `git mv`-less rename + `git add -N "ren é.txt"`.
    const r = parseStatus(z('## main', ' R ren é.txt', 'old name.txt', ' M u.txt', '?? un tracked.txt'));
    assert.deepEqual(r.files.map((f) => f.path), ['ren é.txt', 'u.txt', 'un tracked.txt']);
    assert.equal(r.files[0].from, 'old name.txt');
  });

  test('merge conflicts keep their XY codes, are visible in a list, and are not untracked', () => {
    const r = parseStatus(z('## main', 'UU both.txt', 'AA added both.txt', 'DU del-by-us.txt', 'UD del-by-them.txt', 'AU a.txt', 'UA b.txt', 'DD gone.txt'));
    assert.deepEqual(r.files.map((f) => f.x + f.y), ['UU', 'AA', 'DU', 'UD', 'AU', 'UA', 'DD']);
    assert.deepEqual(r.files.map((f) => f.path), ['both.txt', 'added both.txt', 'del-by-us.txt', 'del-by-them.txt', 'a.txt', 'b.txt', 'gone.txt']);
    for (const f of r.files) {
      assert.equal(f.untracked, false);
      assert.ok(f.staged || f.unstaged, `${f.path} would be invisible in the Changes panel`);
    }
  });

  test('paths with spaces, unicode, quotes and leading dashes are taken verbatim', () => {
    const names = ['dir with space/file name.txt', 'é/日本語/🚀.txt', 'say "hi".txt', "it's.txt", '-dash.txt', 'tab\there.txt', 'a -> b.txt'];
    const r = parseStatus(z('## main', ...names.map((n) => ` M ${n}`)));
    assert.deepEqual(r.files.map((f) => f.path), names);
  });

  test('a file whose name looks like a branch header is still a file', () => {
    const r = parseStatus(z('## main', '?? ## not a header'));
    assert.equal(r.branch, 'main');
    assert.equal(r.files[0].path, '## not a header');
  });

  test('works without a branch header and ignores empty fields', () => {
    const r = parseStatus(' M a.txt\0\0?? b.txt\0');
    assert.deepEqual(r.files.map((f) => f.path), ['a.txt', 'b.txt']);
    assert.equal(r.branch, '');
  });

  test('real `git status` output: rename, delete, modify, untracked (spaces + unicode), ahead of upstream', { skip: !gitAvailable && 'git not installed' }, () => {
    const remote = path.join(fresh('remote'), 'r.git');
    const repo = fresh('repo');
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g(repo, 'init', '-q');
    g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.writeFileSync(path.join(repo, 'old name.txt'), 'some stable content for rename detection\nline 2\nline 3\n');
    fs.writeFileSync(path.join(repo, 'del.txt'), 'bye\n');
    fs.writeFileSync(path.join(repo, 'mod.txt'), 'm\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'one');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    g(repo, 'remote', 'add', 'origin', remote);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
    g(repo, 'add', 'extra.txt');
    g(repo, 'commit', '-qm', 'two');
    g(repo, 'mv', 'old name.txt', 'new é 日本.txt');
    fs.rmSync(path.join(repo, 'del.txt'));
    fs.appendFileSync(path.join(repo, 'mod.txt'), 'more\n');
    fs.mkdirSync(path.join(repo, 'sp ace'));
    fs.writeFileSync(path.join(repo, 'sp ace', 'untr ü.txt'), 'u');

    const out = g(repo, 'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all');
    const r = parseStatus(out);
    assert.equal(r.branch, 'main');
    assert.equal(r.upstream, 'origin/main');
    assert.equal(r.ahead, 1);
    assert.equal(r.behind, 0);
    const f = byPath(r);
    assert.deepEqual([f['new é 日本.txt'].x, f['new é 日本.txt'].from], ['R', 'old name.txt']);
    assert.deepEqual([f['del.txt'].x, f['del.txt'].y], [' ', 'D']);
    assert.deepEqual([f['mod.txt'].x, f['mod.txt'].y], [' ', 'M']);
    assert.equal(f['sp ace/untr ü.txt'].untracked, true);
    assert.equal(r.files.length, 4);
  });
});

// ───────────────────────────── ompcfg.parseConfigList ─────────────────────────────
describe('ompcfg: parseConfigList', () => {
  test('groups, keys, values and plain types', () => {
    const text = ['[Display]', '  theme = dark (string)', '  fontSize = 14 (number)', '  wrap = true (boolean)', '', '[Model Roles]', '  default = claude-opus-4 (string)'].join('\n');
    assert.deepEqual(parseConfigList(text), [
      { name: 'Display', items: [
        { key: 'theme', value: 'dark', type: 'string', options: null },
        { key: 'fontSize', value: '14', type: 'number', options: null },
        { key: 'wrap', value: 'true', type: 'boolean', options: null },
      ] },
      { name: 'Model Roles', items: [{ key: 'default', value: 'claude-opus-4', type: 'string', options: null }] },
    ]);
  });

  test('a "|"-separated type becomes an enum with its options', () => {
    const g = parseConfigList('[Sec]\n  level = high (low|medium|high)');
    assert.deepEqual(g[0].items[0], { key: 'level', value: 'high', type: 'enum', options: ['low', 'medium', 'high'] });
  });

  test('values may contain parentheses, equals signs and spaces: only the last (...) is the type', () => {
    const g = parseConfigList('[S]\n  cmd = run --flag=1 (fast) now (string)\n  path = C:\\Program Files (x86)\\omp (string)');
    assert.equal(g[0].items[0].value, 'run --flag=1 (fast) now');
    assert.equal(g[0].items[0].type, 'string');
    assert.equal(g[0].items[1].value, 'C:\\Program Files (x86)\\omp');
  });

  test('an empty value is kept as an empty string', () => {
    const g = parseConfigList('[S]\n  key =  (string)');
    assert.deepEqual(g[0].items[0], { key: 'key', value: '', type: 'string', options: null });
  });

  test('CRLF line endings are handled', () => {
    const g = parseConfigList('[A]\r\n  k = v (string)\r\n[B]\r\n  n = 1 (number)\r\n');
    assert.deepEqual(g.map((x) => [x.name, x.items[0].key, x.items[0].value]), [['A', 'k', 'v'], ['B', 'n', '1']]);
  });

  test('empty groups and items before the first header are dropped', () => {
    const g = parseConfigList('  orphan = 1 (number)\n[Empty]\n[Real]\n  a = b (string)\n[AlsoEmpty]\n');
    assert.deepEqual(g.map((x) => x.name), ['Real']);
  });

  test('lines that do not match the item shape are skipped without breaking neighbours', () => {
    const g = parseConfigList('[S]\n  good = 1 (number)\n  no type here\nrandom noise\n    deeper = 2 (number)\n  also = 3 (number)');
    assert.deepEqual(g[0].items.map((i) => i.key), ['good', 'also']);
  });

  test('empty input gives no groups', () => assert.deepEqual(parseConfigList(''), []));
});

// ───────────────────────────── sessions ─────────────────────────────
describe('sessions: parseSessionHead', () => {
  const jl = (...objs) => objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n';
  const user = (content) => ({ type: 'message', message: { role: 'user', content } });

  test('reads id, cwd, timestamp, continuation and the first user message', () => {
    const m = parseSessionHead(jl({ type: 'session', id: 's1', cwd: '/mnt/c/proj', timestamp: '2026-01-01T00:00:00Z', continuationOf: 's0' }, user('Fix the bug')));
    assert.deepEqual(m, { id: 's1', cwd: '/mnt/c/proj', title: '', firstUser: 'Fix the bug', timestamp: '2026-01-01T00:00:00Z', continuationOf: 's0' });
  });

  test('empty text gives the all-empty meta', () => {
    assert.deepEqual(parseSessionHead(''), { id: '', cwd: '', title: '', firstUser: '', timestamp: '', continuationOf: '' });
  });

  test('the last line is treated as possibly cut off and ignored', () => {
    const text = JSON.stringify({ type: 'session', id: 'a' }) + '\n' + JSON.stringify(user('hello'));
    const m = parseSessionHead(text); // no trailing newline: the user line may be incomplete
    assert.equal(m.id, 'a');
    assert.equal(m.firstUser, '');
  });

  test('a truncated final record (file head cut mid-line) does not break earlier ones', () => {
    const m = parseSessionHead(jl({ type: 'session', id: 'a', cwd: '/x' }) + '{"type":"message","message":{"role":"us');
    assert.deepEqual([m.id, m.cwd], ['a', '/x']);
  });

  test('invalid JSON lines and blank lines are skipped', () => {
    const m = parseSessionHead('\nnot json\n   \n{"type":"session","id":"z"}\n{oops\n');
    assert.equal(m.id, 'z');
  });

  test('CRLF line endings', () => {
    const m = parseSessionHead('{"type":"session","id":"c","cwd":"C:\\\\p"}\r\n{"type":"message","message":{"role":"user","content":"hi"}}\r\n');
    assert.deepEqual([m.id, m.cwd, m.firstUser], ['c', 'C:\\p', 'hi']);
  });

  test('user content as text blocks: only text parts, joined, whitespace collapsed', () => {
    const m = parseSessionHead(jl({ type: 'session', id: 'a' }, user([{ type: 'image', data: 'xx' }, { type: 'text', text: '  line one\n\n line   two ' }, { type: 'text', text: 'three' }])));
    assert.equal(m.firstUser, 'line one line two three');
  });

  test('only the first user message counts; assistant messages are ignored; a user message without text does not count', () => {
    const m = parseSessionHead(jl(
      { type: 'session', id: 'a' },
      { type: 'message', message: { role: 'assistant', content: 'I am the assistant' } },
      user([{ type: 'image', data: 'x' }]),
      user('real first'),
      user('second'),
    ));
    assert.equal(m.firstUser, 'real first');
  });

  test('title: explicit title record wins over later ones; session header title overrides; title_change always updates', () => {
    assert.equal(parseSessionHead(jl({ type: 'session', id: 'a' }, { type: 'title', title: 'First' }, { type: 'title', title: 'Second' })).title, 'First');
    assert.equal(parseSessionHead(jl({ type: 'session', id: 'a', title: 'FromHeader' })).title, 'FromHeader');
    assert.equal(parseSessionHead(jl({ type: 'session', id: 'a' }, { type: 'title', title: 'Old' }, { type: 'title_change', title: 'Renamed' })).title, 'Renamed');
  });

  test('parsing stops once id, title and first user message are known (later records are not read)', () => {
    const m = parseSessionHead(jl({ type: 'session', id: 'a', title: 'T' }, user('hello'), { type: 'title_change', title: 'Late' }, { type: 'session', id: 'other' }));
    assert.deepEqual([m.id, m.title, m.firstUser], ['a', 'T', 'hello']);
  });

  test('non-string title values are stringified; missing fields default to empty strings', () => {
    const m = parseSessionHead(jl({ type: 'session', id: 'a', title: 42 }));
    assert.equal(m.title, '42');
    assert.equal(m.cwd, '');
    assert.equal(m.continuationOf, '');
  });
});

describe('sessions: collapseChains', () => {
  const e = (id, continuationOf = '', extra = {}) => ({ id, continuationOf, path: `/s/${id}.jsonl`, ...extra });

  test('standalone sessions pass through with a one-element chain, keeping order and fields', () => {
    const r = collapseChains([e('a', '', { title: 'A' }), e('b')]);
    assert.deepEqual(r.map((x) => x.id), ['a', 'b']);
    assert.deepEqual(r[0], { id: 'a', continuationOf: '', path: '/s/a.jsonl', title: 'A', chain: ['/s/a.jsonl'], chainIds: ['a'], resumes: 0 });
  });

  test('a resumed conversation shows only its newest file; the chain lists newest to oldest', () => {
    const r = collapseChains([e('c', 'b'), e('b', 'a'), e('a')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'c');
    assert.deepEqual(r[0].chain, ['/s/c.jsonl', '/s/b.jsonl', '/s/a.jsonl']);
    assert.deepEqual(r[0].chainIds, ['c', 'b', 'a']);
    assert.equal(r[0].resumes, 2);
  });

  test('input order does not matter (oldest first works the same)', () => {
    const r = collapseChains([e('a'), e('b', 'a'), e('c', 'b')]);
    assert.deepEqual(r.map((x) => [x.id, x.chainIds.join('>')]), [['c', 'c>b>a']]);
  });

  test('unrelated conversations stay separate and keep their relative order', () => {
    const r = collapseChains([e('x1', 'x0'), e('y'), e('x0'), e('z', 'z0')]);
    assert.deepEqual(r.map((x) => x.id), ['x1', 'y', 'z']);
  });

  test('continuation of a session that is not in the list (e.g. beyond the limit): shown, chain has only itself', () => {
    const r = collapseChains([e('b', 'missing')]);
    assert.equal(r.length, 1);
    assert.equal(r[0].resumes, 0);
    assert.deepEqual(r[0].chain, ['/s/b.jsonl']);
    assert.equal(r[0].continuationOf, 'missing');
  });

  test('two resumes of the same parent both stay visible, each referencing the parent', () => {
    const r = collapseChains([e('b', 'a'), e('c', 'a'), e('a')]);
    assert.deepEqual(r.map((x) => [x.id, x.chainIds.join('>')]), [['b', 'b>a'], ['c', 'c>a']]);
  });

  test('the input entries are not mutated', () => {
    const input = [e('b', 'a'), e('a')];
    const snapshot = JSON.stringify(input);
    collapseChains(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  test('empty list', () => assert.deepEqual(collapseChains([]), []));

  test('corrupt data with a continuation cycle must not make the conversation disappear', () => {
    assert.ok(collapseChains([e('a', 'b'), e('b', 'a')]).length >= 1);
    assert.ok(collapseChains([e('s', 's')]).length >= 1);
  });
});

// ───────────────────────────── proc: ChunkAssembler / startupError ─────────────────────────────
describe('proc: ChunkAssembler', () => {
  const frames = (text, size, chunkId = 'c1') => {
    const buf = Buffer.from(text, 'utf8');
    const parts = [];
    for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
    if (!parts.length) parts.push(Buffer.alloc(0));
    return parts.map((p, index) => ({ type: 'rpc_chunk', chunkId, index, count: parts.length, byteLength: buf.length, data: p.toString('base64') }));
  };
  const feed = (asm, fs_) => fs_.map((f) => asm.push(f));

  test('a single-chunk message is returned immediately', () => {
    assert.equal(new ChunkAssembler().push(frames('{"a":1}', 1000)[0]), '{"a":1}');
  });

  test('multi-chunk message: null until the last chunk arrives, then the whole text', () => {
    const out = feed(new ChunkAssembler(), frames('0123456789abcdef', 5));
    assert.deepEqual(out, [null, null, null, '0123456789abcdef']);
  });

  test('a multi-byte character split across chunks is decoded intact (no U+FFFD)', () => {
    const text = '{"s":"€🚀日本語é"}';
    for (let size = 1; size <= 7; size++) {
      const out = feed(new ChunkAssembler(), frames(text, size));
      assert.equal(out.at(-1), text, `chunk size ${size}`);
      assert.ok(!out.at(-1).includes('\uFFFD'));
      assert.deepEqual(JSON.parse(out.at(-1)), { s: '€🚀日本語é' });
    }
  });

  test('out-of-order arrival (reverse, rotated) reassembles by index', () => {
    const text = 'the quick brown fox jumps over the lazy dog — ünïcode ✓';
    const fr = frames(text, 7);
    for (const order of [[...fr].reverse(), [...fr.slice(3), ...fr.slice(0, 3)]]) {
      const out = feed(new ChunkAssembler(), order);
      assert.deepEqual(out.slice(0, -1), new Array(fr.length - 1).fill(null));
      assert.equal(out.at(-1), text);
    }
  });

  test('a duplicate chunk is ignored: it neither completes the message early nor corrupts it', () => {
    const asm = new ChunkAssembler();
    const [f0, f1, f2] = frames('AAABBBCCC', 3);
    assert.equal(asm.push(f0), null);
    assert.equal(asm.push(f0), null);
    assert.equal(asm.push({ ...f0, data: Buffer.from('ZZZ').toString('base64') }), null); // same index, different bytes: first one wins
    assert.equal(asm.push(f1), null);
    assert.equal(asm.push(f2), 'AAABBBCCC');
  });

  test('interleaved messages with different chunkIds are assembled independently', () => {
    const asm = new ChunkAssembler();
    const a = frames('first message', 4, 'A');
    const b = frames('second MESSAGE!', 4, 'B');
    const results = {};
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      for (const [id, fr] of [['A', a], ['B', b]]) if (fr[i]) { const r = asm.push(fr[i]); if (r != null) results[id] = r; }
    }
    assert.deepEqual(results, { A: 'first message', B: 'second MESSAGE!' });
  });

  test('a chunkId can be reused after its message completed', () => {
    const asm = new ChunkAssembler();
    assert.equal(feed(asm, frames('one', 2, 'same')).at(-1), 'one');
    assert.equal(feed(asm, frames('two!', 3, 'same')).at(-1), 'two!');
  });

  test('an empty message (zero bytes, one chunk) yields an empty string', () => {
    assert.equal(new ChunkAssembler().push(frames('', 4)[0]), '');
  });

  test('invalid first frames are rejected: missing/zero/negative count, oversized byteLength', () => {
    const asm = new ChunkAssembler(100);
    const base = { chunkId: 'x', index: 0, count: 1, byteLength: 1, data: 'YQ==' };
    for (const bad of [{ count: 0 }, { count: -1 }, { count: undefined }, { count: 'abc' }, { byteLength: 101 }]) {
      assert.throws(() => asm.push({ ...base, ...bad }), /invalid or oversized/, JSON.stringify(bad));
    }
    assert.equal(asm.push({ ...base, byteLength: 1 }), 'a'); // 1 <= 100 passes, and state from rejected frames did not leak in
  });

  test('maxBytes boundary is inclusive', () => {
    const asm = new ChunkAssembler(10);
    assert.equal(asm.push(frames('0123456789', 10)[0]), '0123456789');
    assert.throws(() => asm.push(frames('0123456789A', 11, 'big')[0]), /oversized/);
  });

  test('out-of-range chunk index is rejected', () => {
    const asm = new ChunkAssembler();
    const f = frames('abcdef', 3)[0];
    assert.throws(() => asm.push({ ...f, index: 2 }), /bad index/);
    assert.throws(() => asm.push({ ...f, index: -1 }), /bad index/);
  });

  test('a byteLength that disagrees with the reassembled data is an error, and the id can start over afterwards', () => {
    const asm = new ChunkAssembler();
    const fr = frames('abcdef', 3).map((f) => ({ ...f, byteLength: 99 }));
    asm.push(fr[0]);
    assert.throws(() => asm.push(fr[1]), /length mismatch \(6 != 99\)/);
    assert.equal(feed(asm, frames('abcdef', 3)).at(-1), 'abcdef');
  });

  test('a large payload split into many chunks round-trips', () => {
    const payload = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ i, s: `ünï-${i}-✓` })) });
    const fr = frames(payload, 1021);
    const out = feed(new ChunkAssembler(), [...fr].reverse());
    assert.equal(out.at(-1), payload);
  });
});

describe('proc: startupError', () => {
  test('returns an Error whose message is the last "Error: ..." line of the tail', () => {
    const e = startupError(1, ['bun: something', 'TypeError: first', '    at foo (x.ts:1:1)', 'Error: real cause here', '    at bar (y.ts:2:2)']);
    assert.ok(e instanceof Error);
    assert.equal(e.message, 'OMP could not start: real cause here');
    assert.equal(e.restoreModel, null);
  });

  test('accepts lowercase "error:" and any *Error prefix, with leading indentation', () => {
    assert.equal(startupError(1, ['   error: boom']).message, 'OMP could not start: boom');
    assert.equal(startupError(1, ['RangeError:   too big']).message, 'OMP could not start: too big');
  });

  test('only anchored "<X>Error:" lines count (not mid-line mentions, not other prefixes)', () => {
    const e = startupError(2, ['Uncaught TypeError: nope', 'ENOENT: no such file', 'ERROR: shouting']);
    assert.ok(e.message.startsWith('OMP exited during startup (code 2).'));
    assert.equal(e.restoreModel, null);
  });

  test('a model that can no longer be restored is exposed as restoreModel', () => {
    const e = startupError(1, ['Error: Could not restore model anthropic/claude-old (not available)']);
    assert.equal(e.restoreModel, 'anthropic/claude-old');
    assert.ok(e.message.startsWith('OMP could not start: Could not restore model'));
  });

  test('no recognisable reason: reports the exit code and the last six non-empty lines, trimmed', () => {
    const tail = ['l1', '', 'l2', '  l3  ', 'l4', 'l5', '', 'l6', 'l7', 'l8'];
    assert.equal(startupError(137, tail).message, 'OMP exited during startup (code 137).\nl3\nl4\nl5\nl6\nl7\nl8');
  });

  test('an empty tail gives just the headline, without a dangling newline', () => {
    assert.equal(startupError(1, []).message, 'OMP exited during startup (code 1).');
    assert.equal(startupError(-1, ['', '   ']).message, 'OMP exited during startup (code -1).');
  });

  test('"Error:" with nothing after it is not a reason', () => {
    assert.ok(startupError(1, ['Error:']).message.startsWith('OMP exited during startup'));
  });
});

// ───────────────────────────── gitapi.status without git ─────────────────────────────
describe('gitapi.status: missing git is an empty state, not an error', () => {
  const stub = (code, stderr) => ({ isWsl: true, exec: async () => ({ code, stderr: Buffer.from(stderr), stdout: Buffer.alloc(0) }) });
  test('empty stderr -> gitMissing', async () => {
    const { status } = await import('../src/gitapi.mjs');
    const r = await status(stub(127, ''), '/home/x/project');
    assert.equal(r.repo, false);
    assert.equal(r.gitMissing, true);
  });
  test('a real git failure still throws with git\'s message', async () => {
    const { status } = await import('../src/gitapi.mjs');
    await assert.rejects(() => status(stub(128, 'fatal: unsafe repository'), '/home/x/project'), /unsafe repository/);
  });
});
