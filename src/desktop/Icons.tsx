import type { CSSProperties } from 'react'
import type { AgentId } from './types'
import MakLogo from '../components/MakLogo'

export function AgentLogo({ agent, size = 18 }: { agent: AgentId; size?: number }) {
  if (agent === 'opencode') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="agent-logo"><rect x="4" y="2" width="16" height="20" rx="2" /><path d="m10 8-4 4 4 4m4-8 4 4-4 4" /></svg>
  if (agent === 'claude') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="agent-logo">{Array.from({ length: 12 }, (_, index) => <path key={index} d={`M12 ${index % 2 ? 3 : 1.8}V9`} transform={`rotate(${index * 30} 12 12)`} />)}</svg>
  if (agent === 'codex') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" aria-hidden="true" className="agent-logo">{Array.from({ length: 6 }, (_, index) => <path key={index} d="M12 3.5c-3.7-2-7.7 1-6.5 5L12 12l5.5-3.2V5.9L12 3.5Z" transform={`rotate(${index * 60} 12 12)`} />)}</svg>
  if (agent === 'kimi') return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" aria-hidden="true" className="agent-logo"><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" fillOpacity=".12" strokeWidth="1" /><path d="M8 6v12M16 6l-7 6 7 6" /></svg>
  return <Icon name="terminal" size={size} />
}

export function Nose({ size = 30, tone = 'pink' }: { size?: number; tone?: 'pink' | 'black' }) {
  return <MakLogo size={size} tone={tone} />
}
export function Icon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  const paths: Record<string, string> = {
    palette: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10h-4ZM7 8h.01M11 6h.01M16 7h.01M6 13h.01',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    login: 'M15 3h5v18h-5M2 12h14m-5-5 5 5-5 5',
    logout: 'M9 3H4v18h5m-1-9h14m-5-5 5 5-5 5',
    chat: 'M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0ZM7 8h10M7 12h7',
    branch: 'M6 3v12a6 6 0 0 0 12 0V9M6 8h6a6 6 0 0 0 6-6M8 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
    down: 'M12 4v16m-6-6 6 6 6-6',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 5 4 13 0 18-4-5-4-13 0-18Z', lock: 'M5 11h14v10H5ZM8 11V7a4 4 0 0 1 8 0v4', link: 'm10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4m12 0 2-2a4 4 0 0 1 6 6l-4 4',
    unlink: 'm8 16-2 2a4 4 0 0 1-6-6l4-4m12 0 2-2a4 4 0 0 1 6 6l-4 4M3 3l18 18',
    code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
    shield: 'M12 3 3 7v6c0 4 5 7 9 9 4-2 9-5 9-9V7l-9-4Z',
    slash: 'M5 5l14 14',
    circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
    check: 'm5 12 4 4L19 6', question: 'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', edit: 'm16 3 5 5-13 13H3v-5L16 3ZM13 6l5 5', filter: 'M4 6h16M7 12h10M10 18h4',
    quote: 'M4 6h6v7H6v5H3v-6l1-6ZM15 6h6v7h-4v5h-3v-6l1-6Z',
    zoomIn: 'M15 15l6 6M17 9a8 8 0 1 1-16 0 8 8 0 0 1 16 0M9 5v8M5 9h8',
    zoomOut: 'M15 15l6 6M17 9a8 8 0 1 1-16 0 8 8 0 0 1 16 0M5 9h8',
    pan: 'M8 11V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 8-7 8-3 0-5-1-7-4l-3-5a2 2 0 0 1 3-2l2 2',
    browser: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c3 4 3 14 0 18-3-4-3-14 0-18Z',
    image: 'M3 3h18v18H3ZM7 8h.01M3 17l6-6 4 4 3-3 5 5',
    download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
    wrap: 'M3 6h18M3 11h14a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 16h4',
    account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2',
    layout: 'M3 3h5M3 3v5M3 3l6 6M21 3h-5M21 3v5M21 3l-6 6M3 21h5M3 21v-5M3 21l6-6M21 21h-5M21 21v-5M21 21l-6-6',
    archive: 'M3 3h18v5H3ZM5 8v13h14V8M9 12h6',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    fork: 'M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 7v10M18 7v3a3 3 0 0 1-3 3H6',
    mak: 'M4 4h16v12H9l-5 4ZM8 8h8M8 12h5',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 10v7M12 7h.01',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.1 8a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01',
    projects: 'M3 7V5h6l2 2h10v13H3ZM7 11h10M7 15h7', knowledge: 'M3 5h8a4 4 0 0 1 4 4v11H7a4 4 0 0 0-4 1ZM21 5h-4a4 4 0 0 0-4 4v11h4a4 4 0 0 1 4 1Z', process: 'M4 6h16M4 12h16M4 18h16M7 4v4M12 10v4M17 16v4', inbox: 'M3 4h18l-2 16H5ZM3 14h6l2 3h2l2-3h6',
    mcp: 'M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0ZM12 18v4',
    skills: 'M12 3 2 8l10 5 10-5ZM5 10v7l7 4 7-4v-7M22 8v7', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M18 6 6 18', folder: 'M3 7V5h6l2 2h10v13H3Z', files: 'M7 3h10l4 4v14H7ZM3 7v14',
    chats: 'M4 4h16v12H9l-5 4Z M8 8h8M8 12h5', workspace: 'M3 4h18v15H3ZM3 8h18M8 8v11', search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'm9 5 7 7-7 7', back: 'm15 5-7 7 7 7', up: 'm5 15 7-7 7 7', external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
    mic: 'M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8', stop: 'M6 6h12v12H6Z',
    keyboard: 'M2 5h20v14H2ZM6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 13h.1M10 13h.1M14 13h.1M18 13h.1M7 16h10',
    send: 'm4 4 17 8-17 8 4-8ZM8 12h13', pin: 'm8 3 8 0-1 7 4 4H5l4-4ZM12 14v7', more: 'M5 12h.1M12 12h.1M19 12h.1',
    terminal: 'm5 7 5 5-5 5M13 17h6', bell: 'M5 16h14l-2-3V8a5 5 0 0 0-10 0v5ZM10 20h4', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16',
    history: 'M3 5v5h5M4 9a9 9 0 1 1 0 6M12 7v5l3 2', attach: 'm8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2M5 15l9-9', clean: 'm9 4 11 11M6 7l11 11-4 4L2 11ZM2 22h20',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
    eyeOff: 'M3 3l18 18M10.6 5.1A11.1 11.1 0 0 1 12 5c6.4 0 10 7 10 7a14.8 14.8 0 0 1-3.1 3.9M6.1 6.1C3.4 8 2 12 2 12s3.6 7 10 7c1.5 0 2.9-.4 4.1-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">{name === 'more' ? [5, 12, 19].map(x => <circle key={x} cx={x} cy="12" r="1.6" fill="currentColor" stroke="none" />) : <path d={paths[name] || paths.files} />}</svg>
}
