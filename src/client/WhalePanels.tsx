/** Whale Isle's sidebar uses the active Pad client, not a second installation. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PanelView } from '../shared/types.ts'
import { composer } from './composer.ts'
import { PanelCard, type PanelCardProps } from './PanelCard.tsx'
import type { PadClient } from './pad-client.ts'
import { RenderBoundary } from './RenderBoundary.tsx'
import { readTheme, watchTheme, type ThemeSnapshot } from './theme.ts'

export interface WhalePanelProps {
  requestAdd?: number
  active?: boolean
}

interface DisplayPrefs { hidden: string[]; order: string[] }
const DISPLAY_KEY = 'dsh-whale:pad-display'

function readDisplay(): DisplayPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? '{}') as Partial<DisplayPrefs> | null
    return {
      hidden: Array.isArray(saved?.hidden) ? saved.hidden : [],
      order: Array.isArray(saved?.order) ? saved.order : [],
    }
  } catch { return { hidden: [], order: [] } }
}

function SidebarCard(props: PanelCardProps) {
  const { client, view, clockActive } = props
  useEffect(() => {
    if (clockActive && !view.collapsed) return client.watchPanel(view.id, 'embedded')
  }, [client, clockActive, view.id, view.collapsed])
  return <RenderBoundary t={props.t} resetKey={view.version} title={view.definition.title}><PanelCard {...props} /></RenderBoundary>
}

export function createWhalePanels(client: PadClient) {
  return function WhalePanels({ t, requestAdd = 0, active = true }: WhalePanelProps & PropsLocale<'dsh-pad'>) {
    const snap = useSyncExternalStore(client.subscribe, client.getSnapshot)
    const [prefs, setPrefs] = useState(readDisplay)
    const [add, setAdd] = useState(false)
    const [prompt, setPrompt] = useState('')
    const [notice, setNotice] = useState<'whale.filled' | 'whale.unavailable'>()
    const [theme, setTheme] = useState<ThemeSnapshot>({ mode: 'light', css: ':root{}' })
    const root = useRef<HTMLDivElement>(null)
    const lang = t('dock.title') === '面板' ? 'zh-CN' : 'en'

    useEffect(() => { if (requestAdd) setAdd(true) }, [requestAdd])
    useEffect(() => {
      if (!active) return
      const update = () => {
        if (!root.current) return
        const next = readTheme(root.current)
        setTheme(previous => previous.css === next.css ? previous : next)
      }
      update()
      return watchTheme(update)
    }, [active])

    const orderIndex = new Map(prefs.order.map((id, index) => [id, index]))
    const visible = snap.panels.filter(panel => !prefs.hidden.includes(panel.id)).sort((a, b) =>
      (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity))
    const persist = (next: DisplayPrefs) => {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(next))
      setPrefs(next)
    }
    const move = (panel: PanelView, index: number, delta: number) => {
      const order = visible.map(view => view.id)
      const other = order[index + delta]
      if (other === undefined) return
      order[index + delta] = panel.id
      order[index] = other
      persist({ ...prefs, order })
    }
    const ask = (text: string): boolean => {
      const inserted = composer.insert(text) !== 'unavailable'
      setNotice(inserted ? 'whale.filled' : 'whale.unavailable')
      return inserted
    }
    const showAdd = () => { setNotice(undefined); setAdd(true) }
    const status = notice && <p className="dshpad-whale-notice" role="status">{t(notice)}</p>

    return <div className="dshpad-root dshpad-whale-panels" data-mode={theme.mode} ref={root}>
      {!snap.connected && <p className="dshpad-whale-notice" role="status">{t(snap.loaded ? 'dock.offline' : 'dock.connecting')}</p>}
      {!(add && active) && status}
      {visible.map((view, index) => <SidebarCard key={view.id} view={view} client={client} theme={theme}
        lang={lang} t={t} clockActive={active} fresh={snap.fresh === view.id} dragging={false} dropTarget={false}
        onAsk={ask} onExpand={() => client.setPanelHeight(view.id, client.panelHeight(view.id) ? undefined : 480)}
        sidebarActions={[
          { label: t('card.moveUp'), disabled: index === 0, run: () => move(view, index, -1) },
          { label: t('card.moveDown'), disabled: index === visible.length - 1, run: () => move(view, index, 1) },
          { label: t('whale.hide'), run: () => persist({ ...prefs, hidden: [...prefs.hidden, view.id] }) },
        ]} />)}
      {snap.loaded && visible.length === 0 && <div className="dshpad-whale-empty">
        <Button variant="outline" onClick={showAdd}>{t('whale.add')}</Button>
      </div>}
      <Modal open={add && active} title={t('whale.addTitle')} closeLabel={t('whale.close')} onClose={() => setAdd(false)}>
        <div className="dshpad-whale-add">
          {snap.panels.filter(view => prefs.hidden.includes(view.id)).map(view => <Button key={view.id} variant="outline"
            onClick={() => { persist({ ...prefs, hidden: prefs.hidden.filter(id => id !== view.id) }); setAdd(false) }}>
            {t('whale.restore', { title: view.definition.title })}
          </Button>)}
          <Input aria-label={t('whale.prompt')} placeholder={t('whale.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)} />
          <Button disabled={!prompt.trim()} onClick={() => {
            if (ask(t('new.prefix') + prompt.trim())) { setAdd(false); setPrompt('') }
          }}>{t('whale.draft')}</Button>
          {add && active && status}
        </div>
      </Modal>
    </div>
  }
}
