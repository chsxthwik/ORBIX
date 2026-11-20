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

// ---- Unattended runs (started by a schedule) ------------------------------------------------------------------------
//
// Nobody is at the screen to answer, so a question would hang the run. The rule is the reverse of an attended one:
// everything that would ask you is denied instead, and the denial is written to the run's log. What runs without
// asking is fixed when the schedule is created: file edits in the run's worktree, plus commands only if you allowed
// them, plus commands you marked as trusted. The global approval mode (Ask first, Auto edits, Turbo) does not widen it.

/** What the agent is told when an unattended run denies a call. */
export const UNATTENDED_DENIAL =
  'Denied without asking: this is an unattended scheduled run, so nobody can approve this action and it is outside the scope set when the schedule was created. Do not retry it or look for a way around it. Finish what you can within the scope and say in your walkthrough what was denied and why it was needed.';

/**
 * Why an unattended run must deny this call, or '' when it may run without asking.
 *   name           the tool
 *   command        a bash command's text
 *   outside        the call names a path outside the run's worktree
 *   needsApproval  the tool would ask in an attended session (write, edit, bash, a writing MCP tool)
 *   scope          { edits, commands } fixed by the schedule
 *   trusted        the command is one you marked "always allow"
 */
export function unattendedReason({ name, command = '', outside = false, needsApproval = false, scope = {}, trusted = false }) {
  if (outside) return 'it reaches a file outside the run\'s worktree';
  if (name === 'bash') {
    const risk = destructiveReason(command);
    if (risk) return `the command ${risk}`;
  }
  if (!needsApproval) return '';
  if ((name === 'write' || name === 'edit') && scope.edits) return '';
  if (name === 'bash' && (scope.commands || trusted)) return '';
  if (name === 'bash') return 'the schedule does not allow commands';
  if (name === 'write' || name === 'edit') return 'the schedule does not allow file edits';
  return `the schedule does not allow ${name}`;
}
