/** A failed panel must leave its neighbours and the dock entrance usable. */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { Translate } from './PanelCard.tsx'

interface Props {
  readonly children?: ReactNode
  readonly resetKey: unknown
  readonly t: Translate
  readonly dock?: boolean
  readonly title?: string
}

interface State { readonly error: string | null }

export class RenderBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    // React permits any thrown value, including null. An error fallback must
    // never throw while trying to read `.message` from the original failure.
    return { error: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown render error' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[dsh-pad] render failed:', this.props.title ?? 'dock', error, info.componentStack)
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    const fallback = (
      <section className="dshpad-recovery" role="alert">
        {this.props.title === undefined ? null : <strong>{this.props.title}</strong>}
        <span>{this.props.t('render.failed')}</span>
        <button type="button" onClick={() => {
          this.setState({ error: null })
        }}>{this.props.t('render.retry')}</button>
        <details><summary>{this.props.t('render.details')}</summary><pre>{this.state.error}</pre></details>
      </section>
    )
    return this.props.dock ? <div className="dshpad-root dshpad-recovery-root">{fallback}</div> : fallback
  }
}
