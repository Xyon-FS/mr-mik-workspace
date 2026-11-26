const agents = ['codex', 'claude', 'opencode', 'kimi', 'shell'];
const nativeAgents = new Set(['codex', 'claude', 'opencode']);
const features = new Set(['session-origins-v1', 'agent-coverage-v1', 'conversation-media-v1', 'skill-scope-merge-v1', 'claude-display-v1', 'claude-composer-v1', 'claude-profiles-v1']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);

export const transferContract = () => ({ version: 1, required: [], features: [...features] });

export function validateTransferContract(manifest) {
  if (manifest.chats != null && !['full', 'light'].includes(manifest.chats)) throw new Error('Invalid archive chat transfer mode.');
  const contract = manifest.transfer;
  if (contract === undefined) return; // Existing version-1 archives remain valid.
  if (!contract || contract.version !== 1 || !Array.isArray(contract.required) || !Array.isArray(contract.features) || contract.required.length > 100 || contract.features.length > 100 || [...contract.required, ...contract.features].some(item => !text(item, 100)) || new Set(contract.required).size !== contract.required.length || new Set(contract.features).size !== contract.features.length) throw new Error('Invalid archive transfer contract.');
  if (contract.required.some(item => !features.has(item))) throw new Error('This archive requires unsupported transfer features. Update Mr. Mik before importing.');
}

export function validateTransferredSessions(sessions) {
  const ids = new Set();
  for (const session of sessions) {
    if (!session || !uuid.test(session.id) || ids.has(session.id) || !agents.includes(session.agent) || session.chatInterface != null && !['cli', 'chat'].includes(session.chatInterface)) throw new Error('Archive contains invalid or duplicate chat metadata.');
    ids.add(session.id);
    if (session.agent === 'claude' && (session.accountProfileId != null && session.accountProfileId !== 'system' && !uuid.test(session.accountProfileId) || session.claudeAccountIdentity != null && !/^[a-f0-9]{64}$/.test(session.claudeAccountIdentity) || session.conversationStoreId != null && !/^[a-f0-9]{64}$/.test(session.conversationStoreId))) throw new Error('Archive contains invalid Claude profile metadata.');
    const origin = session.messageOrigin;
    if (origin == null) continue;
    if (typeof origin !== 'object' || Array.isArray(origin) || !['branch', 'edit', 'retry'].includes(origin.kind) || !text(origin.threadId, 200) || !text(origin.itemId, 1000) || !(uuid.test(origin.sessionId || '') || origin.sessionId === null && origin.unavailable === true) || origin.unavailable != null && typeof origin.unavailable !== 'boolean' || origin.sessionId === session.id || origin.threadId === session.nativeId) throw new Error('Archive contains invalid conversation origin metadata.');
  }
  const byId = new Map(sessions.map(session => [session.id, session]));
  const completed = new Set();
  for (const session of sessions) {
    const chain = new Set(); let current = session;
    while (current?.messageOrigin && !completed.has(current.id)) {
      if (chain.has(current.id)) throw new Error('Archive contains circular conversation origins.');
      chain.add(current.id);
      const parent = byId.get(current.messageOrigin.sessionId);
      if (parent && (parent.agent !== current.agent || parent.nativeId !== current.messageOrigin.threadId)) throw new Error('Archive conversation origin does not match its parent.');
      current = parent;
    }
    for (const id of chain) completed.add(id);
  }
}

export function sessionDestinationIds(incoming, local) {
  return new Map(incoming.map(session => [session.id, local.find(item => item.id === session.id || session.nativeId && item.agent === session.agent && item.nativeId === session.nativeId)?.id || session.id]));
}

export function relocatedOrigin(session, ids, destination) {
  const origin = session.messageOrigin;
  if (!origin || !text(origin.threadId, 200) || !text(origin.itemId, 1000) || !['branch', 'edit', 'retry'].includes(origin.kind)) return origin;
  const mapped = ids.get(origin.sessionId) || origin.sessionId;
  const matches = item => item.id !== session.id && item.agent === session.agent && item.nativeId === origin.threadId;
  const parent = destination.find(item => item.id === mapped && matches(item)) || destination.find(matches);
  return { ...origin, sessionId: parent?.id || null, ...(parent ? { unavailable: false } : { unavailable: true }) };
}

export function unsupportedNativeReason(session) {
  return session.agent === 'kimi' && (session.hasConversation || session.nativeId || session.lastInputAt || session.preview) ? 'Kimi native conversations are not included in Hub archives. History/screens only.' : null;
}

export function transferCoverage(sessions, manifest) {
  return agents.filter(agent => sessions.some(item => item.agent === agent) || manifest.native.some(item => item.agent === agent)).map(agent => ({
    agent,
    historyEntries: sessions.filter(item => item.agent === agent).length,
    nativeConversations: manifest.native.filter(item => item.agent === agent).length,
    reason: manifest.chats === 'light' ? 'History/screens only (light export).' : !nativeAgents.has(agent) ? agent === 'shell' ? 'Saved screens only; shell processes are not transferred.' : 'Native conversation transfer is not supported; History/screens only.' : null,
  }));
}
