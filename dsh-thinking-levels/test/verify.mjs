/**
 * Verification for dsh-thinking-levels.
 *
 * The plugin's job has two halves, and this file proves both without needing a
 * running harness:
 *
 *  1. **Describe** — after `apply()`, a hand-declared route reports the six
 *     reasoning efforts through the public `llm` surface, so the model picker
 *     grows its 推理等级 row.
 *  2. **Dispatch** — the selected level survives pi-ai's clamp and lands in the
 *     request body as `reasoning_effort`.
 *
 * The harness-side halves of that chain (`getSupportedThinkingLevels`,
 * `reasoningInfo`, `resolveReasoningLevel`, `profileOptions`) are replicated here
 * from `@deepseek-ai/dsh-llm-pi-ai` because that package exports only `apply`.
 * The pi-ai half is **not** replicated: when the installed pi-ai is reachable,
 * the real `clampThinkingLevel` and the real `streamSimple` are driven, and the
 * captured HTTP body is asserted directly.
 *
 * Run with the harness runtime's Node: `node test/verify.mjs`.
 */
import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../host.js';

/** Levels pi-ai can express, in escalation order (pi-ai `models.js`). */
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The levels this plugin offers by default. */
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Where an extracted pi-ai checkout may live, for the wire assertions. */
const PI_AI_CANDIDATES = [
  process.env.PI_AI_PATH,
  join(process.cwd(), '.asar-work', 'all', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'),
  join(process.cwd(), '..', '.asar-work', 'all', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'),
  join(process.cwd(), '.plugin-work', 'extract', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'),
].filter(Boolean);

// ---------------------------------------------------------------------------
// Replicas of the harness-side reasoning helpers (dsh-llm-pi-ai/lib/index.js).
// ---------------------------------------------------------------------------

/** dsh-llm-pi-ai:753 — the levels the harness will offer for one descriptor. */
function getSupportedThinkingLevels(model) {
  if (!model.reasoning) return ['off'];
  return ALL_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** dsh-llm-pi-ai:1726 — the `reasoning` block of `llm.resolveModelInfo`. */
function reasoningInfo(model, defaultLevel) {
  if (!model.reasoning) return {};
  return {
    reasoning: {
      efforts: getSupportedThinkingLevels(model).map((level) => ({
        id: level,
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...(defaultLevel === undefined ? {} : { defaultEffort: defaultLevel }),
    },
  };
}

/** dsh-llm-pi-ai:1705 — request-path validation of an explicit level. */
function resolveReasoningLevel(model, effort) {
  if (effort === undefined) return undefined;
  if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;
  throw new Error(`UNSUPPORTED_REASONING_EFFORT: ${effort}`);
}

/** dsh-llm-pi-ai:1674 — the reasoning knob as pi-ai receives it. */
function profileOptions(reasoning) {
  return reasoning === 'off' ? {} : { reasoning };
}

// ---------------------------------------------------------------------------
// A minimal stand-in for the harness Host context and the `llm` service.
// ---------------------------------------------------------------------------

/** A cordis-shaped context that records what the plugin registered. */
function createContext() {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    emitted,
    listeners,
    disposers: [],
    services: {},
    logger: { info() {}, warn() {}, error() {} },
    emit(name, ...args) {
      emitted.push(name);
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    inject(deps, callback) {
      // The real scope carries the same surface; the fake needs no isolation.
      callback(ctx);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') ctx.disposers.push(dispose);
      return () => {};
    },
    get(name, strict = true) {
      const value = ctx.services[name];
      if (value === undefined && strict) throw new Error(`cannot get property "${name}" without inject`);
      return value;
    },
  };
  return ctx;
}

/**
 * A pi-ai adapter stand-in with the two methods the plugin requires.
 *
 * `descriptorFor` mirrors what `@deepseek-ai/dsh-llm-pi-ai`'s `modelOf` returns:
 * a hand-declared model materializes with no reasoning metadata, a catalog model
 * with pi-ai's own.
 *
 * @param models - the ids this adapter serves.
 * @param descriptorFor - builds one descriptor.
 * @param memoize - return the same object per id, like a snapshot that caches.
 */
function createAdapter(models, descriptorFor, memoize = false) {
  const cache = new Map();
  const snapshot = { models: { getModels: (provider) => models.map((id) => ({ id, provider })) } };
  return {
    calls: 0,
    current: () => snapshot,
    modelOf(_snapshot, provider, id) {
      this.calls += 1;
      if (!models.includes(id)) throw new Error(`unknown model "${id}" on "${provider}"`);
      if (memoize) {
        if (!cache.has(id)) cache.set(id, descriptorFor(provider, id));
        return cache.get(id);
      }
      return descriptorFor(provider, id);
    },
  };
}

/** A `llm` service stand-in exposing only what the plugin and this test read. */
function createLlm(routes) {
  const llm = {
    adapters: new Map(),
    listProviders() {
      return routes.map((route) => ({ id: route.id, name: route.name }));
    },
    listConfigurableProviders() {
      return routes.map((route) => ({ provider: route.id, name: route.name, declared: route.declared }));
    },
    async listModels(provider) {
      return routes.find((route) => route.id === provider).models.map((id) => ({ id, name: id }));
    },
    async resolveModelInfo(provider, modelId) {
      const { adapter } = llm.adapters.get(provider);
      const model = adapter.modelOf(adapter.current(), provider, modelId);
      return { provider, id: modelId, name: model.name ?? modelId, ...reasoningInfo(model) };
    },
  };
  for (const route of routes) llm.adapters.set(route.id, { adapter: route.adapter, provider: { id: route.id, name: route.name } });
  return llm;
}

/** Mount the plugin the way the loader does. */
function mount(config, llm, extras = {}) {
  const ctx = createContext();
  // The real scope exposes injected services as properties, so the fake must too.
  ctx.llm = llm;
  ctx.services.llm = llm;
  ctx.webServer = { register: () => () => {} };
  ctx.services.webServer = ctx.webServer;
  for (const [name, service] of Object.entries(extras)) {
    ctx[name] = service;
    ctx.services[name] = service;
  }
  apply(ctx, config);
  return ctx;
}

/** Collect the level ids a route now advertises. */
async function effortsOf(llm, provider, model) {
  const resolved = await llm.resolveModelInfo(provider, model);
  return resolved.reasoning?.efforts?.map((effort) => effort.id) ?? null;
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((error) => results.push({ name, ok: false, error }));
}

/** A hand-declared route: what the user's `ymengguomo`/`ikik`/`ymenggpt` are. */
function thirdPartyRoute() {
  return {
    id: 'ymengguomo',
    name: 'YMG',
    declared: true,
    models: ['deepseek-v4.1-flash', 'mimo-v2.6-pro'],
    adapter: createAdapter(
      ['deepseek-v4.1-flash', 'mimo-v2.6-pro'],
      (provider, id) => ({
        provider,
        id,
        name: id,
        api: 'openai-completions',
        baseUrl: 'https://gateway.example.invalid/v1',
        reasoning: false,
        input: ['text'],
      }),
      true,
    ),
  };
}

await check('a third-party route gains exactly the six default levels', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({}, llm);
  assert.deepEqual(await effortsOf(llm, 'ymengguomo', 'deepseek-v4.1-flash'), DEFAULT_LEVELS);
  assert.deepEqual(await effortsOf(llm, 'ymengguomo', 'mimo-v2.6-pro'), DEFAULT_LEVELS);
});

await check('the picker sees the capability through resolveModelInfo', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({}, llm);
  const resolved = await llm.resolveModelInfo('ymengguomo', 'deepseek-v4.1-flash');
  assert.deepEqual(resolved.reasoning.efforts, [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'Xhigh' },
    { id: 'max', name: 'Max' },
  ]);
  assert.equal(resolved.reasoning.defaultEffort, undefined);
});

await check('switching models carries the current effort when the target supports it', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  const events = [{
    type: 'model/selection',
    data: { provider: 'ymengguomo', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  }];
  const session = {
    seq: events.length,
    snapshotEvents: () => events,
  };
  const agent = { session };
  let received;
  const controller = {
    async resolveAgent() { return { agent }; },
    async selectModel(request) { received = request; return { selected: request }; },
  };
  mount({}, llm, { sessionController: controller });
  await controller.selectModel({ sessionId: 'session-1', provider: 'ymengguomo', model: 'mimo-v2.6-pro' });
  assert.equal(received.reasoningEffort, 'high');
});

await check('a retry request rereads the latest model and effort selection', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  const events = [{
    type: 'model/selection',
    data: { provider: 'ymengguomo', model: 'mimo-v2.6-pro', reasoningEffort: 'max' },
  }];
  const session = { seq: events.length, snapshotEvents: () => events };
  const agent = { session };
  const ctx = mount({}, llm);
  const listeners = [...ctx.listeners.get('agent/request')];
  assert.ok(listeners.length > 0);
  let result = { provider: 'ymengguomo', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' };
  for (const listener of listeners) {
    result = await listener({ agent }, async () => result);
  }
  assert.deepEqual(result, { provider: 'ymengguomo', model: 'mimo-v2.6-pro', reasoningEffort: 'max' });
});

await check('every offered level passes the request-path validation', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({}, llm);
  const model = route.adapter.modelOf(route.adapter.current(), 'ymengguomo', 'deepseek-v4.1-flash');
  for (const level of DEFAULT_LEVELS) assert.equal(resolveReasoningLevel(model, level), level);
  assert.throws(() => resolveReasoningLevel(model, 'minimal'), /UNSUPPORTED_REASONING_EFFORT/);
  assert.throws(() => resolveReasoningLevel(model, 'ultra'), /UNSUPPORTED_REASONING_EFFORT/);
  assert.equal(resolveReasoningLevel(model, undefined), undefined);
});

await check('a model that already advertises reasoning is left alone', async () => {
  const own = { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null };
  const route = {
    id: 'openai',
    name: 'OpenAI',
    declared: false,
    models: ['gpt-5'],
    adapter: createAdapter(['gpt-5'], (provider, id) => ({
      provider,
      id,
      name: 'GPT-5',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: true,
      thinkingLevelMap: { ...own },
      input: ['text'],
    })),
  };
  const llm = createLlm([route]);
  mount({}, llm);
  // `declared: false` keeps the route out of the managed set entirely. `minimal`
  // is absent from the map, and pi-ai reads an absent key as supported.
  assert.deepEqual(await effortsOf(llm, 'openai', 'gpt-5'), ['minimal', 'low', 'medium', 'high']);

  const declared = {
    ...route,
    id: 'declared-efforts',
    declared: true,
    adapter: createAdapter(['gpt-5'], (provider, id) => ({
      provider,
      id,
      name: 'GPT-5',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.invalid/v1',
      reasoning: true,
      thinkingLevelMap: { ...own },
      input: ['text'],
    })),
  };
  const other = createLlm([declared]);
  mount({}, other);
  // A route that spells out `reasoningEfforts` keeps its own, narrower set.
  assert.deepEqual(await effortsOf(other, 'declared-efforts', 'gpt-5'), ['minimal', 'low', 'medium', 'high']);
});

await check('xhigh and max stay offered rather than collapsing to a lower level', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({}, llm);
  const model = route.adapter.modelOf(route.adapter.current(), 'ymengguomo', 'deepseek-v4.1-flash');
  assert.equal(model.thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(model.thinkingLevelMap.max, 'max');
  assert.equal(model.thinkingLevelMap.minimal, null);
  assert.equal(model.thinkingLevelMap.off, undefined);
});

await check('configuration narrows the levels and remaps the wire spelling', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({ levels: ['off', 'high'], wire: { off: 'none', high: 'HIGH' } }, llm);
  assert.deepEqual(await effortsOf(llm, 'ymengguomo', 'deepseek-v4.1-flash'), ['off', 'high']);
  const model = route.adapter.modelOf(route.adapter.current(), 'ymengguomo', 'deepseek-v4.1-flash');
  assert.equal(model.thinkingLevelMap.high, 'HIGH');
  assert.equal(model.thinkingLevelMap.off, 'none');
});

await check('routes and models can be excluded, and disabling is a no-op', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({ skipModels: ['mimo-v2.6-pro'] }, llm);
  assert.deepEqual(await effortsOf(llm, 'ymengguomo', 'deepseek-v4.1-flash'), DEFAULT_LEVELS);
  assert.equal(await effortsOf(llm, 'ymengguomo', 'mimo-v2.6-pro'), null);

  const off = thirdPartyRoute();
  const other = createLlm([off]);
  mount({ enabled: false }, other);
  assert.equal(await effortsOf(other, 'ymengguomo', 'deepseek-v4.1-flash'), null);
});

await check('the topology change is announced exactly once, without re-entering', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  const ctx = mount({}, llm);
  // One announcement, and one descriptor read per model: our own emit did not
  // re-enter `sync`, because the wrapper announces from inside its own dispatch.
  assert.deepEqual(ctx.emitted, ['llm/adapters-updated']);
  assert.equal(route.adapter.calls, 2);

  // A topology event from elsewhere re-syncs but stays silent while it changes nothing:
  // the only new entry is the test's own emit.
  const before = ctx.emitted.length;
  ctx.emit('llm/adapters-updated');
  assert.equal(ctx.emitted.length, before + 1);
  assert.equal(route.adapter.calls, 4);
});

await check('dispose restores the adapter and drops the decoration', async () => {
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  const original = route.adapter.modelOf;
  const ctx = mount({}, llm);
  assert.notEqual(route.adapter.modelOf, original);
  for (const dispose of ctx.disposers) dispose();
  assert.equal(route.adapter.modelOf, original);
  assert.equal(await effortsOf(llm, 'ymengguomo', 'deepseek-v4.1-flash'), null);
});

await check('reportPath writes the snapshot for a script without a browser cookie', async () => {
  const file = join(tmpdir(), `dsh-thinking-levels-${process.pid}.json`);
  const route = thirdPartyRoute();
  const llm = createLlm([route]);
  mount({ reportPath: file }, llm);
  // `publishReport` is fire-and-forget by design, so the write lands on a later tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const written = JSON.parse(await readFile(file, 'utf8'));
  await rm(file, { force: true });
  assert.equal(written.plugin, 'dsh-thinking-levels');
  assert.equal(typeof written.at, 'string');
  assert.deepEqual(written.levels, DEFAULT_LEVELS);
  assert.deepEqual(written.routes[0].models[0].efforts, DEFAULT_LEVELS);
});

// ---------------------------------------------------------------------------
// The wire half, against the real pi-ai when it is reachable.
// ---------------------------------------------------------------------------

/** Locate an installed pi-ai, or undefined. */
async function findPiAi() {
  for (const candidate of PI_AI_CANDIDATES) {
    try {
      await access(join(candidate, 'dist', 'api', 'openai-completions.js'));
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const piAi = await findPiAi();

if (piAi === undefined) {
  console.log('! pi-ai not found; skipping the wire assertions (set PI_AI_PATH to run them).\n');
} else {
  const { clampThinkingLevel } = await import(pathToFileURL(join(piAi, 'dist', 'models.js')).href);
  const { streamSimple } = await import(pathToFileURL(join(piAi, 'dist', 'api', 'openai-completions.js')).href);

  /** A minimal, valid Chat Completions SSE response. */
  const SSE = [
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m",'
    + '"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
    '',
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m",'
    + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');

  /** Drive pi-ai's own `streamSimple` and capture the request body it sends. */
  async function captureBody(model, reasoning) {
    let body;
    const fetchImpl = async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const stream = streamSimple(
      model,
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'test-key', fetch: fetchImpl, ...profileOptions(reasoning) },
    );
    try {
      // The request is issued on first pull; the fake response ends the stream.
      for await (const _chunk of stream) break;
    } catch {
      // A synthetic response may end the stream abruptly; the body is already captured.
    }
    assert.ok(body !== undefined, 'pi-ai never issued a request');
    return body;
  }

  /** Build the decorated descriptor for a third-party route. */
  function decoratedDescriptor(config = {}) {
    const route = thirdPartyRoute();
    const llm = createLlm([route]);
    mount(config, llm);
    return route.adapter.modelOf(route.adapter.current(), 'ymengguomo', 'deepseek-v4.1-flash');
  }

  await check('pi-ai accepts every offered level without clamping it away', async () => {
    const model = decoratedDescriptor();
    for (const level of DEFAULT_LEVELS) assert.equal(clampThinkingLevel(model, level), level);
    // `minimal` is deliberately not offered, so a request for it escalates.
    assert.equal(clampThinkingLevel(model, 'minimal'), 'low');
  });

  await check('the selected level reaches the provider as reasoning_effort', async () => {
    const model = decoratedDescriptor();
    assert.equal((await captureBody(model, 'high')).reasoning_effort, 'high');
    assert.equal((await captureBody(model, 'max')).reasoning_effort, 'max');
    assert.equal((await captureBody(model, 'xhigh')).reasoning_effort, 'xhigh');
    assert.equal((await captureBody(model, 'low')).reasoning_effort, 'low');
  });

  await check('off sends nothing, which is pi-ai\'s own meaning for it', async () => {
    const model = decoratedDescriptor();
    const body = await captureBody(model, 'off');
    assert.equal('reasoning_effort' in body, false);
    // The default is byte-identical to `off`, which is what "Default" promises.
    const unset = await captureBody(model, undefined);
    assert.equal('reasoning_effort' in unset, false);
  });

  await check('a remapped wire spelling is what the provider receives', async () => {
    const model = decoratedDescriptor({ wire: { high: 'HIGH', off: 'none' } });
    assert.equal((await captureBody(model, 'high')).reasoning_effort, 'HIGH');
    assert.equal((await captureBody(model, 'off')).reasoning_effort, 'none');
  });

  await check('an unmanaged model keeps pi-ai\'s own reasoning_effort', async () => {
    const route = {
      id: 'openai',
      name: 'OpenAI',
      declared: false,
      models: ['gpt-5'],
      adapter: createAdapter(['gpt-5'], (provider, id) => ({
        provider,
        id,
        name: 'GPT-5',
        api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        reasoning: true,
        thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
        input: ['text'],
      })),
    };
    const llm = createLlm([route]);
    mount({}, llm);
    const model = route.adapter.modelOf(route.adapter.current(), 'openai', 'gpt-5');
    assert.equal((await captureBody(model, 'high')).reasoning_effort, 'high');
    assert.equal('reasoning_effort' in (await captureBody(model, 'off')), false);
  });
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}`);
  if (!result.ok) console.log(`      ${result.error?.message ?? result.error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
