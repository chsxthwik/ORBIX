// Checking the agent's own work before a run finishes: which command checks a project (tests, type check, lint,
// build), and the review request that reads the run's diff. proc.mjs decides when they run.
import fs from 'node:fs';
import path from 'node:path';

/** How the run-end check behaves: off, ask before running it, or run it like any other command. */
export const VERIFY_MODES = ['off', 'ask', 'always'];

/** What `npm init` writes as the test script: it always fails, so it is no check at all. */
const NPM_PLACEHOLDER = /no test specified/i;

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** The package manager a Node project uses, from its lock file. */
function packageManager(root) {
  if (exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(root, 'bun.lockb')) || exists(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function scriptCommand(pm, name) {
  if (name === 'test') return pm === 'bun' ? 'bun run test' : `${pm} test`;
  return pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`;
}

/**
 * The command that checks a project, found from its files: { command, source } or null.
 * One command only: a chained one (a && b) can never be a trusted command, so it would ask every time.
 * `root`: the project folder as this process can read it; `wsl`: commands run in WSL bash (python3, not python).
 */
export function detectCheck(root, { wsl = false } = {}) {
  if (!root) return null;
  const pkgText = readText(path.join(root, 'package.json'));
  if (pkgText) {
    let scripts = {};
    try {
      scripts = JSON.parse(pkgText).scripts || {};
    } catch {}
    // Tests say the most about whether a change works; a type check, lint or build is the next best thing.
    for (const name of ['test', 'typecheck', 'check', 'lint', 'build']) {
      const s = scripts[name];
      if (typeof s !== 'string' || !s.trim() || (name === 'test' && NPM_PLACEHOLDER.test(s))) continue;
      return { command: scriptCommand(packageManager(root), name), source: `package.json script "${name}"` };
    }
  }
  if (exists(path.join(root, 'Cargo.toml'))) return { command: 'cargo test', source: 'Cargo.toml' };
  if (exists(path.join(root, 'go.mod'))) return { command: 'go test ./...', source: 'go.mod' };
  const py = readText(path.join(root, 'pyproject.toml'));
  const pytestFile = ['pytest.ini', 'conftest.py', 'tox.ini'].find((f) => exists(path.join(root, f)));
  if (pytestFile || (py && /pytest/.test(py)) || (py && exists(path.join(root, 'tests')))) {
    return { command: `${wsl ? 'python3' : 'python'} -m pytest -q`, source: pytestFile || 'pyproject.toml' };
  }
  const make = readText(path.join(root, 'Makefile'));
  if (make) {
    for (const target of ['test', 'check']) if (new RegExp(`^${target}\\s*:`, 'm').test(make)) return { command: `make ${target}`, source: `Makefile target "${target}"` };
  }
  return null;
}

/** Same command text, ignoring spacing ("npm  test" is "npm test"). */
export const sameCommand = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ') === String(b ?? '').trim().replace(/\s+/g, ' ');

/** The last `max` characters of command output, cut at a line start, so the summary and the last error survive. */
export function outputTail(text, max = 6000) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const nl = cut.indexOf('\n');
  return `[… earlier output omitted …]\n${nl >= 0 && nl < 400 ? cut.slice(nl + 1) : cut}`;
}

/** The note the model gets when the check fails, so its next step is a fix. */
export function verifyFailedText({ command, exitCode, timedOut, output }) {
  const how = timedOut ? 'it did not finish in time' : `it failed (exit code ${exitCode})`;
  return `ORBIX ran the project's check after your changes, and ${how}.\nCommand: ${command}\n\n<output>\n${outputTail(output)}\n</output>\n\nFind the cause and fix it, then finish with your reply. If the failure is not caused by your changes (it failed before them too, or it needs something this computer does not have), do not work around it: say so in your reply.`;
}

export const REVIEW_SYSTEM = `You review a code change that a coding agent made, before it reports back to the user. You get the user's request and the diff of every file the agent changed in this run (lines starting with + were added, - removed; the numbers are line numbers).

Report only concrete defects that make the change wrong or incomplete: bugs, crashes, syntax or type errors, callers or imports the change broke, wrong logic, something the request asked for that is missing, leftover debug code, accidental deletions. Do not report style, naming, formatting, missing comments or tests, possible refactors, or anything you are not sure is a real problem from what the diff shows.

If you find nothing, reply exactly: NO_ISSUES
Otherwise reply with one issue per line, at most 5, most serious first, in this form:
- path:line: the problem, in one sentence`;

/** The review request: what the user asked and the run's diff. */
export function reviewPrompt(request, diffs) {
  const body = diffs.map((d) => `<diff path="${d.path}">\n${d.diff}\n</diff>`).join('\n\n');
  return `<request>\n${request}\n</request>\n\n${body}`;
}

/** Issues from the review reply: [] when it found none. Anything that is not a list item is not an issue. */
export function parseReview(text) {
  const t = String(text ?? '').trim();
  if (!t || /^NO_ISSUES\b/.test(t)) return [];
  return t
    .split('\n')
    .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x) => x && !/^NO_ISSUES\b/.test(x))
    .slice(0, 5);
}

/** The note the model gets when the review found problems. */
export function reviewIssuesText(issues) {
  return `A review of your changes in this run found ${issues.length === 1 ? 'a possible defect' : `${issues.length} possible defects`}:\n${issues.map((i) => `- ${i}`).join('\n')}\n\nCheck each one against the code. Fix the real ones; if one is not a real problem, say why in one line. Then finish with your reply to the user.`;
}
