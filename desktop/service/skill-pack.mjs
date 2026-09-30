import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';

// Reviewed, MIT-licensed upstream additions only. Never replace customized skills
// or scope settings. Missing scope entries already mean Off for both agents.
export const gameSkillPack = Object.freeze([
  'game-animation-integration', 'game-audio-workflow', 'game-level-design',
  'game-ui-workflow', 'game-vfx-workflow', 'gameplay-visual-review',
  'fal-ai-generation', 'higgsfield-workflow', 'motion-reference-workflow',
  'voice-dictation-setup',
  'workspace-authoring', 'feature-handoff',
]);
const directory = path.dirname(fileURLToPath(import.meta.url));
const exists = async file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const contained = (root, target) => { const relative = path.relative(root, target); return !relative.startsWith('..') && !path.isAbsolute(relative); };

export async function installMissingGameSkills(repo, source) {
  const root = await realpath(repo), installed = [];
  source ||= await exists(path.join(directory, 'skill-pack'))
    ? path.join(directory, 'skill-pack') : path.join(directory, '../../.agents/skills');
  for (const agent of ['.agents', '.claude']) {
    const destination = path.join(root, agent, 'skills');
    // Do not follow an existing skills-directory junction outside the Hub.
    for (const folder of [path.join(root, agent), destination]) {
      if (await exists(folder)) {
        if (!contained(root, await realpath(folder))) throw new Error('Hub skill directory points outside the Hub');
      } else await mkdir(folder);
    }
    for (const name of gameSkillPack) {
      const target = path.join(destination, name), origin = path.join(source, name);
      if (await exists(target) || !(await exists(path.join(origin, 'SKILL.md')))) continue;
      await cp(origin, target, { recursive: true, force: false, errorOnExist: true });
      installed.push(`${agent}/${name}`);
    }
  }
  const bundledNote = path.join(source, 'voice-dictation.md');
  const note = await exists(bundledNote) ? bundledNote : path.join(directory, '../../knowledge/voice-dictation.md');
  if (await exists(note)) {
    const knowledge = path.join(root, 'knowledge');
    if (await exists(knowledge)) {
      if (!contained(root, await realpath(knowledge))) throw new Error('Hub knowledge directory points outside the Hub');
    } else await mkdir(knowledge);
    const target = path.join(knowledge, 'voice-dictation.md');
    if (!(await exists(target))) await cp(note, target, { force: false, errorOnExist: true });
  }
  const bundledWorkflow = path.join(source, 'workspace-authoring.md');
  const workflow = await exists(bundledWorkflow) ? bundledWorkflow : path.join(directory, '../../processes/workspace-authoring.md');
  if (await exists(workflow)) {
    const processes = path.join(root, 'processes');
    if (await exists(processes)) {
      if (!contained(root, await realpath(processes))) throw new Error('Hub processes directory points outside the Hub');
    } else await mkdir(processes);
    const target = path.join(processes, 'workspace-authoring.md');
    if (!(await exists(target))) await cp(workflow, target, { force: false, errorOnExist: true });
  }
  return installed;
}
