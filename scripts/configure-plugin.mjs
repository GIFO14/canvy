import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const marketplaceRoot = resolve(root, '.local');
export async function configurePlugin() {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const source = resolve(root, 'plugins/canvy');
  const destination = resolve(marketplaceRoot, 'plugins/canvy');
  await mkdir(resolve(destination, '.codex-plugin'), { recursive: true });
  await cp(resolve(source, 'skills'), resolve(destination, 'skills'), { recursive: true });
  for (const file of ['plugin.json', '.codex-plugin/plugin.json']) {
    await cp(resolve(source, file), resolve(destination, file));
  }
  const config = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    canvy: { type: 'stdio', command: 'node', args: [resolve(root, 'server/stdio.mjs').replaceAll('\\', '/')],
      env: {
        // Change the host's MCP configuration identity when upgrading. A new
        // plugin version must not keep an old process with the same launch args.
        CANVY_CONNECTOR_VERSION: version,
        CANVY_PORT: process.env.CANVY_PORT ?? process.env.FREECANVAS_PORT ?? '4318',
        CANVY_DATA_DIR: resolve(process.env.CANVY_DATA_DIR ?? process.env.FREECANVAS_DATA_DIR ?? resolve(root, '.runtime')).replaceAll('\\', '/'),
        CANVY_TOOL_PROFILE: process.env.CANVY_TOOL_PROFILE ?? process.env.FREECANVAS_TOOL_PROFILE ?? 'core',
        ...(process.env.CANVY_BROWSER_CHANNEL ? { CANVY_BROWSER_CHANNEL: process.env.CANVY_BROWSER_CHANNEL } : {})
      }
    }
  } };
  for (const file of ['mcp.json', '.mcp.json']) await writeFile(resolve(destination, file), JSON.stringify(config, null, 2) + '\n');
  await mkdir(resolve(marketplaceRoot, '.agents/plugins'), { recursive: true });
  await writeFile(resolve(marketplaceRoot, '.agents/plugins/marketplace.json'), JSON.stringify({
    name: 'canvy-local', interface: { displayName: 'Canvy Local' },
    plugins: [{ name: 'canvy', source: { source: 'local', path: './plugins/canvy' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Creativity' }]
  }, null, 2) + '\n');
  return { marketplaceRoot, plugin: destination, version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await configurePlugin(), null, 2));
}
