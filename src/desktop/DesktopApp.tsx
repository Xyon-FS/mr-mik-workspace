import { lazy, Suspense, useEffect } from 'react'
import App from '../App'
import { dismissError, sendEvent, startDesktop, surface, useDesktop, retryLocalConnection, reportError } from './client'
import FilesRail from './FilesRail'
import WorkspaceViews from './WorkspaceViews'
import MakDock from './MakDock'
import { Icon, Nose } from './Icons'
import './desktop.css'
import './projects.css'
import './theme.css'
import './workspace-controls.css'

const Chats = lazy(() => import('./Chats'))

export default function DesktopApp() {
  const state = useDesktop()
  useEffect(() => {
    document.documentElement.dataset.accentTheme = state.settings.accentTheme || 'rose'
  }, [state.settings.accentTheme])
  useEffect(() => {
    if (surface !== 'workspace') return
    const route = () => sendEvent({ type: 'workspace-route', route: location.hash })
    window.addEventListener('hashchange', route)
    return () => window.removeEventListener('hashchange', route)
  }, [])
  if (!state.ready) return <div className="desktop-boot"><Nose size={70} /><h1>Mr. Mik</h1><p>{state.error || 'Opening your workspace…'}</p>{state.error && <button className="desk-secondary" onClick={() => startDesktop()}>Reconnect</button>}</div>
  return <div className={`desktop-root ${surface}-root`}>
    {surface === 'chats' ? <Suspense fallback={<div className="desktop-boot"><Nose size={50} /></div>}><Chats /></Suspense> : <><div className="workspace-surface"><WorkspaceViews><div className="project-app"><App /></div><MakDock /></WorkspaceViews></div><FilesRail /></>}
    {state.error && <div className="desktop-error" role="alert"><span>{state.error}</span><button onClick={dismissError} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
    {!state.connected && <div className="desktop-offline" role="status">Connection to the local Mr. Mik service was lost. Reconnecting… <button onClick={() => void retryLocalConnection().catch(reportError)}>Retry connection</button></div>}
  </div>
}
