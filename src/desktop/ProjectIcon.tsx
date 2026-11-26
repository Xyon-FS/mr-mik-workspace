import { useEffect, useState } from 'react'
import { api, useDesktop } from './client'

const pending = new Map<string, Promise<{ dataUrl: string | null }>>()
export default function ProjectIcon({ id, location, initials, className }: { id: string; location?: string | null; initials: string; className: string }) {
  const revision = useDesktop().projects.find(project => project.id === id)?.iconRevision || ''
  const key = `${id}:${revision}`
  void location
  const [icon, setIcon] = useState<{ key: string; dataUrl: string | null } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const request = pending.get(key) || api<{ dataUrl: string | null }>(`/projects/${encodeURIComponent(id)}/icon`).catch(() => ({ dataUrl: null }))
    pending.set(key, request)
    void request.then(result => { if (pending.get(key) === request) pending.delete(key); if (active) setIcon({ key, dataUrl: result.dataUrl }) })
    return () => { active = false }
  }, [id, key])
  const src = icon?.key === key ? icon.dataUrl : null
  return <span className={className}>{src && failed !== src ? <img className="workspace-project-icon" src={src} alt="" draggable={false} onError={() => setFailed(src)} /> : initials}</span>
}
