/**
 * dsh-thinking-levels — Host half.
 *
 * Gives every third-party ("hand-declared") pi-ai route a reasoning-effort
 * capability: the built-in model picker grows its 推理等级 / Effort row, and the
 * level the user picks is the level that reaches the provider.
 *
 * ## Why the capability is missing in the first place
 *
 * The harness offers a thinking-level selector exactly when an adapter reports
 * reasoning metadata for an exact model (`llm.resolveModelInfo` →
 * `LlmResolvedModelInfo.reasoning`), and `@deepseek-ai/dsh-llm-pi-ai` derives
 * that metadata from the pi-ai model descriptor it materializes. A route pi-ai's
 * installed catalog does not ship starts from `reasoning: false`, so unless its
 * configuration spells out `reasoningEfforts` for every single model, the
 * selector has nothing to offer — and `LlmRuntime.resolveCallConfig` would
 * reject an explicit effort with `UNSUPPORTED_REASONING_EFFORT` anyway.
 *
 * ## What this plugin does instead
 *
 * It decorates that descriptor at the one point every read passes through —
 * `PiAiAdapter.modelOf(snapshot, provider, model)` — so the capability exists
 * without rewriting the profile's provider configuration. Everything else
 * follows from that single decoration, because all three consumers read the
 * same object:
 *
 *  - `resolveModel` / `prepareCall` → `modelInfo()` → `reasoningInfo()` reads
 *    `model.reasoning` + `model.thinkingLevelMap`, so `llm.resolveModelInfo`
 *    reports the offered levels; the browser catalog carries them and the model
 *    picker renders the effort row.
 *  - `LlmRuntime.resolveCallWithInfo` validates the selected level against
 *    those same efforts instead of refusing it.
 *  - `streamWithSnapshot` calls `resolveReasoningLevel(model, effort)`, then
 *    hands the level to pi-ai as `{ reasoning }`; pi-ai clamps it against the
 *    same `thinkingLevelMap` and sends it on the wire (`reasoning_effort` for
 *    OpenAI-compatible Chat Completions, or whatever the compat format names).
 *
 * ## What is deliberately not touched
 *
 * A model that already advertises reasoning — a pi-ai catalog model, or a route
 * whose configuration declares `reasoningEfforts` — is never modified: an
 * explicit declaration always wins over this plugin's default. `off` is left
 * without a wire value by default, which is pi-ai's own semantics ("send
 * nothing", i.e. the provider's default), because an OpenAI-compatible endpoint
 * has no universal way to say "do not think"; `wire.off` exists for endpoints
 * that do have one.
 *
 * @module dsh-thinking-levels
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Every level pi-ai can express, in its escalation order. */
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The levels offered when configuration names none. */
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Route prefix owned by this plugin; it outranks the kernel's `/api` by length. */
const ROUTE_PREFIX = '/api/dsh-thinking-levels';

/**
 * Non-enumerable marker recording which configuration revision produced the
 * decoration currently on a descriptor. Non-enumerable so it never reaches a
 * spread, `structuredClone`, or a JSON body.
 */
const PATCH_KEY = '__dshThinkingLevelsRevision';

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Read a list of trimmed non-empty strings, tolerating anything else. */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const text = nonEmptyString(entry);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/**
 * Resolve the plugin's configuration into the exact shape the runtime uses.
 *
 * Defensive by construction: the loader hands over whatever the patch file
 * wrote, and a malformed value must degrade to the documented default rather
 * than fail the whole profile.
 *
 * @param raw - the loader entry's config object, when any.
 * @returns normalized options.
 */
function normalizeOptions(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const requested = stringList(source.levels);
  const levels = requested.length === 0
    ? [...DEFAULT_LEVELS]
    : ALL_LEVELS.filter((level) => requested.includes(level));

  const wire = {};
  const wireSource = source.wire !== null && typeof source.wire === 'object' ? source.wire : {};
  for (const level of ALL_LEVELS) {
    if (!(level in wireSource)) continue;
    const value = wireSource[level];
    if (value === null || value === undefined) wire[level] = null;
    else {
      const text = nonEmptyString(value);
      if (text !== undefined) wire[level] = text;
    }
  }

  const compat = {};
  const compatSource = source.compat !== null && typeof source.compat === 'object' ? source.compat : {};
  const thinkingFormat = nonEmptyString(compatSource.thinkingFormat);
  if (thinkingFormat !== undefined) compat.thinkingFormat = thinkingFormat;
  if (typeof compatSource.supportsReasoningEffort === 'boolean') {
    compat.supportsReasoningEffort = compatSource.supportsReasoningEffort;
  }
  const budgetField = nonEmptyString(compatSource.thinkingTokenBudgetField);
  if (budgetField !== undefined) compat.thinkingTokenBudgetField = budgetField;
  if (compatSource.supportsThinkingTokenBudget === true) compat.supportsThinkingTokenBudget = true;

  return {
    enabled: source.enabled !== false,
    routes: stringList(source.routes),
    skipRoutes: stringList(source.skipRoutes),
    skipModels: stringList(source.skipModels),
    levels: levels.length === 0 ? [...DEFAULT_LEVELS] : levels,
    wire,
    compat,
    reportPath: nonEmptyString(source.reportPath) ?? '',
  };
}

/**
 * Build the `thinkingLevelMap` pi-ai reads.
 *
 * pi-ai's defaulting is asymmetric — an absent key means "supported" for the
 * five base levels but "unsupported" for `xhigh`/`max` — so every level is
 * decided explicitly: offered levels carry their wire spelling, everything else
 * is pinned to `null`. `off` is the one level allowed to stay `undefined`,
 * which pi-ai reads as "supported, send nothing".
 *
 * @param options - normalized plugin options.
 * @returns the level → wire map.
 */
function thinkingLevelMap(options) {
  const map = {};
  for (const level of ALL_LEVELS) map[level] = null;
  for (const level of options.levels) {
    if (level === 'off') {
      const wire = options.wire.off;
      map.off = typeof wire === 'string' ? wire : undefined;
      continue;
    }
    const wire = options.wire[level];
    map[level] = typeof wire === 'string' ? wire : level;
  }
  return map;
}

/** The runtime that owns adapter wrapping and descriptor decoration. */
function createRuntime(ctx, options) {
  /** Adapter instance → the `modelOf` it had before this plugin wrapped it. */
  const wrapped = new Map();
  /** Descriptor → the exact shape it had before this plugin first decorated it. */
  const originals = new WeakMap();
  /** Descriptors this plugin currently holds a decoration on. */
  const decorated = new Set();
  /** Provider routes this plugin currently manages. */
  let targets = new Set();
  /** Bumped on every sync so stale decorations are rebuilt. */
  let revision = 0;
  /** Re-entrancy depth for the `llm/adapters-updated` announcement. */
  let announcing = 0;
  /** Last announced summary, so an unchanged topology stays silent. */
  let announced = '';

  const report = { routes: [], patchedModels: 0, unsupported: [], reason: '' };

  /** Is this provider a target under the current configuration? */
  function targeted(provider, model) {
    if (!targets.has(provider)) return false;
    if (options.skipModels.length === 0) return true;
    return !options.skipModels.includes(model) && !options.skipModels.includes(`${provider}/${model}`);
  }

  /**
   * Decorate one pi-ai model descriptor in place.
   *
   * @param model - the descriptor `modelOf` returned.
   * @param provider - the route that owns it.
   * @returns the same descriptor.
   */
  function decorate(model, provider, modelId) {
    if (model === null || typeof model !== 'object') return model;
    if (!targeted(provider, modelId)) return model;
    const ours = model[PATCH_KEY] !== undefined;
    // A capability somebody else declared (the installed catalog, or the route's
    // own `reasoningEfforts`) always wins over this plugin's default.
    if (model.reasoning && !ours) return model;
    if (ours && model[PATCH_KEY] === revision) return model;
    // Remember the untouched shape once, so disabling the plugin can put the
    // descriptor back exactly as it was found.
    if (!ours) {
      originals.set(model, {
        reasoning: model.reasoning,
        hadMap: Object.hasOwn(model, 'thinkingLevelMap'),
        thinkingLevelMap: model.thinkingLevelMap,
        hadCompat: Object.hasOwn(model, 'compat'),
        compat: model.compat,
      });
    }
    model.reasoning = true;
    model.thinkingLevelMap = thinkingLevelMap(options);
    if (Object.keys(options.compat).length > 0) {
      model.compat = { ...(model.compat ?? {}), ...options.compat };
    }
    Object.defineProperty(model, PATCH_KEY, {
      value: revision,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    decorated.add(model);
    report.patchedModels += 1;
    return model;
  }

  /**
   * Wrap one adapter instance's `modelOf`.
   *
   * `modelOf` is the single funnel `modelInfo()` (catalog + call validation) and
   * `streamWithSnapshot()` (dispatch) both go through, so one wrapper covers
   * describing a model and sending it. The wrapper is an own property that
   * shadows the prototype method, which keeps the change reversible.
   *
   * @param adapter - a candidate adapter instance.
   * @returns whether this call added the wrapper.
   */
  function wrap(adapter) {
    if (wrapped.has(adapter)) return false;
    if (typeof adapter.modelOf !== 'function' || typeof adapter.current !== 'function') return false;
    const original = adapter.modelOf;
    wrapped.set(adapter, original);
    adapter.modelOf = function modelOf(snapshot, provider, model) {
      return decorate(original.call(this, snapshot, provider, model), provider, model);
    };
    return true;
  }

  /** Reach one registered adapter instance. The registry is the only handle. */
  function adapterFor(llm, provider) {
    const registry = llm?.adapters;
    if (registry === null || typeof registry !== 'object' || typeof registry.get !== 'function') return undefined;
    return registry.get(provider)?.adapter;
  }

  /** Compute the managed route set for the current live topology. */
  function resolveTargets(llm) {
    const registered = new Set();
    try {
      for (const provider of llm.listProviders()) registered.add(provider.id);
    } catch {
      // The registry is not readable yet; the next announcement retries.
    }
    const skip = new Set(options.skipRoutes);
    if (options.routes.length > 0) {
      return new Set(options.routes.filter((id) => registered.has(id) && !skip.has(id)));
    }
    const declared = [];
    try {
      for (const entry of llm.listConfigurableProviders()) {
        if (entry?.declared === true && typeof entry.provider === 'string') declared.push(entry.provider);
      }
    } catch {
      // No directory yet: fail closed rather than decorating catalog models.
    }
    return new Set(declared.filter((id) => registered.has(id) && !skip.has(id)));
  }

  /** Announce the topology change so browser catalogs reload. */
  function announce() {
    if (announcing > 0) return;
    announcing += 1;
    try {
      ctx.emit('llm/adapters-updated');
    } catch (error) {
      ctx.logger?.warn?.('dsh-thinking-levels: announcing the topology change failed');
      ctx.logger?.warn?.(error);
    } finally {
      announcing -= 1;
    }
  }

  /**
   * Reconcile the plugin with the live adapter topology: recompute the managed
   * routes, wrap their adapters, and eagerly decorate every descriptor so the
   * catalog reflects the capability before anyone asks for it.
   *
   * @param llm - the live `llm` service.
   * @returns a short human-readable summary.
   */
  function sync(llm) {
    report.routes = [];
    report.patchedModels = 0;
    report.unsupported = [];
    report.reason = '';

    if (!options.enabled) {
      report.reason = 'disabled';
      return report;
    }

    targets = resolveTargets(llm);
    revision += 1;
    let addedWrapper = false;

    for (const provider of targets) {
      const adapter = adapterFor(llm, provider);
      if (adapter === undefined) {
        report.unsupported.push({ provider, reason: 'no registered adapter' });
        continue;
      }
      if (typeof adapter.modelOf !== 'function' || typeof adapter.current !== 'function') {
        report.unsupported.push({ provider, reason: 'adapter does not expose modelOf()/current()' });
        continue;
      }
      if (wrap(adapter)) addedWrapper = true;

      let snapshot;
      try {
        snapshot = adapter.current();
      } catch (error) {
        report.unsupported.push({ provider, reason: `current() failed: ${String(error?.message ?? error)}` });
        continue;
      }
      let models = [];
      try {
        models = snapshot?.models?.getModels?.(provider) ?? [];
      } catch {
        models = [];
      }
      const patched = [];
      for (const model of models) {
        try {
          const decorated = adapter.modelOf(snapshot, provider, model.id);
          if (decorated?.reasoning === true) patched.push(model.id);
        } catch {
          // One unresolvable model (a configuration diagnostic) never blocks the route.
        }
      }
      report.routes.push({ provider, models: patched });
    }

    const summary = [...targets].sort().join(',');
    if (addedWrapper || summary !== announced) {
      announced = summary;
      announce();
    }

    ctx.logger?.info?.(
      `dsh-thinking-levels: managing ${targets.size} route(s) [${summary || 'none'}] `
      + `with levels [${options.levels.join(', ')}]; decorated ${report.patchedModels} model descriptor(s)`,
    );
    return report;
  }

  return {
    options,
    /** Serialized body of the last report written, so an unchanged state writes once. */
    lastReport: '',
    /** Force a re-sync; used by the diagnostic route. */
    resync(llm) {
      announced = '';
      return sync(llm);
    },
    sync,
    /** The managed routes and the decorated-model count of the last sync. */
    report() {
      return { ...report, routes: report.routes.map((route) => ({ ...route })) };
    },
    /** Is this plugin currently inside its own announcement? */
    isAnnouncing() {
      return announcing > 0;
    },
    /** Restore every wrapped adapter and undo every decoration. */
    dispose() {
      for (const [adapter, original] of wrapped) {
        try {
          adapter.modelOf = original;
        } catch {
          // A disposed adapter is not worth fighting over.
        }
      }
      wrapped.clear();
      for (const model of decorated) {
        const original = originals.get(model);
        if (original === undefined) continue;
        try {
          model.reasoning = original.reasoning;
          if (original.hadMap) model.thinkingLevelMap = original.thinkingLevelMap;
          else delete model.thinkingLevelMap;
          if (original.hadCompat) model.compat = original.compat;
          else delete model.compat;
          delete model[PATCH_KEY];
        } catch {
          // A frozen descriptor keeps the decoration; the next snapshot drops it.
        }
      }
      decorated.clear();
      targets = new Set();
    },
  };
}

/** Split an authority value into {scheme, hostname, port}, defaulting the port. */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/**
 * The request trust fence.
 *
 * This prefix is longer than the kernel's `/api`, and webServer dispatch is
 * longest-prefix-wins, so these routes would otherwise answer any loopback
 * caller before the connection service's own admission check. Prefer that
 * service when the composition mounts it; otherwise apply the structural
 * replica of the same fence (loopback Host, no cross-site fetch, matching
 * Origin/Referer authority).
 *
 * @param req - the incoming request.
 * @param connection - the harness connection service, when present.
 * @returns an HTTP status to reject with, or undefined to proceed.
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req);
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection;
      return undefined;
    } catch {
      // A throwing connection service is a composition bug; fall through to the replica.
    }
  }
  const host = authorityOf(req.headers.host, 'http');
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403;
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const authority = authorityOf(raw.trim());
    if (authority === null) return 403;
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403;
  }
  return undefined;
}

/**
 * What the model picker will actually show, read back through the public LLM
 * service rather than from this plugin's own bookkeeping.
 *
 * @param llm - the live `llm` service, when available.
 * @param runtime - this plugin's runtime.
 * @returns the diagnostic snapshot.
 */
async function describe(llm, runtime) {
  const base = {
    plugin: 'dsh-thinking-levels',
    enabled: runtime.options.enabled,
    levels: runtime.options.levels,
    wire: runtime.options.wire,
    compat: runtime.options.compat,
    configuredRoutes: runtime.options.routes,
    sync: runtime.report(),
  };
  if (llm === undefined) return { ...base, available: false, reason: 'the llm service is not mounted' };
  const names = new Map();
  try {
    for (const provider of llm.listProviders()) names.set(provider.id, provider.name);
  } catch {
    // Names are cosmetic.
  }
  const routes = [];
  for (const route of runtime.report().routes) {
    const models = [];
    let listed = [];
    try {
      listed = await llm.listModels(route.provider);
    } catch (error) {
      routes.push({ provider: route.provider, name: names.get(route.provider) ?? route.provider, error: String(error?.message ?? error), models: [] });
      continue;
    }
    for (const model of listed) {
      try {
        const resolved = await llm.resolveModelInfo(route.provider, model.id);
        models.push({
          id: model.id,
          name: resolved.name,
          efforts: resolved.reasoning?.efforts?.map((effort) => effort.id) ?? null,
          defaultEffort: resolved.reasoning?.defaultEffort ?? null,
        });
      } catch (error) {
        models.push({ id: model.id, error: String(error?.message ?? error) });
      }
    }
    routes.push({ provider: route.provider, name: names.get(route.provider) ?? route.provider, models });
  }
  return { ...base, available: true, routes };
}

/**
 * Write the diagnostic snapshot to `reportPath`, when one is configured.
 *
 * Opt-in and idempotent: the same body is written once, so a topology event
 * that changes nothing leaves the file's mtime alone. This exists because the
 * `/state` route sits behind the same browser-session admission as every other
 * `/api` path, which makes it useless to a script that has no cookie.
 *
 * @param ctx - the plugin's Host context, for diagnostics.
 * @param runtime - this plugin's runtime.
 * @param llm - the live `llm` service, when available.
 */
async function publishReport(ctx, runtime, llm) {
  const path = runtime.options.reportPath;
  if (path === '') return;
  try {
    const payload = await describe(llm, runtime);
    const body = JSON.stringify(payload);
    if (body === runtime.lastReport) return;
    runtime.lastReport = body;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2)}\n`, 'utf8');
  } catch (error) {
    ctx.logger?.warn?.('dsh-thinking-levels: writing the diagnostic report failed');
    ctx.logger?.warn?.(error);
  }
}

/**
 * The plugin's HTTP surface: `GET /state` and `POST /resync`.
 *
 * @param runtime - this plugin's runtime.
 * @param getLlm - reads the optional `llm` service.
 * @param getConnection - reads the optional connection service.
 * @returns a node request handler.
 */
function createHandler(ctx, runtime, getLlm, getConnection) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/';
    const method = String(req.method ?? 'GET').toUpperCase();
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    const rejection = rejectionFor(req, getConnection());
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
    try {
      const llm = getLlm();
      if (method === 'GET' && path === '/state') return send(200, await describe(llm, runtime));
      if (method === 'POST' && path === '/resync') {
        if (llm === undefined) return send(503, { error: 'the llm service is not mounted' });
        runtime.resync(llm);
        await publishReport(ctx, runtime, llm);
        return send(200, await describe(llm, runtime));
      }
      return send(404, { error: 'not-found' });
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * Mount the reasoning-effort capability.
 *
 * @param ctx - the plugin's Host context.
 * @param config - the loader entry's config object.
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config);
  const runtime = createRuntime(ctx, options);

  ctx.inject(['llm'], (scoped) => {
    const reconcile = () => {
      runtime.sync(scoped.llm);
      void publishReport(ctx, runtime, scoped.get('llm', false));
    };
    scoped.effect(
      () => scoped.on('llm/adapters-updated', () => {
        // Our own announcement must not recurse.
        if (runtime.isAnnouncing()) return;
        reconcile();
      }),
      'dsh-thinking-levels: adapter topology',
    );
    scoped.effect(() => () => runtime.dispose(), 'dsh-thinking-levels: unwrap adapters');
    reconcile();
  });

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(
          ctx,
          runtime,
          () => scoped.get('llm', false),
          () => scoped.get('connection', false),
        ),
      }),
      'dsh-thinking-levels: routes',
    );
  });
}
