// The Guarded permission level runs read-only commands without asking (src/engine/policy.mjs readOnlyCommand).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyCommand } from '../src/engine/policy.mjs';

test('reading commands, alone or piped, are read-only', () => {
  for (const c of ['ls -la', 'git status', 'git diff HEAD~1', 'git log --oneline | head -20', 'grep -rn "a|b;c" src', 'cat package.json | jq .name', 'git branch -a', 'git tag', 'git remote -v', 'git stash list', 'find . -name "*.js"', 'rg foo src', 'Get-ChildItem -Recurse', 'C:\\Windows\\System32\\where.exe node']) assert.equal(readOnlyCommand(c), true, c);
});

test('anything that can change something asks', () => {
  for (const c of ['', 'rm -rf x', 'npm test', 'ls; rm x', 'ls && rm x', 'ls || rm x', 'cat a & rm b', 'cat a > b', 'echo $(whoami)', 'echo `id`', 'git push', 'git commit -m x', 'git branch new', 'git tag v1', 'git stash', 'git -c core.pager=sh log', 'git diff --output=x', 'git grep -O x', 'find . -delete', 'find . -exec rm {} ;', 'sort -o out in', 'rg --pre sh x', 'fd -x rm', 'jq -i . a.json', 'ls\nrm x']) assert.equal(readOnlyCommand(c), false, JSON.stringify(c));
});
