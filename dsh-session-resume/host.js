/**
 * dsh-session-resume — Host half.
 *
 * Owns two capabilities that share one idea: never make the user retype intent
 * the session already holds.
 *
 * 1. Manual retry. The agent loop's `agent/request-error` waterfall is the only
 *    point at which a failed model request can be re-run *without* appending a
 *    user message: returning `{ kind: 'retry' }` makes the loop re-run the same
 *    step, in the same open turn, over the same durable history, so the model
 *    receives a byte-identical request and the transcript shows no interruption.
 *    That requires the turn to stay open, so this plugin parks the failed
 *    attempt instead of letting it become terminal, and releases it when the
 *    user retries, dismisses, stops the turn, or the park times out.
 *
 * 2. Seamless resume. A closed turn can only be re-driven by offering the agent
 *    new inbox input, so resume queues one continuation message and wakes the
 *    driver. Its content is the session's own retained runtime-context snapshot
 *    whenever one exists — the exact text the harness already injects between
 *    steps — so the model reads a normal context refresh rather than a user
 *    instruction such as "continue", and no user bubble is rendered.
 *
 * Cordis service access: a plugin fiber may not read `ctx.<service>` unless it
 * declares that dependency — doing so throws `cannot get property "<name>"
 * without inject`. The agent registry is therefore reached through
 * `ctx.inject(['agents'], …)`, with `ctx.get('agents')` as the fallback for the
 * window before that injected fiber settles.
 *
 * The Client half reads the parked state and issues the actions through this
 * plugin's own routes; nothing is written to the session log, so no custom
 * event vocabulary has to be understood by the persistence read path.
 *
 * @module dsh-session-resume
 */
import { randomUUID } from 'node:crypto';

/** Route prefix owned by this plugin; it outranks the kernel's `/api` by length. */
const ROUTE_PREFIX = '/api/dsh-session-resume';

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** The `user/message` source kind the AgentLoop uses for its runtime-context snapshots. */
const RUNTIME_CONTEXT_SOURCE = 'runtime-context';

/** Used only when the session carries no runtime-context snapshot to reuse. */
const FALLBACK_CONTINUATION =
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';

/** How far back a runtime-context lookup scans, in events. */
const CONTEXT_SCAN_EVENTS = 400;

/** Default park lifetime; after it the failure settles as terminal. */
const DEFAULT_PARK_TIMEOUT_MS = 30 * 60 * 1000;

/** Read a positive finite integer from config, or the fallback. */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/** Join the text blocks of one content array. */
function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The session's latest retained runtime-context text.
 *
 * The AgentLoop records one `user/message` per runtime-context snapshot and
 * only re-emits it when the rendering changes, so reusing the newest one keeps
 * a resumed step indistinguishable from an ordinary context refresh.
 *
 * @param {object} session - the live Session.
 * @returns {string|undefined} the snapshot text, or undefined when none exists.
 */
function lastRuntimeContextText(session) {
  try {
    const seq = Number(session?.seq ?? 0);
    const from = Math.max(0, (Number.isFinite(seq) ? seq : 0) - CONTEXT_SCAN_EVENTS);
    const events = session.snapshotEvents(from);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'user/message') continue;
      if (event.data?.source?.kind !== RUNTIME_CONTEXT_SOURCE) continue;
      const text = textOfContent(event.data.content);
      if (text !== '') return text;
    }
  } catch {
    // An unreadable session falls back to the default continuation text.
  }
  return undefined;
}

/** Split a Host/Origin/Referer value into {scheme, hostname, port}, defaulting the port. */
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
 * replica of the same fence.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @param {object|undefined} connection - the harness connection service, when present.
 * @returns {number|undefined} an HTTP status to reject with, or undefined to proceed.
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

/** Read one JSON request body with a hard size cap. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object');
  return parsed;
}

/**
 * Mount the parked-retry machinery, the resume action, and their routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's Host context.
 * @param {object} [config] - optional plugin configuration.
 */
export function apply(ctx, config = {}) {
  const parkTimeoutMs = positiveInt(config.parkTimeoutMs, DEFAULT_PARK_TIMEOUT_MS);
  /** Opt-in: park even under an unlimited (`always`) retry policy, replacing automatic retries. */
  const manualOnAlways = config.manualOnAlways === true;
  /** Explicit continuation text; when absent the retained runtime-context snapshot is reused. */
  const customContinuation = typeof config.continuationText === 'string' && config.continuationText !== '' ? config.continuationText : undefined;

  /** sessionId → parked failed attempt. */
  const parks = new Map();
  /** sessionId → last observed turn outcome. */
  const outcomes = new Map();
  const lifetime = new AbortController();

  // Turn outcomes let the Client tell "stopped with unfinished work" from "never started".
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    outcomes.set(String(session.id), { reason: event.data.reason.kind, turn: event.data.turn });
  }), 'dsh-session-resume: turn outcomes');

  /**
   * The agent registry.
   *
   * Cordis refuses `ctx.agents` on a fiber that has not declared the dependency
   * ("cannot get property \"agents\" without inject"), so the registry is
   * captured through `inject` — the same pattern this plugin already uses for
   * `webServer` — with the reflective `ctx.get` face covering the window before
   * that injected fiber settles.
   */
  let injectedAgents;
  ctx.effect(() => ctx.inject(['agents'], (scoped) => {
    injectedAgents = scoped.agents;
    return () => {
      injectedAgents = undefined;
    };
  }), 'dsh-session-resume: agent registry');

  function agentRegistry() {
    if (injectedAgents !== undefined && typeof injectedAgents.get === 'function') return injectedAgents;
    try {
      const reflective = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      if (reflective !== undefined && reflective !== null && typeof reflective.get === 'function') return reflective;
    } catch {
      // No registry reachable from this context.
    }
    return undefined;
  }

  /** Release one park exactly once; later calls are no-ops. */
  function release(sessionId, decision) {
    const record = parks.get(sessionId);
    if (record === undefined || record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    try {
      record.signal.removeEventListener('abort', record.onAbort);
    } catch {
      // A signal that cannot be observed simply keeps its timer-based release.
    }
    parks.delete(sessionId);
    record.decide(decision);
  }

  /**
   * Park one failed model attempt and wait for the user's decision.
   *
   * The turn stays open for the whole wait, which is exactly what makes an
   * accepted retry message-free: the loop re-runs the same step over the same
   * durable history instead of opening a new turn with new input.
   */
  async function park({ agent, turn, step, provider, failure, signal }, next) {
    const sessionId = String(agent.id);
    release(sessionId, 'dismiss');
    const deferred = {};
    const promise = new Promise((resolve) => {
      deferred.resolve = resolve;
    });
    const record = {
      sessionId,
      turn,
      step,
      provider,
      failure,
      startedAt: Date.now(),
      settled: false,
      signal,
      decide: deferred.resolve,
      timer: undefined,
      onAbort: undefined,
    };
    record.onAbort = () => release(sessionId, 'dismiss');
    parks.set(sessionId, record);
    record.timer = setTimeout(() => release(sessionId, 'dismiss'), parkTimeoutMs);
    try {
      signal.addEventListener('abort', record.onAbort, { once: true });
    } catch {
      // Without an abort listener the timeout still bounds the park.
    }
    const decision = await promise;
    if (decision === 'retry') return { kind: 'retry' };
    return next();
  }

  ctx.effect(() => ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return next();
    const { agent, signal, retryPolicy } = payload;
    if (agent === undefined || signal?.aborted === true) return next();
    // An unlimited provider policy already owns recovery; parking would silently
    // replace its automatic retries with a manual gate.
    if (retryPolicy !== undefined && retryPolicy.mode === 'always' && !manualOnAlways) return next();
    return park(payload, next);
  }), 'dsh-session-resume: parked retries');

  /** The continuation text a resume will queue for this session. */
  function continuationFor(session) {
    if (customContinuation !== undefined) return { text: customContinuation, custom: true };
    const retained = lastRuntimeContextText(session);
    if (retained !== undefined) return { text: retained, custom: false };
    return { text: FALLBACK_CONTINUATION, custom: false };
  }

  /** Read the live agent for one session id, or undefined. */
  function liveAgent(sessionId) {
    const registry = agentRegistry();
    if (registry === undefined) return undefined;
    try {
      return registry.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /** The retry attempt count the provider policy has already spent, when observable. */
  function retryProgress(agent) {
    try {
      const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
      const state = projections?.stateOf(agent.session, 'llmRetry');
      if (state === null || typeof state !== 'object') return undefined;
      let retry = 0;
      for (const entry of Object.values(state)) {
        if (entry !== null && typeof entry === 'object' && Number.isFinite(entry.retry) && entry.retry > retry) retry = entry.retry;
      }
      return retry;
    } catch {
      return undefined;
    }
  }

  function parkView(record, retry) {
    return {
      turn: record.turn,
      step: record.step,
      provider: record.provider,
      message: typeof record.failure?.message === 'string' ? record.failure.message : String(record.failure?.message ?? ''),
      code: typeof record.failure?.code === 'string' ? record.failure.code : undefined,
      status: Number.isFinite(record.failure?.status) ? record.failure.status : undefined,
      startedAt: record.startedAt,
      retry,
      expiresAt: record.startedAt + parkTimeoutMs,
    };
  }

  /** One session's observable state for the Client half. */
  function sessionState(sessionId) {
    const agent = liveAgent(sessionId);
    const parked = parks.get(sessionId);
    const outcome = outcomes.get(sessionId);
    if (agent === undefined) {
      return {
        sessionId,
        live: false,
        running: false,
        hasHistory: false,
        lastTurn: outcome === undefined ? null : { reason: outcome.reason, turn: outcome.turn },
        park: parked === undefined ? null : parkView(parked, undefined),
        resumable: false,
      };
    }
    let hasHistory = false;
    try {
      hasHistory = Number(agent.session?.seq ?? 0) > 0;
    } catch {
      hasHistory = false;
    }
    const running = agent.status === 'running';
    const retry = parked === undefined ? undefined : retryProgress(agent);
    return {
      sessionId,
      live: true,
      running,
      hasHistory,
      lastTurn: outcome === undefined ? null : { reason: outcome.reason, turn: outcome.turn },
      park: parked === undefined ? null : parkView(parked, retry),
      resumable: !running,
    };
  }

  /** Queue the continuation turn that resumes a stopped session. */
  function resume(sessionId) {
    const agent = liveAgent(sessionId);
    if (agent === undefined) return { ok: false, error: 'session-not-live' };
    if (agent.status === 'running') return { ok: false, error: 'session-running' };
    let hasHistory = false;
    try {
      hasHistory = Number(agent.session?.seq ?? 0) > 0;
    } catch {
      hasHistory = false;
    }
    if (!hasHistory) return { ok: false, error: 'session-empty' };
    const continuation = continuationFor(agent.session);
    // The inbox stores complete identified user messages: the id keys the claim,
    // the discard notification, and the Client's chat-node match, and the role is
    // what the derived request sends to the provider.
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: continuation.text }],
      // The retained snapshot is the harness's own context channel, so a resumed
      // step reads as an ordinary refresh rather than as a plugin instruction.
      source: continuation.custom ? { kind: 'plugin', plugin: 'dsh-session-resume' } : { kind: RUNTIME_CONTEXT_SOURCE },
    });
    return { ok: true, resumed: true };
  }

  /** The plugin's HTTP surface. */
  function createHandler(connection) {
    return async function handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/';
      const method = String(req.method ?? 'GET').toUpperCase();
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      const rejection = rejectionFor(req, connection());
      if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      try {
        if (method === 'GET' && path === '/state') {
          const sessionId = url.searchParams.get('sessionId');
          if (sessionId === null || sessionId === '') return send(400, { error: 'sessionId is required' });
          return send(200, sessionState(sessionId));
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          if (sessionId === '') return send(400, { error: 'sessionId is required' });
          if (path === '/retry') {
            if (!parks.has(sessionId)) return send(409, { error: 'no-parked-request' });
            release(sessionId, 'retry');
            return send(200, { ok: true });
          }
          if (path === '/dismiss') {
            if (!parks.has(sessionId)) return send(409, { error: 'no-parked-request' });
            release(sessionId, 'dismiss');
            return send(200, { ok: true });
          }
          if (path === '/resume') return send(200, resume(sessionId));
        }
        return send(404, { error: 'not-found' });
      } catch (error) {
        return send(500, { error: String(error?.message ?? error) });
      }
    };
  }

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    scoped.effect(
      () => server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(() => scoped.get('connection')),
      }),
      'dsh-session-resume: routes',
    );
  });

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-session-resume plugin disposed'));
    for (const sessionId of [...parks.keys()]) release(sessionId, 'dismiss');
    parks.clear();
    outcomes.clear();
  }, 'dsh-session-resume: release parked retries');
}
