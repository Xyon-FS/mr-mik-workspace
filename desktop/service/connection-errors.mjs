// Shared display classification. No probing, retry or request replay occurs here.
export function connectionIssue(error, { localService = false, offlineConfirmed = false } = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const cause = source.cause && typeof source.cause === 'object' ? source.cause : {};
  const data = source.data && typeof source.data === 'object' ? source.data : {};
  const code = [source.code, cause.code, source.codexErrorInfo, source.error?.type, source.name].find(value => typeof value === 'string') || '';
  const statusValue = Number(source.statusCode || source.httpStatus || cause.statusCode || data.statusCode || source.codexErrorInfo?.httpConnectionFailed?.httpStatusCode || (source.status >= 400 ? source.status : 0));
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : null;
  const raw = String(source.message || data.message || (typeof error === 'string' ? error : ''));
  const text = `${code} ${raw}`.toLowerCase();
  let category = 'unknown', message = 'The request failed. Check the connection and native agent status before trying again.';
  if (localService) { category = 'local-service'; message = 'Connection to the local Mr. Mik service was lost. Reconnect to continue; your request has not been resent.'; }
  else if (/helper_unknown_error|setup refresh had errors|windows sandbox failed/.test(text)) { category = 'sandbox-helper'; message = 'The Codex Windows sandbox could not start a local tool. Check the local runtime diagnostics before retrying; image generation and other remote tools may still work.'; }
  else if (offlineConfirmed || code === 'ENETDOWN' || code === 'network_offline') { category = 'offline'; message = 'No internet connection. Restore the connection, then check the agent before retrying.'; }
  else if (status === 401 || status === 403 || /unauthorized|authentication|invalid_api_key|expired.*(?:token|login)|not logged in/.test(text)) { category = 'authentication'; message = 'The agent could not authenticate. Check its login or provider access.'; }
  else if (status === 429 || /quota|rate.limit|usage.limit|insufficient_quota/.test(text)) { category = 'quota'; message = 'The provider usage or rate limit was reached. Check your account limits before retrying.'; }
  else if (/timeout|timed out|etimedout|connecttimeout/.test(text)) { category = 'timeout'; message = 'The connection timed out. The service may be slow or unreachable.'; }
  else if (status >= 500 || /econnreset|econnrefused|enotfound|eai_again|enetunreach|fetch failed|network.*(?:error|failed)|connection.*(?:closed|lost)|stream.*(?:disconnect|closed)|httpconnectionfailed/.test(text)) { category = 'remote-unreachable'; message = 'The agent service could not be reached. Check your connection or try again when the service is available.'; }
  else if (/configuration|config.*(?:invalid|malformed)|mcp.*(?:missing|invalid)|executable.*(?:missing|not found)/.test(text)) { category = 'configuration'; message = 'The agent configuration needs attention. Review its settings and Tools.'; }
  const safeCode = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'network_offline', 'invalid_api_key', 'insufficient_quota', 'usageLimitExceeded', 'httpConnectionFailed', 'streamDisconnected']).has(code) ? code : null;
  return { category, message, details: [safeCode ? `Code: ${safeCode}` : '', status ? `HTTP: ${status}` : ''].filter(Boolean).join(' · '), retry: ['local-service', 'offline', 'timeout', 'remote-unreachable'].includes(category) ? 'connection-only' : 'none' };
}
