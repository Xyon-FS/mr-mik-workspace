import { Component, type ReactNode } from 'react'

export default class ReportBoundary extends Component<{ children: ReactNode; onHome: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <section className="desk-muted" role="alert"><h2>This report could not be opened.</h2><p>Your files are unchanged. Return to the workspace or reload to try again.</p><button onClick={this.props.onHome}>Back to Workspace</button> <button onClick={() => window.location.reload()}>Reload</button></section>
  }
}
