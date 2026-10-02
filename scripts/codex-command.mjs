import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// npm's Windows .cmd/.ps1 shims need a shell. Locate the underlying JS instead,
// keeping checkout paths as separate arguments and avoiding shell interpolation.
export function codexCommand(args) {
  if (process.env.CANVY_CODEX_JS) return { command: process.execPath, args: [resolve(process.env.CANVY_CODEX_JS), ...args] };
  if (process.platform !== 'win32') return { command: 'codex', args };
  // Read PATH directly: where.exe output uses an OEM code page and can corrupt
  // non-ASCII Windows user names when decoded as UTF-8.
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, '');
    const executable = resolve(directory, 'codex.exe');
    if (existsSync(executable)) return { command: executable, args };
    const script = resolve(directory, 'node_modules/@openai/codex/bin/codex.js');
    if (existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  }
  throw new Error('Could not locate the Codex executable. Set CANVY_CODEX_JS to its bin/codex.js file.');
}
export function runCodex(args) {
  const cmd = codexCommand(args);
  const result = spawnSync(cmd.command, cmd.args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex command failed with exit status ${result.status}`);
}
