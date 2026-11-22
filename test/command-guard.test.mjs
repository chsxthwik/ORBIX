// Command Guard: commands that wreck a computer or an account are never run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catastrophicReason } from '../src/engine/policy.mjs';

test('blocks whole-home, drive and root deletes, disk wipes, fork bombs and repo deletion', () => {
  for (const c of [
    'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -rf $HOME', 'rm -fr /*', 'sudo rm -rf --no-preserve-root /', 'rm -rf /home/user',
    'Remove-Item -Recurse -Force C:\\', 'Remove-Item C:\\ -Recurse', 'rd /s /q C:\\', 'rmdir /s %USERPROFILE%',
    'mkfs.ext4 /dev/sda1', 'wipefs -a /dev/nvme0n1', 'dd if=/dev/zero of=/dev/sda bs=1M', 'format D: /q', 'diskpart', 'Clear-Disk -Number 1',
    ':(){ :|:& };:', 'gh repo delete me/app --yes', 'bash -c "rm -rf ~"',
  ]) assert.ok(catastrophicReason(c), `should block: ${c}`);
});

test('leaves ordinary work alone (those still go through the normal approvals)', () => {
  for (const c of [
    'rm -rf node_modules', 'rm -rf ./dist', 'rm -rf /tmp/build-123', 'rm -rf ~/project/dist', 'Remove-Item -Recurse .\\out',
    'rd /s /q build', 'dd if=in.img of=out.img', 'git push', 'gh repo view', 'echo "rm -rf /"', 'npm test',
  ]) assert.equal(catastrophicReason(c), '', `should not block: ${c}`);
});
