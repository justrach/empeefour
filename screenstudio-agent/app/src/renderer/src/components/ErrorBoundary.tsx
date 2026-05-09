// Visible error boundary — without this, a render-time throw in Timeline /
// DebugPage blanks the whole app and you can't see why.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info)
    this.setState({ error, info })
  }

  reset = (): void => {
    this.setState({ error: null, info: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-neutral-50 p-8">
          <div className="mx-auto max-w-3xl rounded-xl border border-red-300 bg-white p-6">
            <h2 className="mb-2 text-lg font-bold text-red-600">Renderer crashed</h2>
            <p className="mb-3 text-sm text-muted">{this.state.error.message}</p>
            <pre className="max-h-[400px] overflow-auto rounded bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700">
              {this.state.error.stack}
            </pre>
            {this.state.info && (
              <pre className="mt-3 max-h-[400px] overflow-auto rounded bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700">
                {this.state.info.componentStack}
              </pre>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={this.reset}
                className="h-8 rounded-md bg-blue px-3 text-[13px] font-semibold text-white hover:opacity-90"
              >
                Try again
              </button>
              <a
                href="#/"
                onClick={this.reset}
                className="flex h-8 items-center rounded-md border border-line px-3 text-[13px] font-semibold hover:bg-soft"
              >
                Back to home
              </a>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
