/**
 * dsh-session-branch — Host half.
 *
 * Answers one question for the Client: for this session, which fork points have
 * siblings, and where is this session among them?
 *
 * A "snapshot" in the Client's sense is a conversation branch. Forking copies an
 * inclusive event prefix, and the child records exactly how many source events
 * it inherited (`Session.inheritedEventCount`), so the cut is
 * `inheritedEventCount - 1` — directly comparable to the parent's own sequence
 * space. Two children are true siblings only when their cuts are equal, which is
 * why this half compares cuts instead of merely grouping by parent.
 *
 * The listing comes from `ctx.sessionQuery`, the live-preferred logical corpus,
 * so siblings that are not currently open still count. Cordis refuses
 * `ctx.<service>` on a fiber that has not declared the dependency, so both
 * services are captured through `inject` with a reflective `ctx.get` fallback.
 *
 * @module dsh-session-branch
 */

/** Route prefix owned by this plugin; it outranks the kernel's `/api` by length. */
const ROUTE_PREFIX = '/api/dsh-session-branch';

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** How long one session's header/log read is reused, in milliseconds. */
const FACTS_TTL_MS = 4000;

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

/**
 * Mount the branch-family query and its route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's Host context.
 */
export function apply(ctx) {
  /** The session query service, captured through the injected face. */
  let injectedQuery;
  ctx.effect(() => ctx.inject(['sessionQuery'], (scoped) => {
    injectedQuery = scoped.sessionQuery;
    return () => {
      injectedQuery = undefined;
    };
  }), 'dsh-session-branch: session query');

  function sessionQuery() {
    if (injectedQuery !== undefined && typeof injectedQuery.readSession === 'function') return injectedQuery;
    try {
      const reflective = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
      if (reflective !== undefined && reflective !== null && typeof reflective.readSession === 'function') return reflective;
    } catch {
      // No query service reachable from this context.
    }
    return undefined;
  }

  /** The live Session for one id, when the store is reachable. */
  function liveSession(sessionId) {
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      return sessions === undefined || sessions === null ? undefined : sessions.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /** One session's header, inherited prefix, and log, cached briefly. */
  const factsCache = new Map();
  async function sessionFacts(sessionId) {
    const cached = factsCache.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < FACTS_TTL_MS) return cached.value;
    let value;
    const live = liveSession(sessionId);
    if (live !== undefined) {
      value = { header: live.header, inherited: Number(live.inheritedEventCount ?? 0), events: live.snapshotEvents() };
    } else {
      const query = sessionQuery();
      if (query === undefined) return undefined;
      const snapshot = await query.readSession(sessionId);
      value = { header: snapshot.session, inherited: Number(snapshot.inheritedEventCount ?? 0), events: snapshot.events };
    }
    factsCache.set(sessionId, { at: Date.now(), value });
    return value;
  }

  /** The surface message ids carried through, and immediately after, one cut. */
  function surfaceMessagesAt(events, boundary) {
    let before;
    let after;
    for (const event of events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      const message = event.type === 'user/message' ? event.data : event.data?.message;
      const id = typeof message?.id === 'string' ? message.id : undefined;
      if (id === undefined) continue;
      if (event.seq <= boundary) before = id;
      else if (after === undefined) after = id;
    }
    return { before, after };
  }

  /**
   * The branch families anchored in one session.
   *
   * @param {string} sessionId - the session whose transcript will show pagers.
   * @returns {Promise<{sessionId: string, forks: Record<string, object>}>}
   */
  async function branchState(sessionId) {
    const query = sessionQuery();
    const self = await sessionFacts(sessionId);
    if (self === undefined) return { sessionId, forks: {} };

    const cuts = [];
    const parentId = self.header?.parentSession === undefined || self.header?.parentSession === null ? undefined : String(self.header.parentSession);
    if (parentId !== undefined && self.inherited > 0) cuts.push({ root: parentId, boundary: self.inherited - 1 });
    if (query !== undefined) {
      try {
        for (const record of await query.filterSessions([{ kind: 'parent', values: [sessionId] }])) {
          const childId = String(record.header.id);
          const facts = await sessionFacts(childId);
          if (facts === undefined || facts.inherited <= 0) continue;
          const boundary = facts.inherited - 1;
          if (!cuts.some((cut) => cut.boundary === boundary)) cuts.push({ root: sessionId, boundary });
        }
      } catch {
        // A listing failure simply leaves this session's own family.
      }
    }
    if (cuts.length === 0) return { sessionId, forks: {} };

    const titles = async (ids) => {
      const map = new Map();
      if (query === undefined || ids.length === 0) return map;
      try {
        for (const result of await query.readTitleSnapshots(ids)) {
          if (result?.status === 'fulfilled') map.set(String(result.sessionId), result.value?.title?.title ?? null);
        }
      } catch {
        // Titles are cosmetic; ids still identify the branches.
      }
      return map;
    };

    const forks = {};
    for (const cut of cuts) {
      const members = [];
      if (cut.root !== undefined) members.push(cut.root);
      if (query !== undefined) {
        try {
          for (const record of await query.filterSessions([{ kind: 'parent', values: [cut.root] }])) {
            const childId = String(record.header.id);
            const facts = await sessionFacts(childId);
            if (facts === undefined || facts.inherited - 1 !== cut.boundary) continue;
            members.push(childId);
          }
        } catch {
          // A narrower family beats a failed listing.
        }
      }
      if (members.length < 2) continue;
      const unique = [...new Set(members)];
      const labels = await titles(unique);
      const index = unique.indexOf(sessionId);
      const entry = {
        boundary: cut.boundary,
        index: index < 0 ? 0 : index,
        total: unique.length,
        members: unique.map((id) => ({ sessionId: id, title: labels.get(id) ?? null, current: id === sessionId })),
      };
      const { before, after } = surfaceMessagesAt(self.events, cut.boundary);
      for (const anchor of [before, after]) {
        if (anchor !== undefined) forks[anchor] = entry;
      }
    }
    return { sessionId, forks };
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
        if (method === 'GET' && path === '/branch') {
          const sessionId = url.searchParams.get('sessionId');
          if (sessionId === null || sessionId === '') return send(400, { error: 'sessionId is required' });
          return send(200, await branchState(sessionId));
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
      'dsh-session-branch: routes',
    );
  });

  ctx.effect(() => () => factsCache.clear(), 'dsh-session-branch: release cached facts');
}
