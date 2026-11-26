type Activity = { status: string; exitCode?: number | null }

export function isFailedActivity(item: Activity) {
  if (['declined', 'cancelled', 'canceled', 'interrupted', 'inProgress'].includes(item.status)) return false
  return item.status === 'failed' || item.exitCode != null && item.exitCode !== 0
}

export function commandLabel(item: Activity) {
  if (item.status === 'inProgress') return 'Running command'
  if (item.status === 'declined') return 'Command declined'
  if (['cancelled', 'canceled', 'interrupted'].includes(item.status)) return 'Command cancelled'
  return isFailedActivity(item) ? 'Command failed' : 'Ran command'
}
