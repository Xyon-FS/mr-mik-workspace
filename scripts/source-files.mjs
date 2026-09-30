import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultHubSkillScopes } from '../desktop/service/hub-skill-defaults.mjs';
export const directories = ['src', 'desktop', 'src-tauri', 'scripts', '.github', 'docs', 'public', '.agents/skills', '.claude/skills'];
export const rootFiles = ['.env.example', '.gitattributes', '.gitignore', '.mcp.json', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'README.md', 'overview.png', 'CHANGELOG.md', 'Setup.ps1', 'Start Mr. Mik.cmd', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'index.html'];
const excluded = part => ['node_modules', '.cache', '.mrmak', '.git', 'dist', 'gen', '__pycache__', 'release', 'target'].includes(part) || part.startsWith('target-') || /^(auth|credentials?|tokens?|job|result|upload)\.json$/i.test(part) || /\.(log|pyc|pyo|tsbuildinfo)$/i.test(part);
export async function sourceFiles(root) {
  const files = [...rootFiles];
  const maintainedSkills = new Set((await readdir(path.join(root, '.agents/skills'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name));
  const visit = async relative => {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      // Distribution copies follow the maintained skill set, never stale or
      // recipient-added Claude-only modules. No source folders are deleted.
      if (relative === '.claude/skills' && !maintainedSkills.has(item.name)) continue;
      if (item.isSymbolicLink() || excluded(item.name) || item.name.startsWith('.env') || item.name === 'settings.local.json') continue;
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) await visit(name); else if (item.isFile()) files.push(name);
    }
  };
  for (const folder of directories) await visit(folder);
  files.push('processes/workspace-authoring.md', 'knowledge/video-watch.md', 'knowledge/voice-dictation.md', 'workspace/_shared/report.css', 'workspace/_shared/report.js', 'workspace/_shared/examples.css', 'workspace/_shared/help.md');
  return files;
}
export const starterFiles = { 'workspace/workspace.json': { entities: [], resources: [] }, 'projects/registry.json': { projects: [] }, 'projects/skill-defaults.json': defaultHubSkillScopes, '.mcp.json': { mcpServers: {} } };
