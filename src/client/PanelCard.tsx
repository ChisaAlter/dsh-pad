/** One panel in the dock: header with status and actions, approval prompt, the frame. */
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import type { PanelModelCatalog, PanelModelOption, PanelModelSelection, PanelView, SourceReading } from '../shared/types.ts'
import type { PadKey } from './locales.ts'
import type { DropZone } from './layout.ts'
import type { HistoryPoint, PadClient } from './pad-client.ts'
import { PanelFrame } from './PanelFrame.tsx'
import type { ThemeSnapshot } from './theme.ts'

export type Translate = (key: PadKey, params?: Record<string, string | number>) => string

export function relativeTime(t: Translate, iso: string | undefined, now: number): string {
  if (iso === undefined) return '—'
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 5) return t('time.justNow')
  if (seconds < 60) return t('time.seconds', { n: seconds })
  if (seconds < 3600) return t('time.minutes', { n: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('time.hours', { n: Math.floor(seconds / 3600) })
  return t('time.days', { n: Math.floor(seconds / 86_400) })
}

function every(t: Translate, minutes: number): string {
  if (minutes % 1440 === 0) return t('every.days', { n: minutes / 1440 })
  if (minutes % 60 === 0) return t('every.hours', { n: minutes / 60 })
  return t('every.minutes', { n: minutes })
}

function clock(iso: string | undefined): string {
  if (iso === undefined) return '—'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Latest reading time across the panel's data. */
function lastUpdate(view: PanelView): string | undefined {
  const times = Object.values(view.data.sources).map((r: SourceReading) => r.at)
  if (view.data.agent !== null) times.push(view.data.agent.at)
  return times.sort().at(-1)
}

/** Whether the card has something the user should look at. */
export function needsAttention(view: PanelView): boolean {
  return view.needsApproval
    || view.agentRun?.status === 'failed'
    || Object.values(view.data.sources).some(r => !r.ok)
}

const Icon = {
  refresh: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>,
  chevron: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6l3.5 3.5L11.5 6" /></svg>,
  grip: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.2" cy="3.6" r="1.1" /><circle cx="10.8" cy="3.6" r="1.1" /><circle cx="5.2" cy="8" r="1.1" /><circle cx="10.8" cy="8" r="1.1" /><circle cx="5.2" cy="12.4" r="1.1" /><circle cx="10.8" cy="12.4" r="1.1" /></svg>,
  more: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></svg>,
  expand: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" /></svg>,
}

/** Icons for the ⋯ menu rows. */
const MenuIcon = {
  edit: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.6l2.8 2.8L5.4 13.4H2.6v-2.8l8-8z" /></svg>,
  refresh: Icon.refresh,
  undo: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 6.6h6.2a3.6 3.6 0 0 1 0 7.2H6" /><path d="M5.8 4L3.2 6.6l2.6 2.6" /></svg>,
  up: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.4M4.2 7.2L8 3.4l3.8 3.8" /></svg>,
  down: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.6M4.2 8.8L8 12.6l3.8-3.8" /></svg>,
  model: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.2h10M3 10.8h10" /><circle cx="6.2" cy="5.2" r="1.5" /><circle cx="9.8" cy="10.8" r="1.5" /></svg>,
  span: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="7" height="10" rx="1" /><rect x="11" y="3" width="3" height="10" rx="1" /></svg>,
  trash: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6h10M6.4 4.6V2.9h3.2v1.7M4.9 4.6l.5 8.5h5.2l.5-8.5" /></svg>,
}

export interface PanelCardProps {
  readonly view: PanelView
  readonly client: PadClient
  readonly theme: ThemeSnapshot
  readonly lang: string
  readonly t: Translate
  readonly now: number
  readonly fresh: boolean
  readonly dragging: boolean
  readonly dropTarget: boolean
  /** Which part of this card a dragged card would split or swap into. */
  readonly dropZone?: DropZone
  readonly onAsk: (text: string, submit: boolean) => void
  readonly onExpand: () => void
  readonly onDragStart: (event: ReactPointerEvent<HTMLElement>) => void
}

export function PanelCard({ view, client, theme, lang, t, now, fresh, dragging, dropTarget, dropZone, onAsk, onExpand, onDragStart }: PanelCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [catalog, setCatalog] = useState<PanelModelCatalog>()
  const [modelError, setModelError] = useState<string>()
  const [modelBusy, setModelBusy] = useState(false)
  const [scriptError, setScriptError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [folded, setFolded] = useState(view.collapsed)
  const menuRef = useRef<HTMLDivElement>(null)
  const { definition } = view

  useEffect(() => {
    setFolded(view.collapsed)
  }, [view.collapsed])

  useEffect(() => {
    if (!confirmDelete && !modelOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setConfirmDelete(false)
        setModelOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmDelete, modelOpen])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', close, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', close, true)
    }
  }, [menuOpen])

  const act = async (action: Parameters<PadClient['act']>[0]): Promise<void> => {
    setMenuOpen(false)
    const result = await client.act(action)
    setActionError(result.ok ? undefined : result.error)
  }

  const sourceErrors = definition.sources
    .map(source => [source.id, view.data.sources[source.id]] as const)
    .filter(([, reading]) => reading !== undefined && !reading.ok)
    .map(([id, reading]) => t('card.sourceError', { id, error: reading!.error ?? '' }))
  const updated = lastUpdate(view)
  const agent = definition.agent
  const run = view.agentRun
  const refreshing = run?.status === 'running'
  const currentModel = definition.model
  const findModel = (selection: PanelModelSelection | undefined): PanelModelOption | undefined => {
    if (selection === undefined) return undefined
    for (const provider of catalog?.providers ?? []) {
      if (provider.id !== selection.provider) continue
      return provider.models.find(model => model.id === selection.model)
    }
    return undefined
  }
  const modelLabel = currentModel === undefined
    ? t('card.modelDefault')
    : findModel(currentModel)?.name ?? `${currentModel.provider}/${currentModel.model}`
  const defaultModel = catalog?.default === null || catalog?.default === undefined ? undefined : findModel(catalog.default)
  const openModels = (): void => {
    setModelError(undefined)
    setModelOpen(true)
    if (catalog !== undefined) return
    void client.models()
      .then(setCatalog)
      .catch(error => setModelError(t('card.modelLoadFailed', { error: error instanceof Error ? error.message : String(error) })))
  }
  const chooseModel = async (selection: PanelModelSelection | null): Promise<void> => {
    if (modelBusy) return
    setModelBusy(true)
    setModelError(undefined)
    const result = await client.act({ op: 'model', panelId: view.id, model: selection })
    setModelBusy(false)
    if (result.ok) setModelOpen(false)
    else setModelError(result.error ?? t('card.modelSwitchFailed'))
  }

  const toggleFold = (): void => {
    const next = !folded
    setFolded(next)
    setActionError(undefined)
    void client.act({ op: 'collapse', panelId: view.id, collapsed: next }).then(result => {
      if (!result.ok) {
        setFolded(!next)
        setActionError(result.error)
      }
    })
  }

  let meta: string
  if (refreshing) meta = t('card.agentRunning')
  else if (updated !== undefined) meta = t('card.updated', { ago: relativeTime(t, updated, now) })
  else meta = t('card.waiting')

  const startHeaderDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    // The title, menu and expand controls are buttons; pressing them must not
    // turn a slightly shaky click into a card drag.
    if (target.closest('button') !== null) return
    if (target.closest('.dshpad-card-actions') !== null) return
    if (target.closest('.dshpad-expand') !== null) return
    onDragStart(event)
  }

  return (
    <article className={`dshpad-card${fresh ? ' is-fresh' : ''}${folded ? ' is-folded' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}${dropZone === undefined ? '' : ` is-drop-${dropZone}`}`}
      aria-label={definition.title} data-panel-id={view.id}>
      <header className="dshpad-card-head" onPointerDown={startHeaderDrag}>
        <span className="dshpad-card-grip" title={t('card.drag')} aria-label={t('card.drag')} role="button" tabIndex={-1}>
          {Icon.grip}
        </span>
        <div className="dshpad-card-actions" ref={menuRef}>
          <button type="button" className="dshpad-more" title={t('card.more')} aria-label={t('card.more')}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(open => !open); setConfirmDelete(false) }}>
            {Icon.more}
          </button>
          {menuOpen
            ? (
              <div className="dshpad-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAsk(t('card.editPrompt', { title: definition.title, id: view.id }), false) }}>
                  <span className="dshpad-mi">{MenuIcon.edit}</span>{t('card.edit')}
                </button>
                <button type="button" role="menuitem" disabled={view.needsApproval && !agent}
                  onClick={() => void act({ op: 'refresh', panelId: view.id })}>
                  <span className="dshpad-mi">{MenuIcon.refresh}</span>{t('card.refresh')}
                </button>
                <button type="button" role="menuitem" disabled={!view.canUndo} onClick={() => void act({ op: 'undo', panelId: view.id })}>
                  <span className="dshpad-mi">{MenuIcon.undo}</span>{t('card.undo')}
                </button>
                <hr />
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openModels() }}>
                  <span className="dshpad-mi">{MenuIcon.model}</span>
                  <span>{t('card.model')}</span>
                  <span className="dshpad-menu-value">{modelLabel}</span>
                </button>
                <hr />
                <button type="button" role="menuitem" className="is-danger" onClick={() => {
                  setMenuOpen(false)
                  setConfirmDelete(true)
                }}>
                  <span className="dshpad-mi">{MenuIcon.trash}</span>{t('card.delete')}
                </button>
              </div>
              )
            : null}
        </div>
        <button
          type="button"
          className="dshpad-card-title"
          aria-expanded={!folded}
          title={folded ? t('card.unfold') : t('card.fold')}
          onClick={toggleFold}
        >
          <span className="dshpad-card-chevron">{Icon.chevron}</span>
          {definition.icon ? <span className="dshpad-card-icon">{definition.icon}</span> : null}
          <span className="dshpad-card-name">{definition.title}</span>
        </button>
        <span className={`dshpad-card-meta${needsAttention(view) ? ' is-alert' : ''}`}>{meta}</span>
        <button type="button" className="dshpad-icon-btn dshpad-expand" title={t('card.expand')} aria-label={t('card.expand')}
          onClick={onExpand}>
          {Icon.expand}
        </button>
      </header>

      {confirmDelete
        ? (
          <div className="dshpad-confirm" role="alertdialog" aria-label={t('card.deleteConfirm', { title: definition.title })}>
            <p className="dshpad-confirm-text">{t('card.deleteConfirm', { title: definition.title })}</p>
            <p className="dshpad-confirm-hint">{t('card.deleteCannotUndo')}</p>
            <div className="dshpad-confirm-actions">
              <button type="button" className="dshpad-confirm-cancel" autoFocus onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
              <button type="button" className="dshpad-confirm-delete" onClick={() => {
                setConfirmDelete(false)
                void act({ op: 'delete', panelId: view.id })
              }}>{t('card.deleteAction')}</button>
            </div>
          </div>
          )
        : null}

      {modelOpen
        ? (
          <div className="dshpad-models" role="dialog" aria-label={t('card.model')}>
            <div className="dshpad-models-head">
              <span>{t('card.model')}</span>
              <button type="button" className="dshpad-models-close" aria-label={t('common.close')} title={t('common.close')}
                onClick={() => setModelOpen(false)}>×</button>
            </div>
            {modelError ? <p className="dshpad-models-error">{modelError}</p> : null}
            {catalog === undefined && modelError === undefined ? <p className="dshpad-models-hint">{t('card.modelLoading')}</p> : null}
            {catalog !== undefined
              ? (
                <div className="dshpad-models-list">
                  <button type="button" className={`dshpad-model-row${currentModel === undefined ? ' is-current' : ''}`}
                    disabled={modelBusy} onClick={() => void chooseModel(null)}>
                    <span className="dshpad-model-name">{t('card.modelDefault')}</span>
                    <span className="dshpad-model-meta">
                      {defaultModel?.name ?? (catalog.default === null ? t('card.modelFollowDefault') : `${catalog.default.provider}/${catalog.default.model}`)}
                    </span>
                    {currentModel === undefined ? <span className="dshpad-model-check">✓</span> : null}
                  </button>
                  {catalog.providers.map(provider => (
                    <div key={provider.id} className="dshpad-model-group">
                      <p className="dshpad-model-provider">{provider.name}</p>
                      {provider.models.map(model => {
                        const selected = currentModel?.provider === provider.id && currentModel.model === model.id
                        return (
                          <button key={model.id} type="button" className={`dshpad-model-row${selected ? ' is-current' : ''}`} disabled={modelBusy}
                            onClick={() => void chooseModel({
                              provider: provider.id,
                              model: model.id,
                              ...(model.defaultReasoningEffort === undefined ? {} : { reasoningEffort: model.defaultReasoningEffort }),
                            })}>
                            <span className="dshpad-model-name">{model.name}</span>
                            {model.description ? <span className="dshpad-model-meta">{model.description}</span> : null}
                            {selected ? <span className="dshpad-model-check">✓</span> : null}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {catalog.providers.length === 0 ? <p className="dshpad-models-hint">{t('card.modelEmpty')}</p> : null}
                </div>
                )
              : null}
          </div>
          )
        : null}

      {folded
        ? null
        : (
          <div className="dshpad-card-body">
            {view.needsApproval
              ? (
                <div className="dshpad-approve">
                  <p>{t('approve.title')}</p>
                  <ul>
                    {definition.sources.map(source => (
                      <li key={source.id}>
                        <code>{source.kind === 'command' ? source.command : `${source.method ?? 'GET'} ${source.url}`}</code>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="dshpad-primary" onClick={async () => {
                    const result = await client.act({ op: 'approve', panelId: view.id, fingerprint: view.fingerprint })
                    setActionError(result.ok ? undefined : t('approve.changed'))
                  }}>{t('approve.allow')}</button>
                </div>
                )
              : null}
            <PanelFrame
              view={view}
              histories={() => client.historiesOf(view.id) as Record<string, readonly HistoryPoint[]>}
              theme={theme}
              lang={lang}
              onRefresh={() => void client.act({ op: 'refresh', panelId: view.id })}
              onAsk={text => onAsk(text, false)}
              onRun={(prompt, system) => client.run(view.id, prompt, system)}
              onScriptError={setScriptError}
              height={client.panelHeight(view.id)}
              onHeightChange={next => client.setPanelHeight(view.id, next)}
              resizeLabel={t('card.resize')}
            />
            {agent
              ? (
                <p className={`dshpad-card-note${run?.status === 'failed' ? ' is-alert' : ''}`}>
                  {run?.status === 'failed' && run.error
                    ? t('card.agentFailed', { error: run.error })
                    : `${t('card.agentEvery', { every: every(t, agent.everyMinutes) })} · ${t('card.agentNext', { time: clock(run?.nextRunAt) })}`}
                </p>
                )
              : null}
            {[...sourceErrors, ...(scriptError ? [scriptError.split('\n')[0]!] : []), ...(actionError ? [actionError] : [])]
              .map(line => <p key={line} className="dshpad-card-note is-alert">{line}</p>)}
          </div>
          )}
    </article>
  )
}
