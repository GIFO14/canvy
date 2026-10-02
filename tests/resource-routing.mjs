import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { nativeHarness } from './native-harness.mjs';

await mkdir('.runtime', { recursive: true });
const storage = await mkdtemp(resolve('.runtime/resource-routing-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const backend = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: storage } });
const fresh = new Client({ name: 'fresh-entrypoint', version: '1' });
const oldClient = new Client({ name: 'retained-resource-reader', version: '1' });
// Match the immutable 0.5.4 resource registry, including its dynamic file read.
// A fresh tool catalog and an older resource provider reproduce desktop routing.
const oldProvider = new McpServer({ name: 'canvy-retained-0.5.4-fixture', version: '0.5.4' });
oldProvider.registerResource('canvy-canvas', 'ui://canvy/canvas/v5', { mimeType: 'text/html;profile=mcp-app' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: await readFile('dist/mcp-app.html', 'utf8') }] }));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let host;
try {
  for (let n = 0; n < 100; n++) { if (await fetch(origin + '/health').then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 50)); }
  await oldProvider.connect(serverTransport); await oldClient.connect(clientTransport);
  await fresh.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  await assert.rejects(oldClient.readResource({ uri: 'ui://canvy/canvas/v6' }), /Resource not found/, 'Reproduce the reported pre-editor failure');
  const open = (await fresh.listTools()).tools.find(t => t.name === 'open_canvas');
  assert.equal(open._meta.ui.resourceUri, 'ui://canvy/canvas/v5');
  assert.equal(open._meta['openai/outputTemplate'], open._meta.ui.resourceUri);
  for (const uri of ['ui://canvy/canvas/v5', 'ui://canvy/canvas/v6', 'ui://freecanvas/canvas/v5']) assert.ok((await fresh.readResource({ uri })).contents[0].text.includes('Canvy'));
  const mixed = { listTools: () => fresh.listTools(), readResource: args => oldClient.readResource(args), callTool: params => fresh.callTool(params) };
  host = await nativeHarness(mixed, origin, undefined, { nonceCsp: true });
  const panel = await host.addPanel();
  await panel.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  assert.equal(await panel.surface.locator('main').getAttribute('data-ui-release'), JSON.parse(await readFile('package.json')).version);
  assert.deepEqual(host.errors, []);
  console.log('PASS fresh entrypoint loads the current opaque native UI through a retained v5-only resource provider; v6 and legacy aliases remain readable');
} finally { await host?.close().catch(() => {}); await fresh.close().catch(() => {}); await oldClient.close().catch(() => {}); await oldProvider.close().catch(() => {}); backend.kill(); }
