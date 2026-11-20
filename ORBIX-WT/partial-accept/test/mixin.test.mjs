// The agent is one class written as several files (proc*.mjs, joined by mixin.mjs): every part must arrive, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixin } from '../src/engine/mixin.mjs';
import { AgentProc } from '../src/engine/proc.mjs';
import { ModelChoice } from '../src/engine/proc-models.mjs';
import { ToolRuns } from '../src/engine/proc-tools.mjs';
import { RunChecks } from '../src/engine/proc-checks.mjs';
import { UsageAccounting } from '../src/engine/proc-usage.mjs';

test('every method of every part is on the agent', () => {
  for (const part of [ModelChoice, ToolRuns, RunChecks, UsageAccounting]) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) if (name !== 'constructor') assert.equal(AgentProc.prototype[name], part.prototype[name], `${part.name}.${name}`);
  }
});

test('a method defined twice is an error, not a silent override', () => {
  class A { x() {} }
  class B { x() {} }
  assert.throws(() => mixin(A, B), /A\.x is defined twice \(in B too\)/);
});
