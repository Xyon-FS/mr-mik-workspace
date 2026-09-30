import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import { saveJson, within } from './util.mjs';

const info = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

// Validate the entire selection before moving anything. Content is staged with
// a recovery manifest, then metadata is committed; only then may Windows recycle.
export async function stageCardRemoval(repo, stateDir, registry, cards) {
  const root = await realpath(path.join(repo, 'workspace'));
  const hub = await realpath(repo), selected = new Set(cards.map(card => card.id));
  const folders = [];
  for (const card of cards) {
    if (typeof card.folder !== 'string' || !card.folder || card.folder.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Invalid card content folder.');
    const folder = path.resolve(root, card.folder);
    if (!within(root, folder) || folder === root || ['_shared', 'planning'].includes(card.folder.split(/[\\/]/)[0].toLowerCase())) throw new Error('Shared or external folders cannot be removed as a card.');
    for (let parent = folder; parent !== root; parent = path.dirname(parent)) {
      if ((await info(parent))?.isSymbolicLink()) throw new Error('Card content cannot be removed through a linked folder.');
    }
    for (const other of registry.entities) {
      if (selected.has(other.id)) continue;
      const otherFolder = path.resolve(root, other.folder || '');
      if (within(folder, otherFolder) || within(otherFolder, folder)) throw new Error('Another card shares this content folder. Separate it before deleting.');
    }
    let ancestor = folder;
    while (!(await info(ancestor))) ancestor = path.dirname(ancestor);
    if (!within(root, await realpath(ancestor))) throw new Error('Card content leaves the Hub through a link.');
    const entry = await info(folder);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || !within(root, await realpath(folder)))) throw new Error('Card content must be an ordinary Hub folder.');
    if (entry && !folders.includes(folder)) folders.push(folder);
  }
  for (let i = 0; i < folders.length; i++) for (let j = i + 1; j < folders.length; j++) {
    if (within(folders[i], folders[j]) || within(folders[j], folders[i])) throw new Error('Selected card folders overlap.');
  }
  let recovery = path.join(stateDir, 'card-recovery', randomUUID());
  let recoveryAncestor = recovery;
  while (!(await info(recoveryAncestor))) recoveryAncestor = path.dirname(recoveryAncestor);
  recovery = path.join(await realpath(recoveryAncestor), path.relative(recoveryAncestor, recovery));
  if (!within(hub, recovery)) throw new Error('Card recovery must stay inside the Hub.');
  await mkdir(recovery, { recursive: true });
  if (!within(hub, await realpath(recovery))) throw new Error('Card recovery must stay inside the Hub.');
  const moves = folders.map((from, index) => ({ from, to: path.join(recovery, `content-${index}`) }));
  const manifest = { cards: structuredClone(cards), moves, registryBefore: structuredClone(registry), status: 'prepared' };
  const manifestPath = path.join(recovery, 'recovery.json');
  await saveJson(manifestPath, manifest);
  const moved = [];
  const rollback = async () => { for (const move of [...moved].reverse()) await rename(move.to, move.from); manifest.status = 'rolled-back'; await saveJson(manifestPath, manifest); };
  try { for (const move of moves) { await rename(move.from, move.to); moved.push(move); } }
  catch (error) { await rollback(); throw error; }
  return { rollback, async finish(recycle) {
    const warnings = [];
    manifest.status = 'committed';
    try { await saveJson(manifestPath, manifest); } catch { return { recoveryPath: recovery, warnings: ['Card removed; content retained in card-recovery because its recovery manifest could not be updated.'] }; }
    for (const move of moves) {
      try { await recycle(move.to); }
      catch { warnings.push('Windows did not confirm recycling. Check the Recycle Bin; unrecycled content remains in the Hub card-recovery folder.'); }
    }
    manifest.status = warnings.length ? 'recovery-retained' : 'recycled';
    try { await saveJson(manifestPath, manifest); } catch { warnings.push('Recovery manifest could not be updated. Check the Recycle Bin and card-recovery folder.'); }
    return { recoveryPath: recovery, warnings };
  } };
}

export class CardRecycler {
  constructor(send) { this.send = send; this.pending = new Map(); }
  recycle(file) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Recycle confirmation timed out')); }, 30000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'recycle-file', requestId, path: file }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  receive(event) {
    if (event.type !== 'card-recycle-result') return;
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(event.requestId);
    event.recycled ? pending.resolve() : pending.reject(new Error('Recycling failed'));
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Service is closing')); } this.pending.clear(); }
}
