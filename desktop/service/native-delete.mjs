import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, rm, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { claudeTranscript, codexTranscript } from './native-events.mjs';
import { codexBinary } from './agents.mjs';
import { within } from './util.mjs';
import { OpenCodeTransfer, openCodeHash, openCodeMembers } from './opencode-transfer.mjs';
import { validSessionId } from './opencode.mjs';

const execute = promisify(execFile);
const uuid = /^[a-f0-9-]{36}$/i;
export class NativeDeletion {
  constructor(sessions, stateDir) { this.sessions = sessions; this.stateDir = stateDir; this.plans = new Map(); this.openCode = new OpenCodeTransfer(sessions.repo); }
  async plan(id) {
    const session = this.sessions.get(id);
    if (session.open || session.process) throw new Error('Close the chat tab before permanently deleting it.');
    if (!['codex', 'claude', 'opencode'].includes(session.agent) || !(session.agent === 'opencode' ? validSessionId(session.nativeId) : uuid.test(session.nativeId || ''))) throw new Error('This chat has no known supported native session to delete.');
    const duplicates = this.sessions.list().filter(item => item.id !== id && item.agent === session.agent && item.nativeId === session.nativeId);
    if (duplicates.length) throw new Error('Another Mr. Mik chat references this native conversation. Remove that association first.');
    if (session.agent === 'opencode') {
      const data = await this.openCode.read(session.nativeId);
      if (!data) throw new Error('Native OpenCode conversation is missing. Only the Mr. Mik record can be removed.');
      const nativeSessions = openCodeMembers(data).map(member => ({ id: member.info.id, title: member.info.title }));
      const ids = new Set(nativeSessions.map(member => member.id));
      if (this.sessions.list().some(item => item.id !== id && item.agent === 'opencode' && ids.has(item.nativeId))) throw new Error('Another Mr. Mik chat references this OpenCode family. Close it and remove that association first.');
      const plan = { token: randomUUID(), chatId: id, agent: 'opencode', nativeId: session.nativeId, chatName: session.name, bytes: Buffer.byteLength(JSON.stringify(data)), files: [], hash: openCodeHash(data), expires: Date.now() + 5 * 60000 };
      this.plans.set(plan.token, plan);
      return { token: plan.token, agent: plan.agent, chatName: plan.chatName, nativeId: plan.nativeId, bytes: plan.bytes, files: [], nativeSessions, warning: `This main OpenCode conversation and all ${nativeSessions.length - 1} child sessions listed below will be deleted recursively. Independent forks are not child sessions. Close other OpenCode instances first. Unrelated sessions, external files, authentication and configuration remain. This cannot be undone.` };
    }
    const transcript = session.agent === 'codex' ? await codexTranscript(session.nativeId) : await claudeTranscript(session.cwd, session.nativeId, { search: true });
    const info = transcript && await stat(transcript).catch(() => null);
    if (!info?.isFile()) throw new Error('The native transcript is not present. Only the Mr. Mik record can be removed.');
    const token = randomUUID();
    const sidecar = session.agent === 'claude' ? path.join(path.dirname(transcript), session.nativeId) : null;
    const sidecarExists = sidecar && (await stat(sidecar).catch(() => null))?.isDirectory() && within(await realpath(path.dirname(transcript)), await realpath(sidecar));
    const auxiliary = [];
    if (session.agent === 'claude') {
      const root = await realpath(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
      for (const kind of ['tasks', 'file-history', 'uploads', 'image-cache']) {
        const parent = path.join(root, kind), folder = path.join(parent, session.nativeId);
        const parentInfo = await lstat(parent).catch(() => null), folderInfo = await lstat(folder).catch(() => null);
        if (parentInfo?.isSymbolicLink() || folderInfo?.isSymbolicLink()) throw new Error('Claude session data contains a link; review it manually before deleting.');
        if (folderInfo?.isDirectory() && within(root, await realpath(folder))) auxiliary.push(folder);
      }
    }
    const plan = { token, chatId: id, agent: session.agent, nativeId: session.nativeId, chatName: session.name, bytes: info.size, files: [transcript, ...(sidecarExists ? [sidecar] : []), ...auxiliary], expires: Date.now() + 5 * 60_000 };
    this.plans.set(token, plan);
    return { token, agent: plan.agent, chatName: plan.chatName, nativeId: plan.nativeId, bytes: plan.bytes, files: plan.files, warning: session.agent === 'codex' ? 'Codex may also delete descendant sessions. This cannot be undone.' : 'Claude transcript and session-specific tool results will be deleted. This cannot be undone.' };
  }
  async confirm(id, token, name) {
    const plan = this.plans.get(token);
    if (!plan || plan.chatId !== id || plan.expires < Date.now() || name !== plan.chatName) throw new Error('Deletion confirmation expired or did not match the chat name.');
    this.plans.delete(token);
    const session = this.sessions.get(id);
    if (session.open || session.process || session.nativeId !== plan.nativeId) throw new Error('Chat state changed; review the deletion again.');
    if (session.agent !== plan.agent) throw new Error('Chat agent changed; review deletion again.');
    if (plan.agent === 'opencode') {
      const current = await this.plan(id);
      const latest = this.plans.get(current.token); this.plans.delete(current.token);
      // The fresh plan checked all managed family references and its exact data.
      if (!latest || latest.hash !== plan.hash) throw new Error('Native OpenCode conversation changed; review deletion again.');
      await this.openCode.remove(plan.nativeId, plan.hash); await this.sessions.forget(id);
      return { deleted: true, agent: 'opencode' };
    }
    const current = await this.plan(id);
    if (JSON.stringify(current.files) !== JSON.stringify(plan.files)) throw new Error('Native session files changed; review the deletion again.');
    this.plans.delete(current.token);
    if (plan.agent === 'claude') {
      const configRoot = await realpath(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'));
      const transcript = await realpath(plan.files[0]);
      if (!within(configRoot, transcript) || path.basename(transcript) !== `${plan.nativeId}.jsonl`) throw new Error('Claude transcript location changed; review the deletion again.');
      const profile = await realpath(path.dirname(configRoot));
      for (const file of plan.files.slice(1)) {
        const folder = await realpath(file);
        if (!within(profile, folder) || path.basename(folder) !== plan.nativeId) throw new Error('Claude session folder changed; review the deletion again.');
      }
    }
    if (plan.agent === 'codex') {
      const binary = codexBinary();
      await execute(binary.file, [...binary.args, 'delete', plan.nativeId, '--force'], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    } else {
      await rm(plan.files[0]);
      for (const file of plan.files.slice(1)) await rm(file, { recursive: true });
    }
    await this.sessions.forget(id);
    return { deleted: true, agent: plan.agent };
  }
}
