import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editSkillText, parseFrontmatter } from '../src/engine/skills.mjs';

test('editing a skill preserves unrelated frontmatter and instruction indentation', () => {
  const before = '\uFEFF---\r\nname: Release-Notes\r\ndescription: >-\r\n  Old words\r\nmetadata:\r\n  version: 2\r\nallowed-tools: Read\r\n---\r\n\r\nOld body\r\n';
  const after = editSkillText(before, { name: 'release-notes', description: 'New words', body: '    code block\n\nMore' });
  assert.ok(after.startsWith('\uFEFF---\r\nname: Release-Notes\r\n'));
  assert.ok(after.includes('metadata:\r\n  version: 2\r\nallowed-tools: Read'));
  assert.equal(parseFrontmatter(after).meta.description, 'New words');
  assert.equal(parseFrontmatter(after).body, '\r\n    code block\r\n\r\nMore\r\n');
});
