// One conversation's token usage, cost and context fill. Part of AgentProc (see proc.mjs and mixin.mjs): these
// methods read and write the agent's messages, usage, cost, costKnown, dropped and meta.
import { manualCut } from './compact.mjs';
import { costOf } from './catalog.mjs';
import { contextBudget } from './context-budget.mjs';

export const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export class UsageAccounting {
  _contextUsage() {
    return contextBudget({
      messages: this.messages, context: this._context(), prompt: this.contextPromptWeights,
      provider: this.provider, model: this.model, window: this.meta?.contextWindow || null,
      windowKnown: this.meta?.contextWindowKnown, planMode: this.planMode,
    });
  }

  _compactBlock({ busy = true } = {}) {
    if (this.pendingAsk.size || this.openUi?.size) return 'Answer the pending approval or question first.';
    if ((busy && this.streaming) || this.compacting) return 'Wait for the agent to finish first.';
    if (manualCut(this.messages) < 0) return 'At least seven turns are needed. The latest six stay verbatim.';
    return '';
  }

  _stats() {
    const count = (role) => this.messages.filter((m) => m.role === role).length;
    const toolCalls = this.messages.reduce((n, m) => n + (m.role === 'assistant' ? (m.content || []).filter((c) => c.type === 'toolCall').length : 0), 0);
    const u = this.usage;
    return {
      sessionFile: this.session?.file,
      sessionId: this.sessionId,
      userMessages: count('user'),
      assistantMessages: count('assistant'),
      toolCalls,
      toolResults: count('toolResult'),
      totalMessages: this.messages.length,
      tokens: { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite },
      cost: this.costKnown ? this.cost : undefined,
      contextUsage: this._contextUsage(),
      compactBlock: this._compactBlock(),
    };
  }

  _addUsage(usage, cost) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) this.usage[k] += usage?.[k] || 0;
    if (Number.isFinite(cost)) {
      this.cost += cost;
      this.costKnown = true;
    }
  }

  /** Usage and cost of a list of messages: { input, output, cacheRead, cacheWrite, cost, costKnown }. */
  _usageOf(messages) {
    const sum = { ...zeroUsage(), cost: 0, costKnown: false };
    const add = (u, c) => {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) sum[k] += u?.[k] || 0;
      if (Number.isFinite(c)) {
        sum.cost += c;
        sum.costKnown = true;
      }
    };
    for (const m of messages) {
      if (m.role === 'assistant' && m.usage) add(m.usage, m.usage.cost?.total);
      else if (m.role === 'toolResult' && m.toolName === 'task' && m.details?.usage) add(m.details.usage, m.details.usage.cost);
      else if ((m.role === 'compactionSummary' || m.role === 'custom') && m.usage) add(m.usage, m.cost);
    }
    return sum;
  }

  _recomputeUsage() {
    const s = this._usageOf(this.messages);
    const d = this.dropped;
    this.usage = { input: s.input + d.input, output: s.output + d.output, cacheRead: s.cacheRead + d.cacheRead, cacheWrite: s.cacheWrite + d.cacheWrite };
    this.cost = s.cost + d.cost;
    this.costKnown = s.costKnown || d.cost > 0;
  }

  /** USD for one usage record: the provider's own figure when it sends one (OpenRouter), else catalog prices. */
  _costOf(usage, info = this.meta?.info) {
    if (Number.isFinite(usage?.costUsd)) return usage.costUsd;
    if (!info) return undefined;
    const c = costOf(info, usage);
    return Number.isFinite(c) ? c : undefined;
  }
}
