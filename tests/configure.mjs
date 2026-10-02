import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configurePlugin } from '../scripts/configure-plugin.mjs';

await mkdir('.runtime', { recursive: true });
const marketplaceDirectory = await mkdtemp(resolve('.runtime/configure-qa-'));
const configure = environment => configurePlugin({ marketplaceDirectory, environment });
const browser = async () => JSON.parse(await readFile(resolve(marketplaceDirectory, 'plugins/canvy/.mcp.json'), 'utf8')).mcpServers.canvy.env.CANVY_BROWSER_CHANNEL;
await configure({}); assert.equal(await browser(), undefined);
await configure({ CANVY_BROWSER_CHANNEL: 'msedge' }); assert.equal(await browser(), 'msedge');
await configure({}); assert.equal(await browser(), 'msedge');
await configure({ CANVY_BROWSER_CHANNEL: 'chrome' }); assert.equal(await browser(), 'chrome');
await configure({ CANVY_BROWSER_CHANNEL: '' }); assert.equal(await browser(), undefined);
console.log('PASS browser configuration survives updates; explicit overrides and reset are respected');
