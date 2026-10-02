import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export function createServiceLifecycle(root, origin, { dataDirectory = resolve(root, '.runtime') } = {}) {
  let starting;
  async function healthy() {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      const value = await response.json();
      return response.ok && ['canvy', 'freecanvas'].includes(value.name) && ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.4.0', '0.4.1', '0.5.0', '0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5'].includes(value.version);
    } catch { return false; }
  }
  return async function ensureService() {
    if (starting) return starting;
    starting = (async () => {
      if (await healthy()) return;
      await mkdir(dataDirectory, { recursive: true });
      const log = openSync(resolve(dataDirectory, 'service.log'), 'a');
      try {
        const child = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
          cwd: root, detached: true, windowsHide: true,
          env: { ...process.env, CANVY_PORT: new URL(origin).port, CANVY_DATA_DIR: dataDirectory },
          stdio: ['ignore', log, log]
        });
        child.unref();
      } finally { closeSync(log); }
      for (let i = 0; i < 40; i++) {
        if (await healthy()) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Canvy service could not start. See the local service.log.');
    })();
    try { await starting; } finally { starting = undefined; }
  };
}
