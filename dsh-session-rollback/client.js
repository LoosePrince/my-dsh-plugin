/**
 * dsh-session-rollback — browser half.
 *
 * Puts an edit pencil beside the copy button of every user message. Clicking it
 * loads that message back into the EXISTING composer (the shipped input box is
 * the editor — no parallel editing surface), arms a rollback, and explains what
 * sending will do.
 *
 * Nothing happens until the user actually sends:
 *
 * - Cancelling the edit — the banner's button, or simply clearing the draft —
 *   disarms the rollback with the workspace untouched.
 * - Sending forks the session at that message, restores the recorded pre-images,
 *   hands the edited text to the new branch, and opens it.
 *
 * The shipped user bubble exposes no extra-actions seat, so the pencil rides the
 * durable `data-*` contract instead (the flow item carries the node key, its
 * action row carries `data-clock="start"`), and the send button is taken over
 * through a same-geometry click target on `document.body` so React's composer
 * tree is never touched.
 *
 * Client services are resolved lazily AND declared through `ctx.inject`: this
 * plugin is `immediately`, so `apply` can run before they register, and a
 * one-shot `ctx.get` at that moment would silently disable sending.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-rollback',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-session-rollback'
    const NS = 'dshSessionRollback'

    /** Re-measure cadence for the overlaid click target, in milliseconds. */
    const MEASURE_MS = 400
    /** TEMPORARY diagnostic sink, readable back from Local Storage. */
    const DIAG_KEY = 'dshr:diag'

    const CSS = `
.dshr-anchor{display:block;width:0;height:0;pointer-events:none}
.dshr-send-target{position:fixed;z-index:2147483000;margin:0;padding:0;border:0;background:transparent;border-radius:999px;cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag;transition:background-color .12s ease}
.dshr-send-target:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.dshr-send-target:active{background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.dshr-send-target:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-dshr-send]{opacity:1!important;cursor:pointer!important;pointer-events:none!important}
.dshr-banner{position:absolute;left:0;right:0;bottom:100%;margin-bottom:8px;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:7px 10px 7px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.14);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;pointer-events:auto}
.dshr-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.dshr-dot-error{background:var(--dsw-alias-state-error-primary)}
.dshr-copy{min-width:0;flex:auto;display:flex;flex-direction:column;gap:1px}
.dshr-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dshr-message{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshr-action{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:1px solid transparent;font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dshr-action-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.dshr-action-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshr-action:disabled{opacity:.5;cursor:default}
.dshr-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshr-row-actions{display:inline-flex;align-items:center;gap:4px}
.dshr-action-btn{width:24px;height:24px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0;font-size:13px;display:inline-flex}
.dshr-action-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshr-action-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`

    const DICT = {
      zh: {
        'rollback.edit': '编辑并回溯到这条消息',
        'rollback.title': '编辑回溯',
        'rollback.hint': '发送后将在该消息处新建分支，并把工作区恢复到当时的 {count} 个文件；取消编辑即取消回溯',
        'rollback.cancel': '取消',
        'rollback.send': '发送并回溯：分叉会话并恢复文件',
        'rollback.planning': '正在准备回溯…',
        'rollback.failed': '回溯准备失败',
      },
      en: {
        'rollback.edit': 'Edit and roll back to this message',
        'rollback.title': 'Edit rollback',
        'rollback.hint': 'Sending forks here and restores the workspace to this moment ({count} files); cancelling the edit cancels the rollback',
        'rollback.cancel': 'Cancel',
        'rollback.send': 'Send and roll back: fork the session and restore the files',
        'rollback.planning': 'Preparing the rollback…',
        'rollback.failed': 'Rollback could not be prepared',
      },
    }

    /** TEMPORARY: record one observation where it can be read back from disk. */
    function note(payload) {
      try {
        const raw = window.localStorage.getItem(DIAG_KEY)
        const list = raw === null ? [] : JSON.parse(raw)
        list.push({ at: new Date().toISOString(), from: 'rollback', ...payload })
        while (list.length > 90) list.shift()
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(list))
      } catch {
        // Diagnostics never affect plugin behavior.
      }
    }

    /**
     * The durable message id inside a chat flow key.
     *
     * `data-chat-flow-key` is the conversation node key — `<seq>:<kind><messageId>`
     * (e.g. `13:input-message6279209a-…`) — not the bare id the Host resolves. The
     * Host matches messages by their raw id, so the trailing UUID is what must be
     * sent; message ids are minted from `randomUUID()`.
     */
    const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    function messageIdOf(flowKey) {
      const matches = String(flowKey).match(UUID_PATTERN)
      return matches === null || matches.length === 0 ? String(flowKey) : matches[matches.length - 1]
    }

    /** The owning client context, kept for lazy service reads. */
    let pluginCtx
    /** Resolved once, then reused; `ctx.inject` fills each whenever it registers. */
    let workspaceServiceRef
    let sessionsServiceRef

    /** Resolve a client service without assuming it exists yet. */
    function serviceOf(name) {
      if (pluginCtx === undefined) return undefined
      try {
        return typeof pluginCtx.get === 'function' ? pluginCtx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    function workspaceService() {
      if (workspaceServiceRef !== undefined) return workspaceServiceRef
      const found = serviceOf('uiWorkspace')
      if (found !== undefined && found !== null) workspaceServiceRef = found
      return workspaceServiceRef
    }

    function sessionsService() {
      if (sessionsServiceRef !== undefined) return sessionsServiceRef
      const found = serviceOf('sessions')
      if (found !== undefined && found !== null && typeof found.fork === 'function') sessionsServiceRef = found
      return sessionsServiceRef
    }

    /** Same-origin call into this plugin's own Host routes, with an abort guard. */
    async function api(path, options) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
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

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    /** The composer's primary button: the card's last button in document order. */
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

    /** Intercept Enter while a rollback is armed, so sending runs it. */
    function useRollbackEnter(anchorRef, armed, onRun) {
      const handler = useRef(onRun)
      handler.current = onRun
      useEffect(() => {
        if (!armed) return undefined
        const anchor = anchorRef.current
        const card = anchor === null || anchor === undefined ? null : anchor.closest('[data-composer-card]')
        if (card === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
          if (event.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          handler.current()
        }
        card.addEventListener('keydown', onKeyDown, true)
        return () => card.removeEventListener('keydown', onKeyDown, true)
      }, [armed, anchorRef])
    }

    /**
     * Put the edit pencil beside the copy button of every user message.
     *
     * The shipped user-message renderer exposes no extra-actions seat, so this
     * rides the durable `data-*` contract and re-syncs whenever React rebuilds a
     * row; each injected node is marked so it is never duplicated.
     */
    function useUserRowPencils({ sessionId, onEdit, t }) {
      const latest = useRef({ onEdit, t })
      latest.current = { onEdit, t }
      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let stopped = false
        let reported = false
        const sync = () => {
          if (stopped) return
          const rows = document.querySelectorAll('[data-chat-flow-kind="user"]')
          let injected = 0
          for (const row of rows) {
            const flowKey = row.getAttribute('data-chat-flow-key')
            if (flowKey === null || flowKey === '') continue
            const messageId = messageIdOf(flowKey)
            const actions = row.querySelector('[data-clock="start"]')
            if (actions === null) continue
            if (actions.querySelector('[data-dshr-pencil]') !== null) {
              injected += 1
              continue
            }
            const host = document.createElement('span')
            host.className = 'dshr-row-actions'
            host.setAttribute('data-dshr-pencil', '')
            const pencil = document.createElement('button')
            pencil.type = 'button'
            pencil.className = 'dshr-action-btn'
            pencil.setAttribute('aria-label', latest.current.t('rollback.edit'))
            pencil.title = latest.current.t('rollback.edit')
            pencil.textContent = '✎'
            pencil.addEventListener('click', () => latest.current.onEdit(messageId))
            host.appendChild(pencil)
            actions.appendChild(host)
            injected += 1
          }
          if (!reported && rows.length > 0) {
            reported = true
            note({
              point: 'user-rows',
              rows: rows.length,
              injected,
              firstKey: rows[0] === undefined ? null : rows[0].getAttribute('data-chat-flow-key'),
              firstId: rows[0] === undefined ? null : messageIdOf(rows[0].getAttribute('data-chat-flow-key')),
            })
          }
        }
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(document.body, { childList: true, subtree: true })
        const timer = setInterval(sync, 1500)
        return () => {
          stopped = true
          clearInterval(timer)
          observer.disconnect()
        }
      }, [sessionId])
    }

    /** Contain a failure inside this entry so the composer survives. */
    class RollbackBoundary extends React.Component {
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

    /** The edit-rollback banner and the send-button takeover that runs it. */
    function RollbackSurface(props) {
      const { useInput, inputActions, sessionId, t } = props
      const anchorRef = useRef(null)
      const input = useInput((s) => s)
      const [armed, setArmed] = useState(null)
      const [pending, setPending] = useState('')
      const [failure, setFailure] = useState(null)
      /** When the rollback was armed; guards the clear-the-draft auto-cancel. */
      const armedAt = useRef(0)

      const draft = input?.draft ?? ''
      const armedActive = armed !== null && draft.trim() !== '' && pending === ''

      /** Load a past user message into the composer and arm the rollback. */
      const beginRollback = useCallback((messageId) => {
        if (sessionId === undefined || sessionId === null) return
        note({ point: 'pencil-click', messageId: String(messageId), sessionId: String(sessionId) })
        setPending('plan')
        setFailure(null)
        post('/plan', { sessionId: String(sessionId), messageId })
          .then((plan) => {
            note({ point: 'plan-ok', boundary: plan.boundary, files: Array.isArray(plan.files) ? plan.files.length : -1 })
            if (inputActions !== undefined) inputActions.setDraft(typeof plan.text === 'string' ? plan.text : '')
            armedAt.current = Date.now()
            setArmed({
              messageId,
              boundary: plan.boundary,
              files: Array.isArray(plan.files) ? plan.files : [],
            })
          })
          .catch((error) => {
            note({ point: 'plan-error', message: String(error?.message ?? error) })
            setFailure(String(error?.message ?? error))
          })
          .finally(() => setPending(''))
      }, [sessionId, inputActions])

      /** Fork at the message, roll the files back, and re-send the edited text. */
      const runRollback = useCallback(() => {
        const current = armed
        if (current === null || sessionId === undefined || sessionId === null) return
        const text = (input?.draft ?? '').trim()
        const service = sessionsService()
        note({ point: 'rollback-run', textLength: text.length, hasService: service !== undefined, boundary: current.boundary })
        if (text === '' || service === undefined) return
        setPending('rollback')
        service.fork({ sessionId, atSeq: current.boundary, increaseTitle: true })
          .then((childId) => {
            note({ point: 'fork-ok', childId: String(childId) })
            return post('/apply', { sessionId: String(sessionId), messageId: current.messageId, childId, text })
              .then((applied) => {
                note({ point: 'apply-ok', sent: applied?.sent, applied: Array.isArray(applied?.applied) ? applied.applied.length : -1 })
                if (inputActions !== undefined) inputActions.setDraft('')
                setArmed(null)
                const workspace = workspaceService()
                if (workspace !== undefined) workspace.openSession(childId)
              })
          })
          .catch((error) => {
            note({ point: 'rollback-error', message: String(error?.message ?? error) })
            setFailure(String(error?.message ?? error))
          })
          .finally(() => setPending(''))
      }, [armed, sessionId, input, inputActions])

      const cancelRollback = useCallback(() => {
        if (inputActions !== undefined) inputActions.setDraft('')
        setArmed(null)
        setFailure(null)
      }, [inputActions])

      useUserRowPencils({ sessionId, onEdit: beginRollback, t })
      useRollbackEnter(anchorRef, armedActive, runRollback)
      useSendOverlay(anchorRef, armedActive, runRollback, t('rollback.send'))

      // Clearing the edit box cancels the rollback, exactly as the banner says.
      // The grace window keeps the arm itself from tripping this before the draft
      // it just loaded has propagated through the input store.
      useEffect(() => {
        if (armed === null) return
        if (Date.now() - armedAt.current < 500) return
        if (draft.trim() === '') setArmed(null)
      }, [armed, draft])

      const anchor = h('span', { ref: anchorRef, className: 'dshr-anchor', 'aria-hidden': 'true' })
      // A failed plan is surfaced too, so a click never ends in silence.
      if (armed === null && failure === null) return anchor

      const body = pending === 'plan'
        ? t('rollback.planning')
        : failure !== null
          ? `${t('rollback.failed')}: ${failure}`
          : t('rollback.hint', { count: armed.files.length })
      return h(Fragment, null, anchor, h('div', {
        className: 'dshr-banner',
        role: 'status',
        'data-dshr-banner': 'rollback',
      }, [
        h('span', { key: 'dot', className: failure === null ? 'dshr-dot' : 'dshr-dot dshr-dot-error', 'aria-hidden': 'true' }),
        h('span', { key: 'copy', className: 'dshr-copy' }, [
          h('span', { key: 'title', className: 'dshr-title' }, t('rollback.title')),
          h('span', { key: 'message', className: 'dshr-message' }, body),
        ]),
        h('button', {
          key: 'cancel',
          type: 'button',
          className: 'dshr-action dshr-action-ghost',
          disabled: pending !== '',
          onClick: cancelRollback,
        }, t('rollback.cancel')),
      ]))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.inject(['uiWorkspace'], (scoped) => {
          workspaceServiceRef = scoped.uiWorkspace
          return () => {
            workspaceServiceRef = undefined
          }
        }), 'dsh-session-rollback: workspace service')
        ctx.effect(() => ctx.inject(['sessions'], (scoped) => {
          sessionsServiceRef = scoped.sessions
          return () => {
            sessionsServiceRef = undefined
          }
        }), 'dsh-session-rollback: sessions service')
        note({
          point: 'apply',
          immediateWorkspace: serviceOf('uiWorkspace') !== undefined,
          immediateSessions: serviceOf('sessions') !== undefined,
        })
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-session-rollback: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-rollback')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-session-rollback: styles')
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-session-rollback',
          order: 40,
          label: () => t('rollback.title'),
          locale: NS,
        }, (props) => h(RollbackBoundary, null, h(RollbackSurface, { ...props, t }))))
      },
    }
  },
})
