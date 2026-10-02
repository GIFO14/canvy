import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CORE_TOOLS, COMPATIBILITY_TOOLS } from '../server/tool-compatibility.mjs';
import { nativeHarness } from './native-harness.mjs';

const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening');
const port = allocator.address().port; await new Promise(r => allocator.close(r));
const storage = await mkdtemp(resolve('.runtime/stdio-recovery-qa-'));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: storage, CANVY_TOOL_PROFILE: 'core' };
const backend = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore', windowsHide: true });
const client = new Client({ name: 'stdio-recovery-qa', version: '1' });
let recoveredPid;
let host;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  let initialReady = false;
  for (let i = 0; i < 80; i++) {
    initialReady = await fetch(origin + '/health').then(r => r.ok, () => false);
    if (initialReady) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(initialReady, 'The test-owned initial backend must start before the connector');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['server/stdio.mjs'], env }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, CORE_TOOLS.size + 5);
  for (const name of CORE_TOOLS) assert.ok(tools.some(t => t.name === name), `Missing core tool ${name}`);
  for (const name of COMPATIBILITY_TOOLS) assert.ok(tools.some(t => t.name === 'canvas_' + name));
  assert.ok(!tools.some(t => t.name === 'eval'));
  const open = tools.find(t => t.name === 'open_canvas');
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'thread' }, { type: 'global' }]);
  const document = (await call('create_canvas', { name: 'Durable recovery fixture' })).document;
  host = await nativeHarness(client, origin);
  await host.addPanel(document.id);
  const rendered = await call('canvas_render', { document_id: document.id, jsx: '<Frame name="Recovery card" w={360} h={180} bg="#ffffff"><Text x={24} y={24} w={310} h={30} fontSize={20}>Saved across a backend restart</Text></Frame>' });
  const oldPanelId = (await call('list_open_canvases')).panels.find(p => p.document_id === document.id).panel_id;
  assert.equal((await call('canvas_diagnostics')).tool_profile, 'core');
  const before = await (await fetch(origin + '/health')).json();
  // This port and backend were created by this test, using isolated storage.
  assert.equal(before.pid, backend.pid);
  const exited = once(backend, 'exit'); backend.kill(); await exited;
  const restored = await call('list_documents');
  assert.ok(restored.documents.some(d => d.id === document.id));
  const after = await (await fetch(origin + '/health')).json();
  recoveredPid = after.pid;
  assert.equal(after.name, 'canvy'); assert.notEqual(after.pid, before.pid);
  let renewed;
  for (let n = 0; n < 80; n++) {
    renewed = (await call('list_open_canvases')).panels.find(p => p.document_id === document.id && p.panel_id !== oldPanelId && p.navigation);
    if (renewed) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(renewed, 'The mounted UI must reattach after the backend restart');
  assert.equal((await call('get_node', { document_id: document.id, id: rendered.children[0] })).characters, 'Saved across a backend restart');
  await call('switch_canvas', { panel_id: renewed.panel_id });
  await call('switch_canvas', { document_id: document.id, panel_id: renewed.panel_id });
  assert.deepEqual(host.errors, []);
  await host.close(); host = null;
  const diagnostics = await call('canvas_diagnostics');
  assert.equal(diagnostics.tools.length, CORE_TOOLS.size);
  assert.equal(diagnostics.registered_public_tools, 157);
  const bootstrap = await call('_canvas_bootstrap', { document_id: document.id });
  assert.equal(bootstrap.document.id, document.id);
  await call('_canvas_disconnect', { session: bootstrap.session });
  assert.equal((await call('open_canvas', { document_id: document.id })).opening_requested, true);
  const created = (await call('create_canvas', { name: 'Created once after recovery' })).document;
  assert.equal((await call('list_documents')).documents.filter(d => d.id === created.id).length, 1);
  await writeFile('artifacts/stdio-recovery-test.json', JSON.stringify({ status: 'PASS', host: 'REAL STDIO AND OPAQUE UI HARNESS, NOT CODEX DESKTOP', storage, toolProfile: 'core', advertisedPublicTools: CORE_TOOLS.size, advertisedTools: tools.length, registeredPublicTools: 157, checks: ['Core catalog includes all 33 aliases and open/list/get_node', 'Native opening metadata preserved', 'Same stdio connector recovers a stopped backend automatically', 'Mounted UI reattaches without reopening after backend restart', 'Native navigation works after backend restart', 'Saved text and stable node IDs survive recovery', 'Cached credentials renew after restart', 'Persistent document IDs survive recovery', 'Native app-only bootstrap and disconnect work after recovery', 'Opening acknowledgement and single creation work after recovery', 'No eval'] }, null, 2));
  console.log('PASS compact catalog and automatic backend recovery through the same stdio connector');
} finally {
  await host?.close();
  await client.close();
  if (backend.exitCode === null) backend.kill();
  if (recoveredPid) process.kill(recoveredPid);
}
