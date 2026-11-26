// Resolve stopped, explicitly linked chats by stable registration identity.
// Never rewrite native transcripts, guess another repository or move live PTYs.
export async function relocatedSessionCwd(session, projects) {
  if (session.process || !session.projectId || typeof session.repositoryId !== 'string' || !session.repositoryId) return session.cwd;
  const project = await projects.get(session.projectId);
  if (!project.repositories.some(repository => repository.id === session.repositoryId)) throw new Error('The chat\'s linked project was removed. Restore its registration before resuming this conversation.');
  const root = await projects.root(session.projectId, session.repositoryId);
  if (root.toLowerCase() === session.cwd.toLowerCase()) return session.cwd;
  // OpenCode also records native directory/project ownership. Changing only
  // the PTY cwd is not a validated native relocation operation.
  if (!['codex', 'claude'].includes(session.agent)) throw new Error('Project location changed. Native relocation for this agent is not supported here; use a reviewed conversation transfer or restore the previous folder.');
  return root;
}
