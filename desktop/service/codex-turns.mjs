const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Native turn times are seconds; item-history times and durations are milliseconds.
// An observed start is a fallback for this connection, never invented old history.
export function projectTurn(turn, previous, { observed = false, now = Date.now() } = {}) {
  const status = turn.status || previous?.status || 'unknown';
  const startedAt = finite(turn.startedAt) ? turn.startedAt * 1000 : previous?.startedAt ?? (observed && status === 'inProgress' ? now : null);
  const completedAt = finite(turn.completedAt) ? turn.completedAt * 1000 : previous?.completedAt ?? (observed && ['completed', 'interrupted', 'failed'].includes(status) ? now : null);
  const durationMs = finite(turn.durationMs) ? turn.durationMs : previous?.durationMs ?? (startedAt != null && completedAt != null ? Math.max(0, completedAt - startedAt) : null);
  return { id: turn.id, status, startedAt, completedAt, durationMs, timingSource: finite(turn.startedAt) ? 'native' : previous?.timingSource || (observed ? 'observed' : 'unavailable') };
}
