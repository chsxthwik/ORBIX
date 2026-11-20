// The execution policy every agent shares (a run's main agent, its helpers, and anything scheduled later): which
// shell commands are destructive or reach outside the machine, and so ask you every time, whatever was allowed for
// the session or the run. A plan approval can allow commands inside a run's worktree; it never covers these.
//
// The check reads the command text. It is a guard against mistakes, not a sandbox: a command built at run time
// (a script file, an alias) can still do what its text does not show, which is why a run works in its own worktree.

const RULES = [
  // Deleting many files or whole trees.
  [/(^|[\s;&|(])rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]/, 'deletes folders recursively'],
  [/(^|[\s;&|(])rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+(\/|~|\$HOME|\*)/, 'force-deletes files outside the folder'],
  [/(^|[\s;&|(])(rmdir|rd)\s+\/s\b/i, 'deletes a folder tree'],
  [/(^|[\s;&|(])del\s+(\/[a-z]\s+)*\/s\b/i, 'deletes files in every subfolder'],
  [/\bRemove-Item\b[^|;&]*-Recurse\b/i, 'deletes folders recursively'],
  [/(^|[\s;&|(])find\b[^|;&]*\s-delete\b/, 'deletes every file it finds'],
  [/(^|[\s;&|(])(shred|wipefs|mkfs(\.\w+)?|fdisk|diskpart)\b/, 'erases or repartitions a disk'],
  [/(^|[\s;&|(])dd\s+[^|;&]*\bof=/, 'overwrites a device or file with dd'],
  [/(^|[\s;&|(])format(\.com)?\s+[a-z]:/i, 'formats a drive'],
  // Git operations that lose work or publish it.
  [/\bgit\s+(-[cC]\s+\S+\s+)*push\b/, 'pushes to a remote'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*reset\s+[^|;&]*--hard\b/, 'discards uncommitted work (git reset --hard)'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*clean\s+[^|;&]*-[a-zA-Z]*[fdxX]/, 'deletes untracked files (git clean)'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*checkout\s+(--\s+)?\.(\s|$)/, 'discards uncommitted changes (git checkout .)'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*restore\s+[^|;&]*(\s\.|\s:\/)(\s|$)/, 'discards uncommitted changes (git restore)'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*branch\s+[^|;&]*-D\b/, 'force-deletes a branch'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*(rebase|filter-branch|filter-repo)\b/, 'rewrites commit history'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*stash\s+(drop|clear)\b/, 'deletes stashed work'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*worktree\s+(remove|prune)\b/, 'removes a git worktree'],
  [/\bgit\s+(-[cC]\s+\S+\s+)*(remote\s+(add|set-url|remove)|config\s+--global)\b/, 'changes git remotes or global settings'],
  // Running as another user, or changing the machine.
  [/(^|[\s;&|(])(sudo|doas|su|runas)\b/, 'runs with elevated rights'],
  [/(^|[\s;&|(])(shutdown|reboot|halt|poweroff)\b/, 'shuts down or restarts the computer'],
  [/\b(Stop-Computer|Restart-Computer)\b/i, 'shuts down or restarts the computer'],
  [/(^|[\s;&|(])(chmod|chown)\s+[^|;&]*-R\b/, 'changes permissions recursively'],
  [/(^|[\s;&|(])(reg(\.exe)?\s+(add|delete|import)|Set-ItemProperty\s+[^|;&]*HK(LM|CU))/i, 'changes the Windows registry'],
  [/(^|[\s;&|(])(setx|netsh|sc(\.exe)?\s+(create|delete|config)|schtasks\s+\/(create|delete))\b/i, 'changes system settings'],
  [/(^|[\s;&|(])(kill|pkill|killall|taskkill|Stop-Process)\b/i, 'stops other programs'],
  // Code from the network run directly, and publishing.
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|python\d?|node)\b/i, 'runs a script straight from the internet'],
  [/\b(npm|pnpm|yarn|cargo|twine|gem|dotnet\s+nuget)\s+(publish|push|upload)\b/, 'publishes a package'],
  [/\b(gh\s+(repo\s+delete|release\s+(create|delete)|pr\s+merge)|vercel\s+(deploy|remove|--prod)|netlify\s+deploy|firebase\s+deploy|terraform\s+(apply|destroy)|kubectl\s+(delete|apply))\b/, 'changes something outside this computer'],
  [/\b(docker|podman)\s+(system\s+prune|volume\s+rm|rm\s+[^|;&]*-[a-zA-Z]*f)/, 'deletes containers or volumes'],
  [/(^|[\s;&|(])(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, 'deletes database data'],
];

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
// Programs that run their quoted argument as a command: that text is checked as a command too.
const WRAPPER = /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|wsl(?:\.exe)?|eval|xargs|watch|time|nohup|env)\b[^|;&"']*("(?:[^"\\]|\\.)*"|'[^']*')/gi;

/**
 * Why `command` always needs your approval, or '' when it does not. Text inside quotes is data (a commit message, a
 * search pattern, a string to print), so it is not read as a command, except where a shell is asked to run it
 * (`bash -c "…"`, `powershell -Command "…"`).
 */
export function destructiveReason(command, depth = 0) {
  const raw = String(command || '');
  if (!raw.trim()) return '';
  if (depth < 3) {
    for (const m of raw.matchAll(WRAPPER)) {
      const inner = destructiveReason(m[1].slice(1, -1).replace(/\\(["\\])/g, '$1'), depth + 1);
      if (inner) return inner;
    }
  }
  const text = raw.replace(QUOTED, '""');
  for (const [re, why] of RULES) if (re.test(text)) return why;
  return '';
}

export const isDestructive = (command) => !!destructiveReason(command);

// ---- Network access rules (Settings → General → Network access rules) ----
// Sites the agent may read with web_fetch. A rule is a site ("example.com", which also covers its subdomains), only
// the subdomains ("*.example.com"), a site and path ("example.com/docs"), or "*" for every site. Denied sites are
// never fetched. When the allowed list has rules, only those sites are fetched without asking and every other site
// asks first; when it is empty, every site that is not denied is fetched as before. A denied rule wins.

/** A tidy rule list: lower-case sites, no scheme, no spaces, no duplicates, at most 200. */
export function cleanSiteRules(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    let r = String(x ?? '').trim().replace(/^[a-z][\w+.-]*:\/\//i, '');
    if (!r || /\s/.test(r) || r.length > 200) continue;
    const slash = r.indexOf('/');
    const host = (slash < 0 ? r : r.slice(0, slash)).toLowerCase().replace(/\.$/, '');
    const rest = slash < 0 ? '' : r.slice(slash).replace(/\/+$/, '');
    if (host !== '*' && !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host)) continue;
    r = host + rest;
    if (!out.includes(r)) out.push(r);
    if (out.length >= 200) break;
  }
  return out;
}

/** Does one rule match this URL? */
function ruleMatches(rule, u) {
  if (rule === '*') return true;
  const slash = rule.indexOf('/');
  const hostRule = slash < 0 ? rule : rule.slice(0, slash);
  const pathRule = slash < 0 ? '' : rule.slice(slash);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const [hr, port] = hostRule.split(':');
  if (port && String(u.port || (u.protocol === 'https:' ? 443 : 80)) !== port) return false;
  const okHost = hr.startsWith('*.') ? host.endsWith(hr.slice(1)) : host === hr || host.endsWith(`.${hr}`);
  if (!okHost) return false;
  return !pathRule || u.pathname === pathRule || u.pathname.startsWith(pathRule.endsWith('/') ? pathRule : `${pathRule}/`);
}

/** 'deny' (never fetch), 'allow' (fetch without asking), 'ask' (allowed list in use, not on it) or 'any' (no rule). */
export function siteVerdict(url, rules) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(String(url));
  } catch {
    return 'any';
  }
  const deny = rules?.deny || [];
  const allow = rules?.allow || [];
  if (deny.some((r) => ruleMatches(r, u))) return 'deny';
  if (allow.some((r) => ruleMatches(r, u))) return 'allow';
  return allow.length ? 'ask' : 'any';
}
