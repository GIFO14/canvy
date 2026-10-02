import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { COMPATIBILITY_TOOLS } from '../server/tool-compatibility.mjs';
import { nativeHarness } from './native-harness.mjs';

const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening');
const port = allocator.address().port; await new Promise(r => allocator.close(r));
const origin = `http://127.0.0.1:${port}`;
const storage = resolve(`.runtime/compatibility-qa-${Date.now()}`);
const process = spawn('node', ['server/index.mjs'], { env: { ...globalThis.process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: storage, CANVY_TOOL_PROFILE: 'full' }, stdio: ['ignore','pipe','pipe'], windowsHide: true });
let output = ''; process.stderr.on('data', chunk => { output += chunk; });
const client = new Client({ name: 'compatibility-qa', version: '1' });
let host;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  if (result.content[0]?.type === 'image') return result.content[0];
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  for (let n = 0; n < 80; n++) {
    if (await fetch(origin + '/health').then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  const { tools } = await client.listTools();
  for (const name of COMPATIBILITY_TOOLS) {
    const original = tools.find(t => t.name === name), alias = tools.find(t => t.name === 'canvas_' + name);
    assert.ok(original && alias, `Missing compatibility path for ${name}`);
    assert.deepEqual(alias.inputSchema, original.inputSchema);
    assert.deepEqual(alias.annotations, original.annotations);
    assert.equal(alias._meta['freecanvas/aliasOf'], name);
  }
  assert.ok(!tools.some(t => t.name === 'eval'));
  const a = (await call('create_canvas', { name: 'Compatibility A' })).document;
  const b = (await call('create_canvas', { name: 'Compatibility B' })).document;
  const closed = await call('canvas_status', { document_id: a.id });
  assert.equal(closed.connection_state, 'panel_not_connected'); assert.equal(closed.ready, false);
  const requested = await call('open_canvas', { document_id: a.id });
  assert.equal(requested.opening_requested, true); assert.equal(requested.connection.requested_document_connected, false);
  host = await nativeHarness(client, origin);
  const home = await host.addPanel();
  await home.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  assert.equal(await home.surface.locator('html').getAttribute('lang'), 'en');
  await home.surface.getByRole('button', { name: 'Open My first canvas', exact: true }).waitFor();
  assert.equal((await call('canvas_status', { document_id: a.id })).connection_state, 'home_connected');
  const panel = await host.addPanel(a.id, { visualEdits: true });
  assert.equal((await call('canvas_status', { document_id: a.id })).connection_state, 'document_connected');
  const screen = await call('canvas_render', { document_id: a.id, jsx: '<Frame name="Compatibility screen" w={420} h={220} fill="#fff"><Text name="QA title" x={24} y={24} w={350} h={32} fontFamily="Roboto" fontSize={20}>Editable native design</Text></Frame>' });
  const title = (await call('get_node', { document_id: a.id, id: screen.id, depth: 1 })).children.find(n => n.type === 'TEXT');
  await call('canvas_set_text', { document_id: a.id, id: title.id, text: 'Text edit through installed aliases' });
  assert.equal((await call('get_node', { document_id: a.id, id: title.id })).characters, 'Text edit through installed aliases');
  await call('canvas_undo', { document_id: a.id });
  assert.equal((await call('get_node', { document_id: a.id, id: title.id })).characters, 'Editable native design');
  await call('canvas_set_fill', { document_id: a.id, id: screen.id, color: '#eaf4ff' });
  await call('canvas_set_font', { document_id: a.id, id: title.id, family: 'Roboto', size: 22, style: 'SemiBold' });
  const formatted = await call('get_node', { document_id: a.id, id: title.id });
  assert.equal(formatted.fontWeight, 600); assert.equal(formatted.fontSize, 22);
  await call('canvas_viewport_zoom_to_fit', { document_id: a.id, ids: [screen.id] });
  assert.equal((await call('get_font_status', { document_id: a.id })).faithful, true);
  assert.equal((await call('export_image', { document_id: a.id, ids: [screen.id], format: 'PNG' })).type, 'image');
  const checkpoint = JSON.parse(await readFile(resolve(storage, `canvases/${a.id}.freecanvas`), 'utf8'));
  assert.ok(checkpoint.graph.nodes.value.some(([, n]) => n.id === title.id && n.text === 'Editable native design'));
  await call('canvas_select_nodes', { document_id: a.id, ids: [title.id] });
  await panel.surface.getByRole('button', { name: 'Send selection to Codex', exact: true }).click();
  await panel.surface.getByText('Selection sent to Codex', { exact: true }).waitFor();
  const message = await host.page.evaluate(() => window.nativeMessages[0]);
  assert.ok(message.content[0].text.startsWith('Work on this Canvy selection:\n'));
  const conflict = await host.addPanel(a.id);
  await conflict.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  assert.ok((await conflict.surface.locator('main').innerText()).includes('already open'));
  await conflict.surface.getByRole('button', { name: 'Open Compatibility B', exact: true }).click();
  await conflict.surface.getByRole('button', { name: 'Back to Home', exact: true }).waitFor();
  assert.equal((await call('canvas_status')).connection_state, 'multiple_documents_connected');
  assert.equal((await call('canvas_status', { document_id: b.id })).document_id, b.id);
  assert.deepEqual(host.errors, []);
  await writeFile('artifacts/compatibility-test.json', JSON.stringify({ status: 'PASS', host: 'OPAQUE PROTOCOL HARNESS, NOT CODEX', aliases: COMPATIBILITY_TOOLS.size, toolCount: tools.length, storage, tests: ['33 aliases preserve schemas and annotations', 'No eval', 'Closed canvas diagnostics without errors', 'Opening requested differs from document connected', 'Native render/text/undo/fill/font/viewport/export/persist', 'Claimed document recovers into usable Home', 'Recovered panel opens another independent document'], errors: host.errors }, null, 2));
  console.log('PASS 33 tool aliases, connection diagnostics and native Home recovery');
} finally {
  await host?.close(); await client.close(); process.kill();
  if (output) console.log(output.slice(-1200));
}
