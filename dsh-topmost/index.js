/**
 * dsh-topmost — Host half.
 *
 * Owns one capability: flipping the dsh desktop window's always-on-top flag, plus
 * the geometry the Client half needs to sit immediately left of the native
 * minimize button.
 *
 * Why Win32 instead of Electron: the BrowserWindow belongs to the Electron main
 * process, while this plugin runs in the Host child process the desktop shell
 * spawns (`dsh-desktop-host`). The shell's IPC carries no verb for window state,
 * so the child reaches the same window through `user32`: it resolves the shell's
 * top-level window by the parent process id and flips `WS_EX_TOPMOST` with
 * `SetWindowPos`. The same binding reports the caption-button metrics so the
 * Client can place its control without guessing at DPI scaling.
 *
 * @module dsh-topmost
 */
import { createRequire } from 'node:module';

/** Route prefix owned by this plugin; it outranks the kernel's `/api` by length. */
const ROUTE_PREFIX = '/api/dsh-topmost';

/** Product-title suffix used as the fallback window match when the pid match misses. */
const PRODUCT_TITLE = 'DeepSeek Harness';

/** Caption buttons drawn by Windows in the overlay: minimize, maximize, close. */
const CAPTION_BUTTONS = 3;

// ── Win32 constants ───────────────────────────────────────────────────────────
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CAPTION = 0x00c00000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TOPMOST = 0x00000008;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SM_CXSIZE = 30;
const SM_CXPADDEDBORDER = 92;

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/**
 * Resolve `koffi` from the Host process's own module graph.
 *
 * The plugin is installed in the profile, so `koffi` is not reachable from its
 * own directory; it is reachable from the process entry (`dsh-desktop-host` and
 * the Windows sandbox packages depend on it). Resolving from `process.argv[1]`
 * keeps the plugin free of a vendored native module and of a registry install.
 *
 * @returns {object|undefined} the loaded koffi binding, or undefined when unavailable.
 */
function loadKoffi() {
  const bases = [];
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') bases.push(process.argv[1]);
  bases.push(import.meta.url);
  for (const base of bases) {
    try {
      return createRequire(base)('koffi');
    } catch {
      // Try the next resolution base.
    }
  }
  return undefined;
}

/**
 * Build the `user32` binding this plugin needs.
 *
 * @param {object} koffi - the loaded koffi binding.
 * @returns {object} the narrow Win32 surface used by the control.
 */
function createWin32(koffi) {
  const user32 = koffi.load('user32.dll');
  const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', ['void *', 'intptr']);
  const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', 'void *']);
  const IsWindow = user32.func('__stdcall', 'IsWindow', 'int', ['void *']);
  const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *']);
  const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'int', ['void *', 'int']);
  const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']);
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', 'void *']);
  const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int', ['void *', 'void *', 'int', 'int', 'int', 'int', 'uint32']);
  const GetDpiForWindow = user32.func('__stdcall', 'GetDpiForWindow', 'uint32', ['void *']);
  const GetSystemMetricsForDpi = user32.func('__stdcall', 'GetSystemMetricsForDpi', 'int', ['int', 'uint32']);
  const protoEnumProc = koffi.proto('int __stdcall DshTopmostEnumProc(void *hwnd, intptr lparam)');

  /**
   * Every visible top-level window that could be the application window.
   *
   * @returns {Array<{hwnd: bigint, pid: number, title: string, area: number}>}
   */
  function listCandidates() {
    const found = [];
    const pidBuf = Buffer.alloc(4);
    const titleBuf = Buffer.alloc(1024);
    const rectBuf = Buffer.alloc(16);
    const callback = koffi.register((hwnd) => {
      if (IsWindowVisible(hwnd) === 0) return 1;
      const style = GetWindowLongW(hwnd, GWL_STYLE);
      const extended = GetWindowLongW(hwnd, GWL_EXSTYLE);
      if ((style & WS_CAPTION) !== WS_CAPTION) return 1;
      if ((extended & WS_EX_TOOLWINDOW) !== 0) return 1;
      if (GetWindowRect(hwnd, rectBuf) === 0) return 1;
      const width = rectBuf.readInt32LE(8) - rectBuf.readInt32LE(0);
      const height = rectBuf.readInt32LE(12) - rectBuf.readInt32LE(4);
      if (width < 320 || height < 240) return 1;
      GetWindowThreadProcessId(hwnd, pidBuf);
      const length = GetWindowTextW(hwnd, titleBuf, 1024);
      found.push({
        hwnd,
        pid: pidBuf.readUInt32LE(0),
        title: titleBuf.slice(0, length * 2).toString('utf16le'),
        area: width * height,
      });
      return 1;
    }, koffi.pointer(protoEnumProc));
    try {
      EnumWindows(callback, 0);
    } finally {
      koffi.unregister(callback);
    }
    return found;
  }

  return {
    /** Is this handle still a live window? */
    isWindow(hwnd) {
      try {
        return IsWindow(hwnd) !== 0;
      } catch {
        return false;
      }
    },
    /**
     * Resolve the application window: the largest visible captioned window owned
     * by the shell process, falling back to the product-title match when the
     * parent pid is not the window's owner (wrapped or re-parented launches).
     *
     * @param {number} parentPid - the desktop shell process expected to own the window.
     * @returns {{hwnd: bigint, pid: number, title: string, matched: string}|null}
     */
    findWindow(parentPid) {
      const candidates = listCandidates();
      const byPid = candidates.filter((candidate) => candidate.pid === parentPid);
      const pool = byPid.length > 0
        ? byPid
        : candidates.filter((candidate) => candidate.title.endsWith(PRODUCT_TITLE));
      if (pool.length === 0) return null;
      const best = pool.reduce((left, right) => (right.area > left.area ? right : left));
      return { hwnd: best.hwnd, pid: best.pid, title: best.title, matched: byPid.length > 0 ? 'parent-process' : 'product-title' };
    },
    /** Read the window's current always-on-top flag. */
    isTopmost(hwnd) {
      return (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0;
    },
    /** Write the window's always-on-top flag without moving, resizing or activating it. */
    setTopmost(hwnd, on) {
      const result = SetWindowPos(
        hwnd,
        on ? HWND_TOPMOST : HWND_NOTOPMOST,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
      );
      return result !== 0;
    },
    /**
     * Caption geometry for this window.
     *
     * Windows reserves `SM_CXSIZE + 2 * SM_CXPADDEDBORDER` physical pixels per
     * caption button, so the native controls occupy three of those from the
     * window's right edge. Reported in CSS pixels for the Client, which shares
     * the window's scale factor.
     */
    metrics(hwnd) {
      const dpi = GetDpiForWindow(hwnd) || 96;
      const buttonWidth = GetSystemMetricsForDpi(SM_CXSIZE, dpi);
      const paddedBorder = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
      const physical = CAPTION_BUTTONS * (buttonWidth + 2 * paddedBorder);
      return {
        dpi,
        scale: dpi / 96,
        captionInset: physical / (dpi / 96),
        captionInsetPhysical: physical,
      };
    },
  };
}

/**
 * The window-state control: resolves the window lazily, caches the handle and
 * re-resolves it when the window goes away.
 *
 * @returns {{state: () => Promise<object>, toggle: () => Promise<object>, dispose: () => void}}
 */
function createControl() {
  let binding = null;
  let unavailable = '';
  let target = null;

  function ensureBinding() {
    if (binding !== null || unavailable !== '') return;
    if (process.platform !== 'win32') {
      unavailable = 'unsupported-platform';
      return;
    }
    const koffi = loadKoffi();
    if (koffi === undefined) {
      unavailable = 'win32-binding-unavailable';
      return;
    }
    try {
      binding = createWin32(koffi);
    } catch (error) {
      unavailable = `win32-binding-failed: ${String(error?.message ?? error)}`;
    }
  }

  function resolveWindow() {
    if (target !== null && binding.isWindow(target.hwnd)) return target;
    target = null;
    const parentPid = typeof process.ppid === 'number' ? process.ppid : -1;
    target = binding.findWindow(parentPid);
    return target;
  }

  function snapshot() {
    ensureBinding();
    if (binding === null) return { supported: false, reason: unavailable, platform: process.platform };
    const window = resolveWindow();
    if (window === null) {
      return { supported: false, reason: 'window-not-found', platform: process.platform, parentPid: process.ppid };
    }
    const metrics = binding.metrics(window.hwnd);
    return {
      supported: true,
      platform: process.platform,
      alwaysOnTop: binding.isTopmost(window.hwnd),
      captionInset: Math.round(metrics.captionInset * 100) / 100,
      captionInsetPhysical: metrics.captionInsetPhysical,
      dpi: metrics.dpi,
      matched: window.matched,
      title: window.title,
    };
  }

  return {
    async state() {
      return snapshot();
    },
    async toggle() {
      const before = snapshot();
      if (before.supported !== true) return before;
      const window = resolveWindow();
      if (window === null) return { supported: false, reason: 'window-not-found', platform: process.platform };
      const next = !before.alwaysOnTop;
      const applied = binding.setTopmost(window.hwnd, next);
      const after = snapshot();
      if (applied !== true) return { ...after, supported: false, reason: 'set-window-pos-failed' };
      return after;
    },
    dispose() {
      target = null;
    },
  };
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
 * replica of the same fence (loopback Host, no cross-site fetch, matching
 * Origin/Referer authority).
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
 * The plugin's HTTP surface: `GET /state` and `POST /toggle`.
 *
 * @param {object} control - the window-state control.
 * @param {() => object|undefined} connection - reads the optional connection service.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createHandler(control, connection) {
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
      if (method === 'GET' && path === '/state') return send(200, await control.state());
      if (method === 'POST' && path === '/toggle') return send(200, await control.toggle());
      return send(404, { error: 'not-found' });
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * Mount the control and its routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's Host context.
 */
export function apply(ctx) {
  const control = createControl();
  ctx.effect(() => () => control.dispose(), 'dsh-topmost: win32 control');
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    scoped.effect(
      () => server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler(control, () => scoped.get('connection')),
      }),
      'dsh-topmost: routes',
    );
  });
}
