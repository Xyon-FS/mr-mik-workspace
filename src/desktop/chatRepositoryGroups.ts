import type { ChatSession, Project } from './types'

export function chatRepositoryGroups(items: ChatSession[], project: Project) {
  const workspace = items.filter(item => !item.repositoryId || item.repositoryId === 'hub')
  const groups = workspace.length ? [{ id: 'hub', name: 'Workspace', missing: false, items: workspace }] : []
  for (const repository of project.repositories) {
    const chats = items.filter(item => item.repositoryId === repository.id)
    if (chats.length) groups.push({ id: repository.id, name: repository.name, missing: !repository.available, items: chats })
  }
  const missing = [...new Set(items.map(item => item.repositoryId).filter((id): id is string => !!id && id !== 'hub' && !project.repositories.some(repository => repository.id === id)))]
  for (const id of missing) groups.push({ id, name: 'Unlinked project', missing: true, items: items.filter(item => item.repositoryId === id) })
  return groups
}
