import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

export function installedIde(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programs = env.ProgramFiles || 'C:/Program Files';
  for (const [name, file] of [
    ['Visual Studio Code', path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')],
    ['Visual Studio Code', path.join(programs, 'Microsoft VS Code', 'Code.exe')],
    ['Cursor', path.join(local, 'Programs', 'Cursor', 'Cursor.exe')],
    ['Cursor', path.join(programs, 'Cursor', 'Cursor.exe')],
  ]) if (existsSync(file)) return { name, file };
  return null;
}

export async function openIde(root, env = process.env) {
  const ide = installedIde(env);
  if (!ide) throw Object.assign(new Error('No supported IDE installation was found. Open the project folder in your editor manually.'), { status: 400 });
  const child = spawn(ide.file, [root], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(Object.assign(new Error('The IDE could not be opened.'), { status: 400 }))); });
  child.unref();
  return { requested: true, ide: ide.name };
}
