// One conversation's model: which provider and model it uses, the model's facts (context window, thinking levels,
// prices), the thinking level, the fast and plan role models, and the connection a turn streams through. Part of
// AgentProc (see proc.mjs and mixin.mjs): these methods read and write the agent's provider, model, models, meta,
// thinkingLevel, thinkingChosen and roles.
import * as providers from './providers.mjs';
import { loadCatalog, modelInfo } from './catalog.mjs';

/** Model facts (context window, prices) from the catalog; waits at most 3 s for a first download, then goes on without. */
async function catalogReady() {
  await Promise.race([loadCatalog(), new Promise((r) => setTimeout(r, 3000).unref?.())]).catch(() => {});
}

export function modelChoice(provider, model) {
  const { id } = model;
  const info = modelInfo(provider, id);
  const all = providers.thinkingLevels(provider, id);
  const levels = all.filter((x) => x && x !== 'off');
  return { id, provider, name: model.name || id, reasoning: levels.length > 0, input: info?.vision === false ? ['text'] : ['text', 'image'], contextWindow: info?.contextWindow, maxTokens: info?.maxOutput, cost: info?.cost, thinking: levels.length ? { efforts: levels, mode: 'effort', canOff: all.includes('off'), default: providers.defaultThinking(provider, id) } : undefined };
}

export class ModelChoice {
  _modelName(id) {
    return this.models?.find((x) => x.id === id && (!this.provider || x.provider === this.provider))?.name || id;
  }

  /** Context window, thinking levels and prices of the current model (from the catalog when it exists). */
  async _refreshMeta(emit = true) {
    if (this.provider && this.model) await Promise.all([catalogReady(), this._providerFacts(this.provider)]);
    const info = (this.provider && this.model && modelInfo(this.provider, this.model)) || null;
    const all = this.provider && this.model ? providers.thinkingLevels(this.provider, this.model) : [];
    const levels = [...new Set(all.map(String).filter((x) => x && x !== 'off'))];
    // A model that always reasons has no 'off': it starts at its own default level instead.
    const canOff = !this.model || all.includes('off');
    const type = this.config.type(this.provider);
    this.meta = { info, levels, canOff, contextWindow: info?.contextWindow || (type === 'anthropic' ? 200000 : 128000), contextWindowKnown: !!info?.contextWindow };
    const fits = this.thinkingLevel === 'off' ? canOff : levels.includes(this.thinkingLevel);
    if (this.provider && this.model && (!fits || !this.thinkingChosen)) {
      const prev = this.thinkingLevel;
      const def = providers.defaultThinking(this.provider, this.model);
      // Not chosen yet: the model's own default. Chosen, but this model lacks it: the nearest level it has (or its
      // default, for 'off' on a model that always thinks).
      this.thinkingLevel = !this.thinkingChosen || prev === 'off' ? def : levels.length ? providers.nearestEffort(prev, levels) : 'off';
      if (emit && prev !== this.thinkingLevel) this._emit({ type: 'thinking_level_changed', level: this.thinkingLevel });
    }
    return this.meta;
  }

  /** For a provider whose model list reports each model's facts (the ChatGPT plan), make sure they are loaded. */
  async _providerFacts(provider) {
    if (provider && this.config.provider?.(provider)?.listsFacts && this.config.listModels && this.config.configured(provider)) await this.config.listModels(provider).catch(() => {});
  }

  _maxTokens() {
    const mo = this.meta?.info?.maxOutput;
    return mo ? Math.min(mo, 32000) : undefined;
  }

  /** false only when the catalog says the model cannot take images (unknown models are assumed to). */
  _vision() {
    return this.meta?.info?.vision !== false;
  }

  async _setThinking(level) {
    await this._refreshMeta(false);
    const levels = this.meta?.levels || [];
    const canOff = this.meta?.canOff !== false;
    const choices = [...(canOff ? ['off'] : []), ...levels];
    if (!choices.includes(level)) throw new Error(!levels.length ? 'This model has no thinking levels' : !canOff && level === 'off' ? `This model always thinks. Choose one of: ${levels.join(', ')}` : `Thinking level must be one of: ${choices.join(', ')}`);
    this.thinkingLevel = level;
    this.thinkingChosen = true;
    if (this.session) this._persistRaw({ type: 'thinking', level });
    this._emit({ type: 'thinking_level_changed', level });
    return level;
  }

  async _setModel(provider, modelId) {
    if (provider) {
      if (!this.config.configured(provider)) throw new Error(`${this.config.provider(provider)?.name || provider} is not set up. Add it in Settings → Providers.`);
      this.provider = provider;
    }
    this.model = modelId;
    await this._refreshMeta(true);
    if (this.session) this._persistRaw({ type: 'model', provider: this.provider, model: this.model });
    this._emit({ type: 'model_changed', model: { id: this.model, provider: this.provider } });
  }

  async _models() {
    // Reused until a provider is added, removed or changed, and for at most a minute when one of them failed.
    const rev = this.config.rev;
    if (this.models && this.modelsRev === rev && (!this.modelsPartial || Date.now() - this.modelsAt < 60 * 1000)) return this.models;
    const ids = this.config.configuredIds();
    if (!ids.length) throw new Error('No AI provider is set up yet. Open Settings → Providers and add an API key.');
    const facts = catalogReady();
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const list = this.config.listModels ? await this.config.listModels(id) : await providers.clientFor(this.config.type(id)).listModels({ apiKey: await this.config.getKey(id), baseUrl: this.config.baseUrl(id) });
        await facts;
        return list.map((m) => modelChoice(id, m));
      }),
    );
    const good = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    if (!good.length) throw results.find((r) => r.status === 'rejected')?.reason || new Error('Your providers returned no models. Check their model lists in Settings → Providers.');
    // A provider that failed to answer is reported, never silently dropped.
    results.forEach((r, i) => r.status === 'rejected' && this._emit({ type: 'notice', level: 'warn', message: `${this.config.provider(ids[i]).name}: could not load models (${r.reason?.message || r.reason})` }));
    this.models = good;
    this.modelsRev = rev;
    this.modelsAt = Date.now();
    this.modelsPartial = results.some((r) => r.status === 'rejected');
    return good;
  }

  async _resolveModel() {
    // A known provider + model needs no model list: listing every provider first would delay the first token.
    if (this.model && this.provider && this.config.configured(this.provider)) return this._refreshMeta(true);
    const models = await this._models();
    if (this.model) {
      const hit = models.find((m) => m.id === this.model && (!this.provider || m.provider === this.provider)) || models.find((m) => m.id === this.model);
      this.provider = hit?.provider || this.provider || this.config.configuredIds()[0];
    } else {
      const first = (this.provider && models.find((m) => m.provider === this.provider)) || models[0];
      this.provider = first.provider;
      this.model = first.id;
    }
    await this._refreshMeta(true);
  }

  /** Everything needed to call the current model. `stream(args)` fills in key, URL, model and thinking. */
  async _connect() {
    await this._resolveModel();
    const providerInfo = this.config.provider(this.provider);
    if (!providerInfo) throw new Error(`Unknown provider "${this.provider}". Pick a model again.`);
    const key = await this.config.getKey(this.provider);
    if (!key && !providerInfo.keyOptional) throw new Error(`No API key is saved for ${providerInfo.name}. Open Settings → Providers.`);
    const client = providers.clientFor(providerInfo.type);
    const base = { apiKey: key, baseUrl: this.config.baseUrl(this.provider), model: this.model, providerId: this.provider, maxTokens: this._maxTokens() };
    const thinking = this.thinkingLevel !== 'off' ? this.thinkingLevel : undefined;
    const args = (a) => ({ ...base, thinking, ...a });
    const main = { client, args, stream: this._signedIn(client, args, this.provider), provider: this.provider, model: this.model, info: this.meta?.info || null, contextWindow: this.meta?.contextWindow, thinking };
    // Plan mode thinks with the "plan" model when one is chosen (Settings → Models, or /model plan).
    if (this.planMode) return (await this._roleConnSafe('plan')) || main;
    return main;
  }

  /**
   * client.stream for a provider, with sign-in recovery: when a signed-in provider rejects its token before anything
   * streamed, the sign-in is renewed once and the request repeated. A sign-in that cannot be renewed asks for a new one.
   */
  _signedIn(client, args, provider) {
    const config = this.config;
    return async function* (a) {
      let started = false;
      try {
        for await (const ev of client.stream(args(a))) {
          if (ev.type !== 'start' && ev.type !== 'retry') started = true;
          yield ev;
        }
      } catch (e) {
        if (started || !(e?.status === 401 || e?.status === 403) || !config.isSignIn?.(provider)) throw e;
        const fresh = await config.renewSignIn(provider).catch(() => null);
        const name = config.provider(provider)?.name || provider;
        if (!fresh) throw Object.assign(new Error(`${name} no longer accepts this sign-in. Sign in with ${name} again in Settings → Providers.`), { status: e.status });
        yield* client.stream(args({ ...a, apiKey: fresh }));
      }
    };
  }

  /** "provider/model" chosen for a role: this session's override, else the saved default, else '' (current model). */
  _roleSpec(role) {
    return this.roles[role] || this.config.roles?.()?.[role] || '';
  }

  /** A connection for a role's model, or null when no model is chosen for it. Throws a plain error when it cannot be used. */
  async _roleConn(role) {
    const spec = this._roleSpec(role);
    if (!spec) return null;
    const label = role === 'fast' ? 'fast' : 'plan';
    const s = this._parseSpec(spec);
    const provider = s.provider || this.provider;
    const info = this.config.provider(provider);
    if (!info) throw new Error(`The ${label} model "${spec}" has no provider. Choose it again in Settings → Models.`);
    if (!this.config.configured(provider)) throw new Error(`The ${label} model "${spec}" needs ${info.name}, which is not set up. Add it in Settings → Providers, or choose another ${label} model.`);
    const key = await this.config.getKey(provider);
    if (!key && !info.keyOptional) throw new Error(`No API key is saved for ${info.name} (the ${label} model). Open Settings → Providers.`);
    await catalogReady();
    await this._providerFacts(provider);
    const mi = modelInfo(provider, s.model) || null;
    const levels = providers.thinkingLevels(provider, s.model).filter((x) => x && x !== 'off');
    // The session's level when this model has it; a model that always reasons otherwise uses its own default.
    const thinking = this.thinkingLevel !== 'off' && levels.includes(this.thinkingLevel) ? this.thinkingLevel : providers.thinkingLevels(provider, s.model).includes('off') ? undefined : providers.defaultThinking(provider, s.model);
    const client = providers.clientFor(info.type);
    const base = { apiKey: key, baseUrl: this.config.baseUrl(provider), model: s.model, providerId: provider, maxTokens: mi?.maxOutput ? Math.min(mi.maxOutput, 32000) : undefined };
    const args = (a) => ({ ...base, thinking, ...a });
    return { client, args, stream: this._signedIn(client, args, provider), provider, model: s.model, info: mi, contextWindow: mi?.contextWindow || (info.type === 'anthropic' ? 200000 : 128000), thinking, role };
  }

  /** Like _roleConn, but a role that cannot be used is reported once as a note and the caller falls back to the current model. */
  async _roleConnSafe(role) {
    try {
      return await this._roleConn(role);
    } catch (e) {
      const key = `${role}:${e.message}`;
      if (this._roleWarned !== key) {
        this._roleWarned = key;
        this._emit({ type: 'notice', level: 'warn', message: `${e.message} Using the current model instead.` });
      }
      return null;
    }
  }

  /** Set (or clear, with '' / 'default') this session's fast or plan model. Returns the text to show. */
  async _setRole(role, arg) {
    const name = role === 'fast' ? 'Fast' : 'Plan';
    const text = String(arg || '').trim();
    const where = () => {
      const own = this.roles[role];
      const saved = this.config.roles?.()?.[role] || '';
      return own ? `**${own}** (this session)` : saved ? `**${saved}** (default from Settings)` : `not set: the current model is used`;
    };
    if (!text) return `${name} model: ${where()}. Change it with \`/model ${role} provider/model-id\`, or \`/model ${role} default\` to go back to the Settings default.`;
    if (/^(default|reset|clear|none|off)$/i.test(text)) {
      this.roles[role] = '';
    } else {
      const spec = this._parseSpec(text);
      const models = await this._models().catch((e) => {
        throw new Error(`Could not check the model list: ${e.message}`);
      });
      const hit = models.find((x) => x.id === spec.model && (!spec.provider || x.provider === spec.provider)) || (!spec.provider ? models.find((x) => x.id === text) : null);
      if (!hit) throw new Error(`No model "${text}". Use provider/model-id (for example anthropic/claude-haiku-4-5) from the model picker.`);
      this.roles[role] = `${hit.provider}/${hit.id}`;
    }
    this._persistRaw({ type: 'roles', fast: this.roles.fast, plan: this.roles.plan });
    this._roleWarned = null;
    return `${name} model is now ${where()}.`;
  }
}
