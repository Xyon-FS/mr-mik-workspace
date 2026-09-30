import type { WorkspaceEntity } from '../types'
import { entityHash } from '../lib/route'
import { categoryIcon } from '../lib/categories'
import { api, contentUrl, isDesktop, reportError } from '../desktop/client'
import CardActions from '../desktop/CardActions'

/**
 * The design-system card: glass surface over the aura, gradient edge
 * (pink→purple; amber when pinned), glow + lift on hover. Building
 * block of the home grid; mirrored as `.mak-card` in
 * scripts/shared/report_style.py for generated reports.
 */
export default function MakCard({ entity }: { entity: WorkspaceEntity }) {
  const steps = entity.steps.length
  const card = (
    <div
      className={`mak-card entity-card${entity.pinned ? ' pinned' : ''}`}
      data-entity={entity.id}
    >
      <a className="mak-card-cover" href={entityHash(entity.id)} aria-label={entity.title} />
      {isDesktop && <button className="mak-card-pin" aria-label={`${entity.pinned ? 'Unpin' : 'Pin'} card ${entity.title}`} title={entity.pinned ? 'Unpin card' : 'Pin card'} onClick={() => void api('/cards/pin', { id: entity.id, pinned: !entity.pinned }).catch(reportError)}>📌</button>}
      <div className="card-top">
        <span className="chip">
          <span aria-hidden="true">{categoryIcon(entity.category)}</span>
          {entity.category || 'other'}
        </span>
        {entity.pinned && <span className="chip chip-pin">pinned</span>}
        <span className={`status-dot ${entity.status}`} title={entity.status} />
      </div>

      <div className="card-project-title">
        {entity.icon && <img className="card-project-icon" src={contentUrl(`/workspace/${entity.folder}/${entity.icon}`)} width="48" height="48" alt="" loading="lazy" decoding="async" />}
        <h3 className="card-title">{entity.title}</h3>
      </div>

      {entity.description && <p className="card-desc">{entity.description}</p>}

      <div className="card-foot">
        <span>
          {steps} step{steps === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{entity.updated ?? entity.created}</span>
        <span className="card-open" aria-hidden="true">
          open →
        </span>
      </div>
    </div>
  )
  return isDesktop ? <CardActions entity={entity}>{card}</CardActions> : card
}
