import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SceneGraph } from '@open-pencil/scene-graph';
import { nativeHarness } from './native-harness.mjs';
import { encodeDocument, decodeDocument } from '../src/document-state.js';
import { encodeWire, decodeWire, WIRE_CHUNK_CHARS } from '../src/wire-format.js';
import { createNativeWire } from '../server/native-wire.mjs';
import { deduplicateFrontendPacket } from '../server/frontend-packet.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const original = randomBytes(4 * 1024 * 1024).toString('base64');
const wire = await encodeWire({ original }), receiver = createNativeWire();
assert.deepEqual(await decodeWire(wire), { original });
await assert.rejects(decodeWire({ ...wire, bytes: wire.bytes - 1 }), /size limit|length mismatch/);
assert.throws(() => receiver.upload('a', 'doc', { id: 'bad', index: 1, total: 2, bytes: 10, data: '' }), /expired|unavailable/);
receiver.upload('a', 'doc', { id: 'target', index: 0, total: 2, bytes: 10, data: 'aaaa' });
assert.throws(() => receiver.upload('b', 'doc', { id: 'target', index: 1, total: 2, bytes: 10, data: 'aaaa' }), /target or sequence/);
assert.throws(() => receiver.upload('a', 'doc', { id: 'target', index: 0, total: 2, bytes: 10, data: 'aaaa' }), /target or sequence/);
const packet = deduplicateFrontendPacket({ assets: [], variants: [1, 2].map(() => ({ assets: [{ kind: 'font', data: original, url: 'data:font/ttf;base64,' + original }], nodes: [] })), html: '', issues: [] });
assert.equal(Object.keys(packet.blobs).length, 2);
assert.equal(packet.variants[0].assets[0].data_ref, packet.variants[1].assets[0].data_ref);
assert.ok(packet.capture_stats.packet_bytes < packet.capture_stats.bytes_before_deduplication * .6);

await mkdir('.runtime', { recursive: true });
await mkdir('artifacts', { recursive: true });
const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening');
const port = allocator.address().port; await new Promise(r => allocator.close(r));
const storage = await mkdtemp(resolve('.runtime/native-wire-qa-')), origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: storage }, stdio: 'ignore' });
const client = new Client({ name: 'native-wire-qa', version: '1' }); let host;
const calls = [], checks = []; let held = false, enterHold;
const entered = new Promise(r => { enterHold = r; });
const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }, { timeout: 90000 }); assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return result.structuredContent ?? JSON.parse(result.content[0].text); };
try {
  for (let n = 0; n < 100; n++) { if (await fetch(origin + '/health').then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 50)); }
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  const document = (await call('create_canvas', { name: 'Large native checkpoint QA' })).document;
  const target = { document_id: document.id }, path = resolve(storage, 'canvases', document.id + '.freecanvas');
  const graph = new SceneGraph(); graph.canvyResources = { fonts: {}, imports: {}, original };
  await writeFile(path, encodeDocument(graph));
  host = await nativeHarness(client, origin, undefined, { interceptTool: async params => {
    const bytes = Buffer.byteLength(JSON.stringify(params)); calls.push({ name: params.name, bytes });
    assert.ok(bytes < WIRE_CHUNK_CHARS + 2000, 'Every native bridge request stays below transport limits');
    if (params.name === '_canvas_persist' && !held && params.arguments.transfer?.index === params.arguments.transfer?.total - 1) {
      held = true; enterHold(); await new Promise(r => setTimeout(r, 16000));
    }
  } });
  const panel = await host.addPanel(document.id, { collapsed: true });
  checks.push('Large opaque native document downloads without a single oversized bridge message');
  const pending = call('canvas_render', { ...target, jsx: '<Frame name="Large checkpoint card" w={300} h={100}><Text w={250} h={30}>Preserve original bytes</Text></Frame>' });
  await entered; await new Promise(r => setTimeout(r, 15500));
  assert.equal((await call('canvas_diagnostics', target)).connection_state, 'document_connected');
  const frame = await pending;
  assert.equal(hash(decodeDocument(await readFile(path, 'utf8')).canvyResources.original), hash(original));
  assert.ok(calls.filter(c => c.name === '_canvas_persist').length > 10);
  checks.push('High-entropy checkpoint larger than the 4 MiB MCP limit saves in bounded chunks without losing resources', 'Connection heartbeats remain live during a save longer than the 15-second lease');
  await call('switch_canvas', {}); await call('switch_canvas', target);
  assert.equal((await call('get_node', { ...target, id: frame.id })).id, frame.id);
  assert.equal(hash(decodeDocument(await readFile(path, 'utf8')).canvyResources.original), hash(original));
  await panel.surface.getByRole('button', { name: 'Back to Home', exact: true }).waitFor({ state: 'attached' });
  assert.deepEqual(host.errors, []);
  checks.push('Save acknowledgement, original resources and node IDs survive reopen', 'Malformed size, reordered chunks and cross-session uploads are rejected');
  await writeFile('artifacts/native-wire-test.json', JSON.stringify({ status: 'PASS', host: 'OPAQUE MCP APP PROTOCOL HARNESS, NOT ACTUAL CODEX', checks, largestBridgeRequest: Math.max(...calls.map(c => c.bytes)) }, null, 2));
  console.log(checks.map(c => 'PASS ' + c).join('\n'));
} finally {
  await host?.close(); await client.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill(); await exited; }
}
