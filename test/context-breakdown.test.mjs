import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, contextWeights, promptWeights } from '../src/engine/context-budget.mjs';
import { buildSystemPrompt, MODE_PROMPTS } from '../src/engine/prompt.mjs';

const env = { workspace: 'C:\\w', shell: 'cmd', os: 'Windows', date: '2026-01-01', git: null };

describe('context breakdown', () => {
  test('skills, MCP and rules are measured out of the system prompt; tools on their own', () => {
    const skills = 'S'.repeat(360);
    const mcp = 'M'.repeat(720);
    const rules = 'R'.repeat(1080);
    const system = `${'X'.repeat(3600)}${rules}${skills}${mcp}`;
    const tools = [{ name: 'read', description: 'D'.repeat(500) }];
    const w = promptWeights(system, rules, tools, { skills, mcp });
    assert.equal(w.system, 1000);
    assert.equal(w.rules, 300);
    assert.equal(w.skills, 100);
    assert.equal(w.mcp, 200);
    assert.equal(w.tools, Math.ceil(JSON.stringify(tools).length / 3.6));
  });

  test('without skills or MCP those parts weigh nothing; no tools weigh nothing', () => {
    const w = promptWeights('hello', '', []);
    assert.deepEqual([w.tools, w.rules, w.skills, w.mcp], [0, 0, 0, 0]);
    assert.ok(w.system > 0);
  });

  test('allocate adds up exactly and leaves out parts with nothing measured', () => {
    const weights = { system: 10, tools: 7, rules: 0, skills: 0, mcp: 3, files: 0, history: 5, results: 1 };
    const rows = allocate(weights, 1001);
    assert.deepEqual(rows.map((r) => r.key), ['system', 'tools', 'mcp', 'history', 'results']);
    assert.equal(rows.reduce((n, r) => n + r.tokens, 0), 1001);
    assert.deepEqual(allocate({}, 50), [{ key: 'history', tokens: 50 }]);
  });

  test('contextWeights carries the prompt parts and splits the conversation', () => {
    const w = contextWeights([{ role: 'user', content: 'hi there' }, { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(100) }] }], { system: 5, tools: 4, rules: 3, skills: 2, mcp: 1 });
    assert.deepEqual([w.system, w.tools, w.rules, w.skills, w.mcp], [5, 4, 3, 2, 1]);
    assert.ok(w.history > 0 && w.results > 0);
  });
});

describe('mode prompts', () => {
  test('each mode adds only its own section; plan mode wins over a chat mode', () => {
    const base = buildSystemPrompt({ env, approvals: 'ask' });
    for (const mode of ['ask', 'debug']) {
      const p = buildSystemPrompt({ env, approvals: 'ask', mode });
      assert.equal(p, `${base}\n\n${MODE_PROMPTS[mode]}`);
    }
    assert.match(buildSystemPrompt({ env, approvals: 'ask', mode: 'ask', planMode: true }), /# PLAN MODE IS ON/);
    assert.doesNotMatch(buildSystemPrompt({ env, approvals: 'ask', mode: 'ask', planMode: true }), /# ASK MODE/);
    assert.equal(buildSystemPrompt({ env, approvals: 'ask', mode: 'agent' }), base);
  });
});
