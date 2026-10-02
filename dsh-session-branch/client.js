/**
 * dsh-session-branch — browser half.
 *
 * Renders `< n / N >` next to the message action buttons in both places the
 * conversation shows them:
 *
 * - Assistant messages: the shipped `conversation.chat.assistant-actions` seat,
 *   which renders between Copy and Branch.
 * - User messages: the shipped user bubble takes no extra-actions seat, so those
 *   rows are reached through their stable `data-*` contract — the flow item
 *   carries the node key (the message id) and its action row carries
 *   `data-clock="start"`. A mutation observer re-adds the controls whenever React
 *   rebuilds a row, and each injected node is marked so it is never duplicated.
 *
 * Client services are resolved lazily AND declared through `ctx.inject`: this
 * plugin is `immediately`, so `apply` can run before `uiWorkspace` registers,
 * and a one-shot `ctx.get` at that moment would silently disable every click.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-branch',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-session-branch'
    const NS = 'dshSessionBranch'

    /** How long one `/branch` payload is reused, in milliseconds. */
    const CACHE_MS = 5000
    /** Background refresh cadence for the visible session's branch families. */
    const POLL_MS = 6000
    /** TEMPORARY diagnostic sink, readable back from Local Storage. */
    const DIAG_KEY = 'dshr:diag'

    const CSS = `
.dshr-row-actions{display:inline-flex;align-items:center;gap:4px}
.dshr-pager{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.dshr-pager-btn{width:20px;height:24px;border-radius:var(--dsw-radius-sm);color:inherit;cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0;font-size:14px;line-height:1;display:inline-flex}
.dshr-pager-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshr-pager-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshr-pager-count{padding:0 2px;white-space:nowrap}
.dshr-anchor{display:block;width:0;height:0;pointer-events:none}
`

    const DICT = {
      zh: {
        'branch.prev': '上一个分支',
        'branch.next': '下一个分支',
        'branch.label': '会话分支',
      },
      en: {
        'branch.prev': 'Previous branch',
        'branch.next': 'Next branch',
        'branch.label': 'Conversation branches',
      },
    }

    /** TEMPORARY: record one observation where it can be read back from disk. */
    function note(payload) {
      try {
        const raw = window.localStorage.getItem(DIAG_KEY)
        const list = raw === null ? [] : JSON.parse(raw)
        list.push({ at: new Date().toISOString(), from: 'branch', ...payload })
        while (list.length > 90) list.shift()
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(list))
      } catch {
        // Diagnostics never affect plugin behavior.
      }
    }

    /** The owning client context, kept for lazy service reads. */
    let pluginCtx
    /** Resolved once, then reused; `ctx.inject` fills it whenever it registers. */
    let workspaceServiceRef

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

    /**
     * The durable message id inside a chat flow key.
     *
     * `data-chat-flow-key` is the conversation node key — `<seq>:<kind><messageId>`
     * (e.g. `13:input-message6279209a-…`) — not the bare id the Host and the
     * assistant-actions seat use. Message ids are minted from `randomUUID()`, so
     * the trailing UUID is the identity to look up.
     */
    const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    function messageIdOf(flowKey) {
      const matches = String(flowKey).match(UUID_PATTERN)
      return matches === null || matches.length === 0 ? String(flowKey) : matches[matches.length - 1]
    }

    /** sessionId → { forks, at }, shared by every row renderer. */
    const branchCache = new Map()
    const branchPending = new Map()

    async function fetchBranches(sessionId, force) {
      const key = String(sessionId)
      const cached = branchCache.get(key)
      if (force !== true && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.forks
      const pending = branchPending.get(key)
      if (pending !== undefined) return pending
      const promise = (async () => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        try {
          const response = await fetch(`${API}/branch?sessionId=${encodeURIComponent(key)}`, { redirect: 'error', signal: ctrl.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          const forks = payload !== null && typeof payload === 'object' && payload.forks !== null && typeof payload.forks === 'object' ? payload.forks : {}
          branchCache.set(key, { forks, at: Date.now() })
          return forks
        } catch (error) {
          note({ point: 'branch-fetch-error', message: String(error?.message ?? error) })
          return cached === undefined ? {} : cached.forks
        } finally {
          clearTimeout(timer)
          branchPending.delete(key)
        }
      })()
      branchPending.set(key, promise)
      return promise
    }

    /** The branch families anchored in one session, refreshed periodically. */
    function useBranches(sessionId) {
      const [forks, setForks] = useState({})
      useEffect(() => {
        if (sessionId === undefined || sessionId === null) {
          setForks({})
          return undefined
        }
        let alive = true
        const sync = () => {
          void fetchBranches(sessionId).then((next) => {
            if (!alive) return
            setForks(next)
            reconcileBranches(next)
          })
        }
        sync()
        const timer = setInterval(sync, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])
      return forks
    }

    /** Open a sibling branch, or do nothing when it is already current. */
    function openBranch(member) {
      const service = workspaceService()
      note({
        point: 'branch-click',
        member: member === undefined ? null : String(member.sessionId ?? ''),
        current: member === undefined ? null : member.current === true,
        hasService: service !== undefined,
      })
      if (member === undefined || member.current === true || service === undefined) return
      const target = member.sessionId
      // An archived branch has to come back before it can be shown; the reconcile
      // that follows then archives the branch being left behind.
      void Promise.resolve()
        .then(() => service.unarchiveSession(target))
        .catch(() => {})
        .then(() => {
          archivedByUs.delete(target)
          try {
            service.openSession(target)
          } catch (error) {
            note({ point: 'branch-open-error', message: String(error?.message ?? error) })
          }
        })
    }

    /**
     * Sessions this plugin archived, so a family settles after one pass and a
     * branch brought back is archived again only once it stops being current.
     */
    const archivedByUs = new Set()

    /**
     * Keep only the current branch of every family visible.
     *
     * Every family the Host reports contains this session, so each member that
     * is not current is archived and the current one is brought back. The pass is
     * idempotent: a member already archived by this plugin is skipped, so the
     * sidebar is not rewritten on every refresh.
     */
    function reconcileBranches(forks) {
      const service = workspaceService()
      if (service === undefined) return
      const families = new Set()
      for (const entry of Object.values(forks)) {
        if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.members)) continue
        const key = `${entry.boundary}|${entry.total}|${entry.index}`
        if (families.has(key)) continue
        families.add(key)
        for (const member of entry.members) {
          const id = member === null || member === undefined ? undefined : member.sessionId
          if (id === undefined || id === null) continue
          if (member.current === true) {
            if (archivedByUs.delete(id)) {
              try {
                service.unarchiveSession(id)
              } catch {
                // A failed unarchive simply retries on the next reconcile.
              }
            }
            continue
          }
          if (archivedByUs.has(id)) continue
          archivedByUs.add(id)
          try {
            service.archiveSession(id)
          } catch {
            // A failed archive simply retries on the next reconcile.
          }
        }
      }
    }

    /** `‹ n / N ›` — this session's position among the branches cut at one point. */
    function BranchPager({ entry, t }) {
      const step = useCallback((delta) => {
        if (entry === undefined || entry.total < 2) return
        openBranch(entry.members[(entry.index + delta + entry.total) % entry.total])
      }, [entry])
      if (entry === undefined || entry.total < 2) return null
      const label = (member) => (member?.title === null || member?.title === undefined ? String(member?.sessionId ?? '') : member.title)
      const previous = entry.members[(entry.index - 1 + entry.total) % entry.total]
      const next = entry.members[(entry.index + 1) % entry.total]
      return h('span', { className: 'dshr-pager' }, [
        h('button', {
          key: 'prev',
          type: 'button',
          className: 'dshr-pager-btn',
          'aria-label': t('branch.prev'),
          title: `${t('branch.prev')} · ${label(previous)}`,
          onClick: () => step(-1),
        }, '‹'),
        h('span', {
          key: 'count',
          className: 'dshr-pager-count',
          title: entry.members.map(label).join('\n'),
        }, `${entry.index + 1} / ${entry.total}`),
        h('button', {
          key: 'next',
          type: 'button',
          className: 'dshr-pager-btn',
          'aria-label': t('branch.next'),
          title: `${t('branch.next')} · ${label(next)}`,
          onClick: () => step(1),
        }, '›'),
      ])
    }

    /**
     * Mirror the pager into every user message action row.
     *
     * The shipped user-message renderer exposes no extra-actions seat, so this
     * rides the durable `data-*` contract instead and re-syncs whenever React
     * rebuilds a row.
     */
    function useUserRowPagers({ sessionId, forks, t }) {
      const latest = useRef({ forks, t })
      latest.current = { forks, t }
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
            const entry = latest.current.forks[messageId]
            const want = entry !== undefined && entry.total > 1
            let host = actions.querySelector('[data-dshr-branch]')
            if (!want) {
              if (host !== null) host.remove()
              continue
            }
            const signature = `${entry.index}/${entry.total}`
            if (host === null) {
              host = document.createElement('span')
              host.className = 'dshr-row-actions'
              host.setAttribute('data-dshr-branch', '')
              actions.appendChild(host)
            }
            if (host.getAttribute('data-dshr-signature') === signature) {
              injected += 1
              continue
            }
            host.setAttribute('data-dshr-signature', signature)
            host.textContent = ''
            const translate = latest.current.t
            const build = (glyph, delta, label) => {
              const button = document.createElement('button')
              button.type = 'button'
              button.className = 'dshr-pager-btn'
              button.setAttribute('aria-label', label)
              button.title = label
              button.textContent = glyph
              button.addEventListener('click', () => {
                const live = latest.current.forks[messageId]
                if (live === undefined) return
                openBranch(live.members[(live.index + delta + live.total) % live.total])
              })
              return button
            }
            const count = document.createElement('span')
            count.className = 'dshr-pager-count'
            count.textContent = `${entry.index + 1} / ${entry.total}`
            host.appendChild(build('‹', -1, translate('branch.prev')))
            host.appendChild(count)
            host.appendChild(build('›', 1, translate('branch.next')))
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
              forkKeys: Object.keys(latest.current.forks),
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

    /** Contain a failure inside this entry so the composer and transcript survive. */
    class BranchBoundary extends React.Component {
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

    /** Zero-size composer seat whose only job is to run the user-row injector. */
    function UserRowPagerSeat({ sessionId, t }) {
      const forks = useBranches(sessionId)
      const anchor = useRef(null)
      useUserRowPagers({ sessionId, forks, t })
      return h('span', { ref: anchor, className: 'dshr-anchor', 'aria-hidden': 'true' })
    }

    /** One assistant message's pager, seated beside the branch button. */
    function AssistantBranchActions({ messageId, sessionId, t }) {
      const forks = useBranches(sessionId)
      return h(BranchPager, { entry: forks[messageId], t })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginCtx = ctx
        const t = ctx.locale.bind(NS)
        // Declared so the fiber waits for the service; the callback also fills the
        // cached reference whenever registration lands.
        ctx.effect(() => ctx.inject(['uiWorkspace'], (scoped) => {
          workspaceServiceRef = scoped.uiWorkspace
          note({ point: 'inject-uiWorkspace', ok: workspaceServiceRef !== undefined })
          return () => {
            workspaceServiceRef = undefined
          }
        }), 'dsh-session-branch: workspace service')
        note({
          point: 'apply',
          immediateGet: serviceOf('uiWorkspace') !== undefined,
          sessions: serviceOf('sessions') !== undefined,
        })
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-session-branch: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-branch')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-session-branch: styles')
        // The composer overlay seat is the per-session mount point for the
        // transcript injector; it renders nothing but a zero-size anchor.
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-session-branch',
          order: 30,
          label: () => t('branch.label'),
          locale: NS,
        }, (props) => h(BranchBoundary, null, h(UserRowPagerSeat, { ...props, t }))))
        // The shipped seat for extra actions on a finalized assistant message,
        // rendered between Copy and Branch.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'dsh-session-branch',
          order: 10,
          label: () => t('branch.label'),
          locale: NS,
        }, (props) => h(BranchBoundary, null, h(AssistantBranchActions, { ...props, t }))))
      },
    }
  },
})
