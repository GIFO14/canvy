import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configurePlugin, root } from './configure-plugin.mjs';
import { runCodex } from './codex-command.mjs';

await access(resolve(root, 'dist/mcp-app.html'));
const configuration = await configurePlugin();
runCodex(['plugin', 'marketplace', 'add', configuration.marketplaceRoot, '--json']);
runCodex(['plugin', 'add', 'canvy@canvy-local', '--json']);
console.log('Canvy installed. Use the native Canvy entrypoint in Codex; keep this checkout in place.');
