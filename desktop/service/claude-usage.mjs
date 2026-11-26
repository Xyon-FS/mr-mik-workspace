// Whitelisted native metadata only. Tokens are estimates, never plan balances.
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, 160) : '';
export function modelTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) return null;
  const rows = Object.values(value);
  if (!rows.length) return null;
  const total = key => rows.every(row => number(row?.[key]) !== null) ? number(rows.reduce((sum, row) => sum + row[key], 0)) : null;
  return { input: total('inputTokens'), output: total('outputTokens'), cacheRead: total('cacheReadInputTokens'), cacheWrite: total('cacheCreationInputTokens') };
}
export function contextUsage(value) {
  if (number(value?.totalTokens) === null || !number(value?.maxTokens)) return null;
  return { used: value.totalTokens, window: value.maxTokens, model: text(value.model), source: 'native summary estimate' };
}
export function planUsage(value) {
  if (value?.rate_limits_available !== true || !value.rate_limits || typeof value.rate_limits !== 'object' || Array.isArray(value.rate_limits)) return { available: false, windows: [] };
  const windows = [];
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps']) {
    const row = value.rate_limits[key]; if (!row) continue;
    const utilization = number(row.utilization);
    windows.push({ label: key.replaceAll('_', ' '), percent: utilization !== null && utilization <= 100 ? utilization : null, resetsAt: typeof row.resets_at === 'string' && Number.isFinite(Date.parse(row.resets_at)) ? new Date(row.resets_at).toISOString() : null });
  }
  if (Array.isArray(value.rate_limits.model_scoped)) for (const row of value.rate_limits.model_scoped.slice(0, 20)) {
    const name = text(row?.display_name); if (!name) continue;
    const utilization = number(row.utilization);
    windows.push({ label: `${name} · seven day`, percent: utilization !== null && utilization <= 100 ? utilization : null, resetsAt: typeof row.resets_at === 'string' && Number.isFinite(Date.parse(row.resets_at)) ? new Date(row.resets_at).toISOString() : null });
  }
  return { available: true, windows };
}
