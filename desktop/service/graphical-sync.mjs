// One bounded projection per runtime. Weak keys release closed runtimes; clients
// with an older/missing base get a full snapshot instead of an unsafe delta.
const projections = new WeakMap();
const records = values => new Map(values.map(value => [value.id, JSON.stringify(value)]));
function patch(before, after, values) {
  return { upsert: values.filter(value => before.get(value.id) !== after.get(value.id)), removed: [...before.keys()].filter(id => !after.has(id)), order: values.map(value => value.id) };
}
export function graphicalSync(runtime, since, runtimeId) {
  const revision = Number(since);
  if (runtimeId === runtime.runtimeId && Number.isSafeInteger(revision) && revision === runtime.revision) return { mode: 'unchanged', runtimeId, revision };
  const snapshot = runtime.snapshot(), before = projections.get(runtime);
  const items = records(snapshot.items), turns = records(snapshot.turns || []);
  projections.set(runtime, { runtimeId: snapshot.runtimeId, revision: snapshot.revision, items, turns });
  if (!before || snapshot.runtimeId !== runtimeId || before.runtimeId !== runtimeId || before.revision !== revision) return { mode: 'full', snapshot };
  const { items: ignoredItems, turns: ignoredTurns, ...metadata } = snapshot;
  void ignoredItems; void ignoredTurns;
  return { mode: 'patch', baseRevision: revision, snapshot: metadata, items: patch(before.items, items, snapshot.items), turns: patch(before.turns, turns, snapshot.turns || []) };
}
