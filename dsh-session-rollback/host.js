/**
 * dsh-session-rollback — Host half.
 *
 * Records what a file held immediately before each mutation, so a past message
 * can be edited and the workspace put back to that moment.
 *
 * The pre-image needs no interception of its own: the shipped `write`, `edit`
 * and `str_replace_editor` tools already report `{ path, before, after }` in
 * their result, where `before` is the file's complete content just before the
 * change (and `null` when the tool created it). Listening to `tools/result`
 * therefore costs nothing and cannot delay dispatch.
 *
 * Bytes are stored under the Harness home — never inside the workspace — by the
 * SHA-1 of their content, beside an append-only index of
 * `{ seq, path, blob | existed: false }` records.
 *
 * Rolling back to a boundary takes, per path, the EARLIEST record after that
 * boundary: the content to restore, or a deletion when the file did not exist
 * then. Cordis refuses `ctx.<service>` on a fiber that has not declared the
 * dependency, so the agent registry is reached through `inject` with a
 * reflective `ctx.get` fallback.
 *
 * @module dsh-session-rollback
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Route prefix owned by this plugin; it outranks the kernel's `/api` by length. */
const ROUTE_PREFIX = '/api/dsh-session-rollback';

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** Where pre-images live: under the Harness home, never inside the workspace. */
const SNAPSHOT_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'session-rollback');

/** Largest pre-image retained per file; a bigger one is recorded as unrestorable. */
const MAX_PREIMAGE_BYTES = 4 * 1024 * 1024;

/** Tools whose result carries the `{ path, before }` pre-image. */
const PREIMAGE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** Append one pre-image record for a session, storing its bytes by content hash. */
function recordPreImage(sessionId, seq, filePath, before) {
  const dir = join(SNAPSHOT_ROOT, sessionId);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  let record;
  if (before === null) {
    record = { seq, path: filePath, existed: false };
  } else if (Buffer.byteLength(before, 'utf8') > MAX_PREIMAGE_BYTES) {
    record = { seq, path: filePath, existed: true, skipped: true };
  } else {
    const digest = createHash('sha1').update(before, 'utf8').digest('hex');
    const blob = join(dir, 'blobs', digest);
    if (!existsSync(blob)) writeFileSync(blob, before, 'utf8');
    record = { seq, path: filePath, existed: true, blob: digest };
  }
  writeFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' });
}

/** Read one session's pre-image index, tolerating a truncated tail. */
function readPreImages(sessionId) {
  const index = join(SNAPSHOT_ROOT, sessionId, 'index.jsonl');
  if (!existsSync(index)) return [];
  const out = [];
  for (const line of readFileSync(index, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const record = JSON.parse(line);
      if (record !== null && typeof record === 'object' && typeof record.path === 'string' && Number.isFinite(record.seq)) out.push(record);
    } catch {
      // A partial final line from an interrupted write is simply ignored.
    }
  }
  return out;
}

/**
 * Plan the workspace rollback to one boundary.
 *
 * @param {string} sessionId - the session whose log the records belong to.
 * @param {number} boundary - inclusive event seq to keep.
 * @returns {Array<{path: string, action: string, seq: number, blob?: string}>}
 */
function planRollback(sessionId, boundary) {
  const first = new Map();
  for (const record of readPreImages(sessionId)) {
    if (record.seq <= boundary) continue;
    const previous = first.get(record.path);
    if (previous === undefined || record.seq < previous.seq) first.set(record.path, record);
  }
  const plan = [];
  for (const [filePath, record] of first) {
    plan.push({
      path: filePath,
      action: record.skipped === true ? 'skipped' : record.existed === false ? 'delete' : 'restore',
      seq: record.seq,
      blob: record.blob,
    });
  }
  plan.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return plan;
}

/** Apply one rollback plan and report what actually changed. */
function applyRollback(sessionId, boundary) {
  const applied = [];
  for (const entry of planRollback(sessionId, boundary)) {
    try {
      if (entry.action === 'skipped') {
        applied.push({ path: entry.path, action: 'skipped' });
        continue;
      }
      if (entry.action === 'delete') {
        if (existsSync(entry.path)) unlinkSync(entry.path);
        applied.push({ path: entry.path, action: 'delete' });
        continue;
      }
      const blob = join(SNAPSHOT_ROOT, sessionId, 'blobs', entry.blob);
      if (!existsSync(blob)) {
        applied.push({ path: entry.path, action: 'missing-blob' });
        continue;
      }
      mkdirSync(dirname(entry.path), { recursive: true });
      writeFileSync(entry.path, readFileSync(blob));
      applied.push({ path: entry.path, action: 'restore' });
    } catch (error) {
      applied.push({ path: entry.path, action: 'failed', error: String(error?.message ?? error) });
    }
  }
  return applied;
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
 * Mount the pre-image recorder, the rollback routes, and their plumbing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's Host context.
 */
export function apply(ctx) {
  /** The agent registry, captured through the injected face. */
  let injectedAgents;
  ctx.effect(() => ctx.inject(['agents'], (scoped) => {
    injectedAgents = scoped.agents;
    return () => {
      injectedAgents = undefined;
    };
  }), 'dsh-session-rollback: agent registry');

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

  /** The live Session for one id, when the store is reachable. */
  function liveSession(sessionId) {
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      return sessions === undefined || sessions === null ? undefined : sessions.get(sessionId);
    } catch {
      return undefined;
    }
  }

  // A mutation's pre-image arrives with the tool result that recorded it, so the
  // recorder observes results rather than intercepting dispatch.
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    try {
      if (exec === undefined || result?.isError !== false) return;
      if (!PREIMAGE_TOOLS.has(exec.name)) return;
      const value = result.value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const rawPath = typeof value.path === 'string' && value.path !== '' ? value.path : undefined;
      if (rawPath === undefined) return;
      const before = typeof value.before === 'string' ? value.before : value.before === null ? null : undefined;
      if (before === undefined) return;
      const agent = exec.agent;
      if (agent === undefined || agent.session === undefined) return;
      const cwd = agent.session.header?.cwd;
      const absolute = isAbsolute(rawPath) ? rawPath : cwd === undefined ? rawPath : resolve(cwd, rawPath);
      recordPreImage(String(agent.id), Number(agent.session.seq ?? 0), absolute, before);
    } catch {
      // A snapshot failure must never affect a tool result.
    }
  }), 'dsh-session-rollback: file pre-images');

  /** One message's event seq and plain text, as recorded in the session log. */
  function findMessage(sessionId, messageId) {
    const live = liveSession(sessionId);
    const events = live === undefined ? undefined : live.snapshotEvents();
    if (events === undefined) return undefined;
    for (const event of events) {
      const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data?.message : undefined;
      if (message?.id !== messageId) continue;
      const parts = [];
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
      }
      return { seq: event.seq, text: parts.join('\n') };
    }
    return undefined;
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
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          if (sessionId === '') return send(400, { error: 'sessionId is required' });
          const found = findMessage(sessionId, typeof body.messageId === 'string' ? body.messageId : '');
          if (found === undefined) return send(409, { error: 'message-not-found' });
          const boundary = found.seq - 1;
          if (path === '/plan') {
            const files = planRollback(sessionId, boundary).map((entry) => ({ path: entry.path, action: entry.action }));
            return send(200, { boundary, text: found.text, files });
          }
          if (path === '/apply') {
            const childId = typeof body.childId === 'string' ? body.childId : '';
            if (childId === '') return send(400, { error: 'childId is required' });
            const applied = applyRollback(sessionId, boundary);
            const text = typeof body.text === 'string' ? body.text : '';
            let sent = false;
            const registry = agentRegistry();
            const child = registry === undefined ? undefined : registry.get(childId);
            if (child !== undefined && text.trim() !== '') {
              // The fork RPC already created the child's agent, so the edited text
              // enters it exactly like a composer send would.
              child.followup({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
              });
              sent = true;
            }
            return send(200, { ok: true, boundary, applied, sent });
          }
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
      'dsh-session-rollback: routes',
    );
  });
}
