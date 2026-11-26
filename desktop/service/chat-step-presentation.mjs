// Bounded display metadata only. Never project raw reasoning or arbitrary event objects.
const secret = /password|secret|token|authorization|cookie|api.?key|credential|encrypted|reasoning/i;
const short = value => typeof value === 'string' ? value.slice(0, 4000) : '';
export function structuredPreview(value) {
  let characters = 8000, nodes = 160, truncated = false;
  const marker = '[Additional content shortened]';
  const string = (value, maximum = 4000) => {
    let result = value.slice(0, maximum);
    if (JSON.stringify(result).length + 12 > characters) result = result.slice(0, Math.max(0, Math.floor((characters - 16) / 6)));
    if (result.length < value.length) { result += '…'; truncated = true; }
    characters = Math.max(0, characters - JSON.stringify(result).length - 12);
    return result;
  };
  const visit = (entry, depth = 0) => {
    if (--nodes < 0 || depth > 5) { truncated = true; return marker; }
    if (typeof entry === 'string') return string(entry);
    if (entry == null || typeof entry === 'number' || typeof entry === 'boolean') return entry;
    if (typeof entry !== 'object') return null;
    const array = Array.isArray(entry), source = array ? entry : Object.entries(entry);
    const selected = [];
    let shortened = false;
    for (let index = 0; index < source.length; index++) {
      if (index >= 30 || characters < 128 || nodes < 1) { truncated = true; shortened = true; break; }
      if (array) selected.push(visit(source[index], depth + 1));
      else {
        const [key, child] = source[index];
        // Keep the distinguishing filename/tail of long keys. If abbreviated
        // keys still collide, retain both entries instead of overwriting a value.
        if (key.length > 160) truncated = true;
        const base = string(key.length > 160 ? key.slice(0, 100) + '…' + key.slice(-59) : key, 160);
        let name = base, suffix = 2;
        while (selected.some(([existing]) => existing === name)) { name = `${base} [${suffix++}]`; truncated = true; }
        selected.push([name, secret.test(key) ? string('[Redacted]') : visit(child, depth + 1)]);
      }
    }
    if (shortened) {
      if (array) selected.push(marker);
      else {
        let key = '[Preview shortened]';
        while (selected.some(([name]) => name === key)) key += '…';
        selected.push([key, marker]);
      }
    }
    return array ? selected : Object.fromEntries(selected);
  };
  const serialized = JSON.stringify(visit(value), null, 2) || '';
  // Defensive bound even for unusual escaping/keys: the inspection remains valid JSON.
  return serialized.length <= 16000 ? { text: serialized, truncated } : { text: JSON.stringify({ notice: marker, preview: serialized.slice(0, 2000) }, null, 2), truncated: true };
}
export function displayStructure(value) { return structuredPreview(value).text; }
export function stepPresentation(item, previous) {
  const data = { ...previous };
  const structure = (field, value) => { const preview = structuredPreview(value); data[field] = preview.text; data[field + 'Truncated'] = preview.truncated; };
  if (item.type === 'commandExecution') {
    if (typeof item.cwd === 'string') data.cwd = short(item.cwd);
    if (Array.isArray(item.commandActions)) data.actions = item.commandActions.slice(0, 20).map(action => ({ type: short(action.type), path: short(action.path), query: short(action.query) }));
  }
  if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
    // Omitted fields are partial updates; a supplied result is a replacement.
    if (item.result !== undefined || item.contentItems !== undefined) {
      for (const key of ['structured', 'structuredTruncated', 'resultText', 'resultTextLength', 'resultTextTruncated']) delete data[key];
    }
    if (item.arguments != null) structure('arguments', item.arguments);
    if (item.result?.structuredContent != null) structure('structured', item.result.structuredContent);
  }
  if (item.type === 'webSearch') {
    const action = item.action;
    data.web = { action: short(action?.type) || data.web?.action || '', queries: action?.queries != null || action?.query != null || item.query != null ? (Array.isArray(action?.queries) ? action.queries : [action?.query || item.query]).filter(value => typeof value === 'string').slice(0, 20).map(short) : data.web?.queries || [], url: short(action?.url) || data.web?.url || '', pattern: short(action?.pattern) || data.web?.pattern || '' };
    if (Array.isArray(item.results)) structure('structured', item.results);
  }
  if (item.type === 'subAgentActivity' && (item.kind != null || item.agentPath != null)) data.note = [short(item.kind), short(item.agentPath), short(item.model)].filter(Boolean).join(' · ');
  if (['functionCallOutput', 'dynamicToolCall'].includes(item.type)) {
    if (item.namespace !== undefined) data.namespace = short(item.namespace);
    const name = item.type === 'functionCallOutput' ? item.name : item.tool;
    if (name != null) data.label = [data.namespace, short(name)].filter(Boolean).join(' · ');
  }
  if (!['reasoning', 'userMessage', 'agentMessage', 'hookPrompt'].includes(item.type)) {
    const note = short(item.title) || short(item.description) || short(item.message);
    if ([item.title, item.description, item.message].some(value => typeof value === 'string')) data.note = note;
  }
  if (item.error === null || item.failure === null) delete data.error;
  if (item.error != null || item.failure != null) {
    const error = item.error ?? item.failure;
    data.error = typeof error === 'string' ? short(error) : short(error.message) || short(error.reason) || (error.type === 'usageLimitExceeded' ? 'Image generation usage limit reached.' : 'The operation reported an error.');
  }
  return Object.keys(data).length ? data : undefined;
}
