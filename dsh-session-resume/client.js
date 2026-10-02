/**
 * dsh-session-resume — browser half.
 *
 * Contributes two affordances to the resident composer:
 *
 * 1. A failure banner. When the Host parks a failed model request, the turn is
 *    still open and awaiting a decision, so the row offers Retry (re-run the
 *    exact same step over the exact same history) and Dismiss (let the failure
 *    settle as terminal).
 *
 * 2. A live send button on a stopped session. The shipped composer disables its
 *    primary button whenever the draft is empty, which is precisely the state a
 *    stopped session sits in. While the Host reports the session stopped with
 *    history, this half tags that button, restores its enabled appearance, and
 *    covers it with a same-geometry click target that asks the Host to resume —
 *    so the button the user already reaches for does the seamless thing instead
 *    of nothing.
 *
 * The click target is a `position: fixed` element on `document.body`, never a
 * child of React's composer tree, so no reconciliation of a managed container
 * is disturbed by a foreign node. A local error boundary keeps a failure inside
 * this entry from taking the composer down with it.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-resume',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-session-resume'
    const NS = 'dshSessionResume'

    /** Fast poll while a request may be in flight; slow poll while the session rests. */
    const POLL_ACTIVE_MS = 900
    const POLL_IDLE_MS = 2500
    /** Re-measure cadence for the overlaid click target, in milliseconds. */
    const MEASURE_MS = 400

    const CSS = `
.dshr-anchor{display:block;width:0;height:0;pointer-events:none}
.dshr-send-target{position:fixed;z-index:2147483000;margin:0;padding:0;border:0;background:transparent;border-radius:999px;cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag;transition:background-color .12s ease}
.dshr-send-target:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.dshr-send-target:active{background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.dshr-send-target:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-dshr-send]{opacity:1!important;cursor:pointer!important;pointer-events:none!important}
.dshr-banner{position:absolute;left:0;right:0;bottom:100%;margin-bottom:8px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:7px 10px 7px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.14);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;pointer-events:auto}
.dshr-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-error-primary)}
.dshr-copy{min-width:0;flex:auto;display:flex;flex-direction:column;gap:1px}
.dshr-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dshr-message{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshr-code{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);padding:1px 6px}
.dshr-action{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:1px solid transparent;font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dshr-action-primary{background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));color:#fff;font-weight:500}
.dshr-action-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary))}
.dshr-action-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.dshr-action-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshr-action:disabled{opacity:.5;cursor:default}
.dshr-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`

    const DICT = {
      zh: {
        'retry.title': '本轮运行失败',
        'retry.retry': '重试',
        'retry.dismiss': '放弃',
        'retry.pending': '重试中…',
        'retry.attempts': '已重试 {retry} 次',
        'retry.hint': '重试会在同一轮内原地重跑这一步，不新增任何消息',
        'resume.send': '恢复会话：继续上次未完成的工作',
        'resume.busy': '正在恢复会话…',
      },
      en: {
        'retry.title': 'This turn failed',
        'retry.retry': 'Retry',
        'retry.dismiss': 'Dismiss',
        'retry.pending': 'Retrying…',
        'retry.attempts': 'retried {retry}×',
        'retry.hint': 'Retry re-runs this step in the same turn and adds no message',
        'resume.send': 'Resume the session and continue the unfinished work',
        'resume.busy': 'Resuming…',
      },
    }

    /** Same-origin call into this plugin's own Host routes, with an abort guard. */
    async function api(path, options) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const response = await fetch(`${API}${path}`, { ...options, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    function post(path, sessionId) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: String(sessionId) }),
      })
    }

    /** Whether two Host state payloads are presentation-equivalent. */
    function sameState(left, right) {
      if (left === right) return true
      if (left === null || right === null) return false
      const pick = (state) => JSON.stringify([
        state.live, state.running, state.hasHistory, state.resumable,
        state.lastTurn?.reason ?? null,
        state.park === null || state.park === undefined ? null : [
          state.park.turn, state.park.step, state.park.provider,
          state.park.message, state.park.code ?? null, state.park.status ?? null,
          state.park.retry ?? null, state.park.expiresAt,
        ],
      ])
      return pick(left) === pick(right)
    }

    /**
     * Poll this plugin's own state route for one session.
     *
     * @returns {[object|null, () => void]} the latest state and a manual refresh.
     */
    function useHostState(sessionId) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (sessionId === undefined || sessionId === null) {
          setState(null)
          return undefined
        }
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          if (document.visibilityState === 'visible') {
            try {
              const next = await api(`/state?sessionId=${encodeURIComponent(String(sessionId))}`)
              if (alive) setState((previous) => (sameState(previous, next) ? previous : next))
            } catch {
              // A transient failure keeps the previous observation.
            }
          }
          if (alive) timer = setTimeout(tick, document.visibilityState === 'visible' ? POLL_ACTIVE_MS : POLL_IDLE_MS)
        }
        void tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId])
      const refresh = useCallback(() => {
        if (sessionId === undefined || sessionId === null) return
        void api(`/state?sessionId=${encodeURIComponent(String(sessionId))}`)
          .then((next) => setState((previous) => (sameState(previous, next) ? previous : next)))
          .catch(() => {})
      }, [sessionId])
      return [state, refresh]
    }

    /**
     * The composer's primary button: the card's last button in document order.
     *
     * The shipped composer renders tools, modes, the model seat and the activity
     * seat before the trailing stop/send button, so the last one is always the
     * primary action — and it is the one the user already reaches for.
     */
    function primaryButtonOf(card) {
      const buttons = card.querySelectorAll('button')
      return buttons.length === 0 ? null : buttons[buttons.length - 1]
    }

    /**
     * Keep one same-geometry click target over the composer's primary button.
     *
     * The button stays React-owned and untouched except for a marker attribute
     * that restores its enabled appearance; the target lives on `document.body`
     * with fixed geometry so React never sees a foreign child.
     */
    function useSendOverlay(anchorRef, active, onActivate, label) {
      const handler = useRef(onActivate)
      handler.current = onActivate
      useEffect(() => {
        if (!active) return undefined
        const anchor = anchorRef.current
        const card = anchor === null || anchor === undefined ? null : anchor.closest('[data-composer-card]')
        if (card === null) return undefined

        const target = document.createElement('button')
        target.type = 'button'
        target.className = 'dshr-send-target'
        target.setAttribute('data-dshr-send-target', '')
        target.setAttribute('aria-label', label)
        target.title = label
        // Hidden until the first measurement lands, so it never flashes at the origin.
        target.style.display = 'none'
        const activate = (event) => {
          event.preventDefault()
          event.stopPropagation()
          handler.current()
        }
        target.addEventListener('click', activate)
        document.body.appendChild(target)

        let tagged = null
        const place = () => {
          const button = primaryButtonOf(card)
          if (button !== tagged) {
            if (tagged !== null) tagged.removeAttribute('data-dshr-send')
            tagged = button
            if (tagged !== null) tagged.setAttribute('data-dshr-send', '')
          }
          if (tagged === null || !card.isConnected) {
            target.style.display = 'none'
            return
          }
          const rect = tagged.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) {
            target.style.display = 'none'
            return
          }
          target.style.display = 'block'
          target.style.left = `${rect.left}px`
          target.style.top = `${rect.top}px`
          target.style.width = `${rect.width}px`
          target.style.height = `${rect.height}px`
        }

        place()
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
        if (resize !== null) resize.observe(card)
        const observer = new MutationObserver(place)
        observer.observe(card, { childList: true, subtree: true })
        const interval = setInterval(place, MEASURE_MS)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          clearInterval(interval)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          resize?.disconnect()
          observer.disconnect()
          target.removeEventListener('click', activate)
          target.remove()
          if (tagged !== null) tagged.removeAttribute('data-dshr-send')
        }
      }, [active, anchorRef, label])
    }

    /**
     * Contain a failure inside this entry.
     *
     * A slot occupant that throws must not take the resident composer down with
     * it; an inert span is the safe degradation.
     */
    class ResumeBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /** The failure banner plus the send-button takeover. */
    function ResumeSurface(props) {
      const { useSession, useInput, sessionId, t } = props
      const anchorRef = useRef(null)
      const [state, refresh] = useHostState(sessionId)
      const running = useSession((s) => s?.running ?? false)
      const removed = useSession((s) => s?.removed ?? false)
      const input = useInput((s) => s)
      const [pending, setPending] = useState('')
      const [failure, setFailure] = useState(null)

      const draft = input?.draft ?? ''
      const attachmentCount = input?.attachmentIds?.length ?? 0
      const empty = draft.trim() === '' && attachmentCount === 0
      const park = state?.park ?? null
      const canResume = state !== null
        && state.live === true
        && state.hasHistory === true
        && state.resumable === true
        && park === null
        && !running
        && !removed
        && empty

      const resume = useCallback(() => {
        if (sessionId === undefined || sessionId === null) return
        setPending('resume')
        post('/resume', sessionId)
          .catch((error) => setFailure(String(error?.message ?? error)))
          .finally(() => {
            setPending('')
            refresh()
          })
      }, [sessionId, refresh])

      useSendOverlay(anchorRef, canResume && pending === '', resume, t('resume.send'))

      const act = useCallback((action) => {
        if (sessionId === undefined || sessionId === null) return
        setPending(action)
        post(`/${action}`, sessionId)
          .catch((error) => setFailure(String(error?.message ?? error)))
          .finally(() => {
            setPending('')
            refresh()
          })
      }, [sessionId, refresh])

      useEffect(() => {
        if (park === null) setFailure(null)
      }, [park])

      const anchor = h('span', { ref: anchorRef, className: 'dshr-anchor', 'aria-hidden': 'true' })
      if (park === null) return anchor

      const message = failure ?? park.message ?? ''
      return h(Fragment, null, anchor, h('div', {
        className: 'dshr-banner',
        role: 'status',
        'data-dshr-banner': '',
      }, [
        h('span', { key: 'dot', className: 'dshr-dot', 'aria-hidden': 'true' }),
        h('span', { key: 'copy', className: 'dshr-copy' }, [
          h('span', { key: 'title', className: 'dshr-title' }, t('retry.title')),
          h('span', { key: 'message', className: 'dshr-message', title: t('retry.hint') }, message),
        ]),
        Number.isFinite(park.retry) && park.retry > 0
          ? h('code', { key: 'attempts', className: 'dshr-code' }, t('retry.attempts', { retry: park.retry }))
          : null,
        park.code !== undefined && park.code !== ''
          ? h('code', { key: 'code', className: 'dshr-code' }, park.code)
          : null,
        h('button', {
          key: 'retry',
          type: 'button',
          className: 'dshr-action dshr-action-primary',
          disabled: pending !== '',
          onClick: () => act('retry'),
        }, pending === 'retry' ? t('retry.pending') : t('retry.retry')),
        h('button', {
          key: 'dismiss',
          type: 'button',
          className: 'dshr-action dshr-action-ghost',
          disabled: pending !== '',
          onClick: () => act('dismiss'),
        }, t('retry.dismiss')),
      ]))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-session-resume: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-resume')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-session-resume: styles')
        // The composer overlay seat floats inside the resident composer card,
        // which is exactly where a failed-request decision belongs.
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-session-resume',
          order: 20,
          label: () => t('retry.title'),
          locale: NS,
        }, (props) => h(ResumeBoundary, null, h(ResumeSurface, { ...props, t }))))
      },
    }
  },
})
