// Compile and run minimal NSIS probes, never an application installer. No files
// are installed, no real app is launched/closed and no native user state is read.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFile, copyFile, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const execute = promisify(execFile), root = process.cwd();
const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-installer-shutdown-'));
const nsis = path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS');
const compiler = path.join(nsis, 'makensis.exe');
const hook = path.join(root, 'src-tauri', 'installer-hooks.nsh');
let worker;
try {
  for (const busy of [false, true]) {
    const name = 'mik-shutdown-fixture-' + randomUUID();
    const output = path.join(folder, name + '.exe'), input = path.join(folder, name + '.nsi');
    const marker = path.join(folder, name + '.completed');
    if (busy) {
      const file = path.join(folder, 'owned-' + name + '.exe');
      await copyFile(process.execPath, file);
      worker = spawn(file, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve, reject) => { worker.stdout.once('data', resolve); worker.once('error', reject); });
    }
    await writeFile(input, `Unicode true
!include "LogicLib.nsh"
!addplugindir "${path.join(nsis, 'Plugins', 'x86-unicode', 'additional')}"
!define MAINBINARYNAME "${busy ? 'owned-' + name : 'nonexistent-' + name}"
!include "${hook}"
Name "Isolated shutdown hook check"
OutFile "${output}"
RequestExecutionLevel user
SilentInstall silent
Var PassiveMode
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_PREUNINSTALL
  FileOpen $0 "${marker}" w
  FileWrite $0 "completed"
  FileClose $0
SectionEnd
`);
    await execute(compiler, ['/V2', input], { windowsHide: true, timeout: 30000 });
    if (busy) {
      await assert.rejects(execute(output, ['/S'], { windowsHide: true, timeout: 10000 }), error => error.code === 2);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      assert.equal(worker.exitCode, null); assert.equal(worker.signalCode, null);
    } else {
      await execute(output, ['/S'], { windowsHide: true, timeout: 10000 });
      assert.equal(await readFile(marker, 'utf8'), 'completed');
    }
    console.log(busy ? 'Busy app: silent install aborted without terminating processes.' : 'Closed app: both hooks permit installation.');
  }
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const ended = new Promise(resolve => worker.once('close', resolve)); worker.kill(); await ended;
  }
  await cleanupFixtures();
}
