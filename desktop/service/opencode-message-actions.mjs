import { createHash } from 'node:crypto';
import { OpenCodeTransfer } from './opencode-transfer.mjs';
const fingerprint = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
const mid = message => message.info?.id || message.id;
const role = message => message.info?.role || message.type;
const text = message => message.info ? message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') : message.text || (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const contents = message => message.info ? { role: role(message), parts: message.parts.map(({ id: _, sessionID: __, messageID: ___, ...part }) => part) } : { type: message.type, text: message.text, content: message.content, files: message.files };

export class OpenCodeMessageActions {
  constructor(sessions, picker, workers) { Object.assign(this, { sessions, picker, workers }); }
  store(source) { return new OpenCodeTransfer(source.cwd, { family: source.openCodeFamily }); }
  async read(store, id) {
    try { return await store.read(id); }
    catch (error) {
      if (error.message !== 'Native V2 export was not recognized.') throw error;
      // A just-created fork can briefly lose an export process to a native DB
      // reader lock. Retry only the read, never fork, paste or inference.
      await new Promise(resolve => setTimeout(resolve, 200));
      return store.read(id);
    }
  }
  assertSource(source) {
    if (source.agent !== 'opencode' || source.chatInterface === 'chat' || !source.process || source.status !== 'running' || source.activity !== 'idle' || !source.nativeId || source.stopping || source.toolUpdating) throw new Error('Open an idle OpenCode terminal and finish native dialogs first.');
  }
  async list(source, { query = '', offset = 0, limit = 100 } = {}) {
    this.assertSource(source);
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(offset) || offset < 0 || offset > 50000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid native history search.');
    const launchId = source.openCodeLaunchId, nativeId = source.nativeId;
    const data = await this.read(this.store(source), source.nativeId);
    if (!data || data.messages.length > 50000 || launchId !== source.openCodeLaunchId || nativeId !== source.nativeId) throw new Error('Native history is unavailable or changed.');
    const key = query.trim().toLowerCase();
    const matches = data.messages.filter(message => ['user', 'assistant'].includes(role(message)) && (!key || text(message).toLowerCase().includes(key)));
    const rows = matches.slice().reverse().slice(offset, offset + limit).reverse();
    return { launchId, revision: fingerprint(data.messages), offset, total: matches.length, hasMore: offset + limit < matches.length, messages: rows.map(message => { const value = text(message), index = key ? value.toLowerCase().indexOf(key) : 0; return { id: mid(message), role: role(message), preview: value.slice(Math.max(0, index - 60), Math.max(0, index - 60) + 220) }; }) };
  }
  async prepare(source, request) {
    this.assertSource(source);
    const proc = source.process, inputAt = source.lastInputAt, launchId = source.openCodeLaunchId;
    if (request.launchId !== launchId) throw new Error('The OpenCode connection changed. Reopen message actions.');
    const store = this.store(source), data = await this.read(store, source.nativeId), messages = data?.messages || [];
    if (!data || messages.length > 4000 || request.revision !== fingerprint(messages)) throw new Error('Native history changed. Reopen message actions.');
    const index = messages.findIndex(message => mid(message) === request.itemId), selected = messages[index];
    if (!selected || request.kind === 'edit' && role(selected) !== 'user' || request.kind !== 'edit' && role(selected) !== 'assistant') throw new Error('Choose a matching input or final response.');
    let userIndex = index;
    while (userIndex >= 0 && role(messages[userIndex]) !== 'user') userIndex--;
    if (userIndex < 0) throw new Error('No reproducible user input precedes this response.');
    const nextUser = messages.findIndex((message, offset) => offset > userIndex && role(message) === 'user');
    const end = nextUser < 0 ? messages.length : nextUser;
    const final = messages.slice(userIndex, end).filter(message => role(message) === 'assistant').at(-1);
    if (!final || !(final.info ? final.info.time.completed : final.time?.completed)) throw new Error('Choose a settled native turn.');
    if (request.kind !== 'edit' && mid(final) !== request.itemId) throw new Error('Choose the final assistant response of the turn.');
    const keep = request.kind === 'branch' ? end : userIndex, before = messages[keep] ? mid(messages[keep]) : undefined;
    let draft = '', model, agent = 'build', variant;
    if (request.kind !== 'branch') {
      const user = messages[userIndex];
      if (user.files?.length || user.skills?.length || user.agents?.length || user.info?.system || user.info?.format || user.info?.tools && Object.keys(user.info.tools).length || user.info && user.parts.some(part => part.type !== 'text' || part.synthetic || part.ignored)) throw new Error('This input has native attachments or special context. Branch after the response and restore it in the terminal.');
      draft = text(user);
      if (!draft.trim() || draft.length > 64000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(draft)) throw new Error('This native input cannot be restored safely as terminal text.');
      const selectedModel = user.info?.model || final.model;
      model = selectedModel && { providerID: selectedModel.providerID, modelID: selectedModel.modelID || selectedModel.id };
      agent = user.info?.agent || final.agent;
      variant = user.info?.variant || selectedModel?.variant;
      if (!['build', 'plan'].includes(agent) || !model?.providerID || !model.modelID) throw new Error('The original agent/model selection cannot be restored. Use a native branch instead.');
    }
    const unchanged = () => source.process === proc && source.lastInputAt === inputAt && source.openCodeLaunchId === launchId && source.activity === 'idle';
    if (!unchanged()) throw new Error('The source terminal changed. Reopen actions.');
    return { store, messages, keep, before, draft, model, agent, variant, unchanged };
  }
  async execute(source, request, record, sessionOptions) {
    const { store, messages, keep, before, draft, model, agent, variant, unchanged } = await this.prepare(source, request);
    let nativeId;
    if (source.openCodeFamily === 1 && keep === 0) {
      // V1 has no idle status for a never-executed empty fork. A fresh CLI
      // session is equivalent before the first input and retains native guards.
      await record({ stage: 'fresh-session' });
    } else {
      const fork = await this.picker.command(source.id, 'message-fork', { ...(before ? { before } : {}) }); nativeId = fork.nativeId;
      await record({ stage: 'native-fork', nativeId });
      const copied = await this.read(store, nativeId);
      if (!copied || copied.messages.length !== keep || JSON.stringify(copied.messages.map(contents)) !== JSON.stringify(messages.slice(0, keep).map(contents))) throw new Error('Native fork boundary could not be confirmed. Its receipt is retained; no prompt was sent.');
    }
    if (!unchanged() || fingerprint((await this.read(store, source.nativeId)).messages) !== request.revision) throw new Error('The source changed during branching. No prompt was sent.');
    const options = await sessionOptions({ agent: 'opencode', chatInterface: 'cli', name: `${request.kind === 'retry' ? 'Retry' : 'Branch'} · ${source.name}`, cwd: source.cwd, projectId: source.projectId, repositoryId: source.repositoryId || 'hub', cardId: source.cardId, bypass: source.bypass, ...(nativeId ? { resumeId: nativeId } : {}), forkParent: { sessionId: source.id, threadId: source.nativeId, itemId: request.itemId, kind: request.kind } });
    const child = await this.sessions.create({ ...options, openCodeActionAgent: model ? agent : undefined });
    await record({ stage: 'registered', childId: child.id });
    let submitted = false, notice = '';
    if (draft) {
      let restoreStep = 'native prompt readiness';
      try {
        let ready = false, readinessError; const deadline = Date.now() + 15000;
        while (!ready && Date.now() < deadline) { try { await this.workers.prepare(child.id); ready = true; } catch (error) { readinessError = error; await new Promise(resolve => setTimeout(resolve, 200)); } }
        if (!ready) throw new Error('Native child prompt unavailable: ' + (readinessError?.message || 'unknown'));
        if (source.openCodeFamily === 2) { restoreStep = 'native agent selection'; await this.picker.command(child.id, 'restore-agent', { agent }); }
        restoreStep = 'model catalog';
        if (source.openCodeFamily === 2) {
          restoreStep = 'native model and variant selection';
          await this.picker.command(child.id, 'restore-model', { ...model, ...(variant ? { variant } : {}) });
        } else {
        const catalog = await this.picker.open(child.id), slug = JSON.stringify([model.providerID, model.modelID]);
        if (!catalog.options.some(option => option.slug === slug)) throw new Error('Original model unavailable');
        restoreStep = 'native model selection';
        const chosen = await this.picker.choose(child.id, slug);
        const details = this.picker.catalogs.get(child.id).find(item => item.providerID === model.providerID && item.modelID === model.modelID);
        if (chosen.variantMenu || details?.variants.length) {
          restoreStep = 'native variant selection';
          const menu = await this.picker.openEffort(child.id), target = menu.options.find(option => option.label.toLowerCase() === (variant || 'default').toLowerCase());
          if (!target) throw new Error('Original variant unavailable');
          await this.picker.chooseEffort(child.id, target.slug);
        } else if (variant) throw new Error('Original variant unavailable');
        }
        restoreStep = 'draft restoration or native submit';
        const target = this.sessions.get(child.id), targetProcess = target.process, inputAt = target.lastInputAt;
        // Verified native menu navigation updates the same typing timestamp as
        // manual keys. Wait out that existing guard; never disable it or clear it.
        const delay = Math.max(0, 2600 - (Date.now() - Date.parse(inputAt || '1970-01-01')));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (target.process !== targetProcess || target.lastInputAt !== inputAt) throw new Error('The child terminal changed during restoration');
        if (request.kind === 'retry') { await record({ stage: 'delivery-reserved' }); await this.workers.send(child.id, draft); submitted = true; }
        else { await this.workers.prepare(child.id); this.sessions.input(child.id, draft, { coordinator: true, submit: false }); }
      } catch (error) { await record({ stage: 'restore-failed', restoreStep, reason: String(error.message).slice(0, 240) }); notice = `The new CLI branch is open. Could not confirm ${restoreStep}; inspect it before sending. Nothing will be retried automatically.`; }
    }
    await this.sessions.persist();
    return { session: this.sessions.list().find(item => item.id === child.id), submitted, notice };
  }
}
