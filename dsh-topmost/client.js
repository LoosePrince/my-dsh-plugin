/**
 * dsh-topmost — browser half.
 *
 * Contributes one control: a caption-strip button in the frame-wide
 * `shell.overlay` layer, placed immediately left of the native minimize button.
 *
 * Placement contract: on Windows the desktop shell marks the document with
 * `data-windows-titlebar`, and the frame reserves `--dsh-windows-titlebar-height`
 * above every column for the caption strip, painted by the frame and overlaid by
 * the native controls at the right edge. The Host half reports how much room
 * those controls take (`captionInset`, three caption buttons wide), so the
 * button lands in the strip's remaining app-painted area and is exactly one
 * caption button wide. Everything here is plain React plus theme tokens; no
 * Harness Client package is imported.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-topmost',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-topmost'
    const NS = 'dshTopmost'
    /** Native caption button width at 100% scaling; only used before the Host answers. */
    const FALLBACK_INSET = 138
    /** Window's top strip: the frame's own contract, with the WCO probe and a plain default behind it. */
    const STRIP_HEIGHT = 'var(--dsh-windows-titlebar-height, env(titlebar-area-height, 40px))'

    const CSS = `
.dshtop-probe{position:absolute;top:0;left:env(titlebar-area-x,0px);width:env(titlebar-area-width,0px);height:0;visibility:hidden;pointer-events:none}
.dshtop-button{position:absolute;top:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;margin:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:default;font:inherit;-webkit-app-region:no-drag;user-select:none;transition:background-color .12s ease,color .12s ease}
.dshtop-button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.dshtop-button:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}
.dshtop-button[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dshtop-button[aria-pressed="true"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshtop-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshtop-button:disabled{color:var(--dsw-alias-state-idle-primary)}
.dshtop-glyph{display:block;pointer-events:none}
`

    const DICT = {
      zh: {
        label: '窗口置顶',
        turnOn: '让本窗口保持在其他窗口之上',
        turnOff: '取消置顶，本窗口恢复常规层级',
        pending: '正在切换窗口置顶…',
      },
      en: {
        label: 'Always on top',
        turnOn: 'Keep this window above other windows',
        turnOff: 'Stop keeping this window above other windows',
        pending: 'Switching always-on-top…',
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

    /**
     * The up-arrow-to-a-bar glyph: "pinned to the top". Stroke-only so the theme
     * color carries the state; the arrow thickens when the window is pinned.
     */
    function Glyph({ active }) {
      return h('svg', {
        className: 'dshtop-glyph',
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.8 : 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M3.4 2.6h9.2' }),
        h('path', { d: 'M8 13.4V6.3' }),
        h('path', { d: 'M5.4 8.9 8 6.3l2.6 2.6' }),
      )
    }

    /**
     * Resolve the room the native caption buttons take from the window's right
     * edge, in CSS pixels. The Window Controls Overlay probe answers first when
     * the shell exposes it; the Host's Win32 metrics answer otherwise.
     */
    function measureInset(probe, hostInset) {
      if (probe !== null) {
        const style = window.getComputedStyle(probe)
        const width = Number.parseFloat(style.width)
        const x = Number.parseFloat(style.left)
        if (Number.isFinite(width) && width > 0 && width < window.innerWidth - 20) {
          return Math.max(0, Math.round(window.innerWidth - (Number.isFinite(x) ? x : 0) - width))
        }
      }
      if (typeof hostInset === 'number' && Number.isFinite(hostInset) && hostInset > 0) return Math.round(hostInset)
      return FALLBACK_INSET
    }

    /** Does the document currently carry the desktop shell's Windows caption marker? */
    function hasCaptionStrip() {
      return document.documentElement.hasAttribute('data-windows-titlebar')
        && !document.documentElement.hasAttribute('data-fullscreen')
    }

    function CaptionToggle({ t }) {
      const [state, setState] = useState({ status: 'loading' })
      const [pending, setPending] = useState(false)
      const [strip, setStrip] = useState(hasCaptionStrip)
      const [inset, setInset] = useState(null)
      const probeRef = useRef(null)
      const hostInset = state.status === 'ready' ? state.data?.captionInset : undefined

      // Host truth: capability, current flag, caption metrics.
      useEffect(() => {
        let alive = true
        api('/state')
          .then((data) => { if (alive) setState({ status: 'ready', data }) })
          .catch((error) => { if (alive) setState({ status: 'error', error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, [])

      // The shell marks the caption strip on the document element, so follow it
      // (and the fullscreen flag that removes the strip) instead of sampling once.
      useEffect(() => {
        const root = document.documentElement
        const sync = () => setStrip(hasCaptionStrip())
        sync()
        const observer = new MutationObserver(sync)
        observer.observe(root, { attributes: true, attributeFilter: ['data-windows-titlebar', 'data-fullscreen'] })
        return () => observer.disconnect()
      }, [])

      const measure = useCallback(() => {
        setInset(measureInset(probeRef.current, hostInset))
      }, [hostInset])

      // Re-measure on layout changes: a move to a differently scaled monitor
      // changes both the caption metrics and the device pixel ratio.
      useEffect(() => {
        measure()
        let ratio = window.devicePixelRatio
        const onResize = () => {
          measure()
          if (window.devicePixelRatio !== ratio) {
            ratio = window.devicePixelRatio
            api('/state').then((data) => setState({ status: 'ready', data })).catch(() => {})
          }
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [measure])

      const supported = state.status === 'ready' && state.data?.supported === true
      const active = state.data?.alwaysOnTop === true

      const toggle = useCallback(() => {
        if (pending) return
        setPending(true)
        api('/toggle', { method: 'POST' })
          .then((data) => setState({ status: 'ready', data }))
          .catch(() => {})
          .finally(() => setPending(false))
      }, [pending])

      const probe = h('span', { ref: probeRef, className: 'dshtop-probe', 'aria-hidden': 'true' })
      if (supported !== true || strip !== true) return probe

      const width = Math.max(28, Math.round((inset ?? FALLBACK_INSET) / 3))
      const label = pending ? t('pending') : active ? t('turnOff') : t('turnOn')
      return h(Fragment, null, probe, h('button', {
        type: 'button',
        className: 'dshtop-button',
        style: { right: `${inset ?? FALLBACK_INSET}px`, width: `${width}px`, height: `calc(${STRIP_HEIGHT})` },
        'aria-pressed': active ? 'true' : 'false',
        'aria-label': t('label'),
        title: label,
        disabled: pending || undefined,
        onClick: toggle,
      }, h(Glyph, { active })))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-topmost: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-topmost')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-topmost: styles')
        // The frame-wide overlay layer is the only seat that spans the caption
        // strip; the entry opts itself into pointer events and out of the drag
        // region through its own class.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-topmost',
          order: 40,
          label: () => t('label'),
          locale: NS,
        }, (props) => h(CaptionToggle, { ...props, t })))
      },
    }
  },
})
