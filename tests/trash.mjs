import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { nativeHarness } from './native-harness.mjs';
import { createServiceClient } from '../server/service-client.mjs';
import { createDocumentStore } from '../server/documents.mjs';
import { WebSocket } from 'ws';

await mkdir('.runtime', { recursive: true });
const data = await mkdtemp(resolve('.runtime/trash-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`, request = createServiceClient(origin);
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
let client, host, ws, deletedCalls = 0, uncertain = false;
const checks = [];
async function library(operation, args = {}) {
  const response = await request('/api/library', { operation, ...args });
  return { ok: response.ok, ...await response.json() };
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(origin + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const health = await (await fetch(origin + '/health')).json();
  assert.equal(health.version, '0.5.4');
  assert.equal(health.release, JSON.parse(await readFile('package.json')).version);
  // Reproduce a retained 0.5.4 launcher's exact-version matching, rather than
  // validating compatibility only with this release's expanded whitelist.
  const retainedSource = (await readFile('server/service-lifecycle.mjs', 'utf8')).replace(/, '0\.5\.[5-9]'/g, '');
  const retained = await import('data:text/javascript;base64,' + Buffer.from(retainedSource).toString('base64'));
  await retained.createServiceLifecycle(process.cwd(), origin, { dataDirectory: data })();
  assert.equal((await (await fetch(origin + '/health')).json()).pid, health.pid);
  checks.push('A retained exact-version launcher recognizes the stable service ABI without restarting it');
  client = new Client({ name: 'trash-qa', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  const { document: doc } = await library('create', { name: 'Canvas to recover' });
  host = await nativeHarness(client, origin, undefined, { interceptTool: async params => {
    const control = params.arguments?.responses?.find(r => r.id === '$freecanvas/control')?.result;
    if (control?.operation !== 'delete') return;
    deletedCalls++;
    if (!uncertain) return;
    uncertain = false;
    const result = await client.callTool(params);
    assert.ok(!result.isError);
    return { isError: true, content: [{ type: 'text', text: 'Simulated lost acknowledgement. Outcome uncertain.' }] };
  } });
  const a = await host.addPanel(doc.id);
  await call('canvas_render', { document_id: doc.id, jsx: '<Frame name="Keep my design" w={200} h={120}><Text fontSize={18}>Original content</Text></Frame>' });
  const checkpoint = await readFile(resolve(data, 'canvases', doc.id + '.freecanvas'));
  const fig = await readFile(resolve(data, 'canvases', doc.id + '.fig'));
  const b = await host.addPanel();
  await host.page.screenshot({ path: 'artifacts/trash-home.png' });
  await b.surface.getByRole('button', { name: 'Delete Canvas to recover', exact: true }).click();
  await b.surface.getByRole('dialog', { name: 'Delete canvas?' }).waitFor();
  await b.surface.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(deletedCalls, 0);
  assert.ok((await library('list')).documents.some(d => d.id === doc.id));
  checks.push('Cancel leaves the document unchanged');

  await b.surface.getByRole('button', { name: 'Delete Canvas to recover', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Delete canvas', exact: true }).click();
  await b.surface.getByText('This canvas is open in another panel. Return that panel to Home or close it before deleting.', { exact: true }).waitFor();
  assert.ok((await library('list')).documents.some(d => d.id === doc.id));
  checks.push('Deletion refuses a native writer in another panel');
  await host.show(a.id);
  await a.surface.getByRole('button', { name: 'Back to Home' }).click();
  await a.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  await host.show(b.id);
  await b.surface.getByRole('button', { name: 'Delete Canvas to recover', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Delete canvas', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Open Canvas to recover', exact: true }).waitFor({ state: 'detached' });
  let list = await library('list');
  assert.ok(!list.documents.some(d => d.id === doc.id));
  assert.equal(list.trash.filter(d => d.id === doc.id).length, 1);
  assert.equal((await request('/api/native', { operation: 'bootstrap', document_id: doc.id })).status, 409);
  const token = (await (await fetch(origin + '/api/bootstrap')).json()).token;
  const lateSave = await fetch(origin + '/api/document', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, document_id: doc.id, state: checkpoint.toString(), fig: fig.toString('base64') }) });
  assert.ok(!lateSave.ok, 'Late writes must not revive a deleted canvas');
  checks.push('Trash hides documents and rejects opening and late saves');

  await b.surface.getByRole('button', { name: 'Trash (1)', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Restore Canvas to recover', exact: true }).click();
  await b.surface.getByText('Trash is empty.', { exact: true }).waitFor();
  assert.deepEqual(await readFile(resolve(data, 'canvases', doc.id + '.freecanvas')), checkpoint);
  assert.deepEqual(await readFile(resolve(data, 'canvases', doc.id + '.fig')), fig);
  await b.surface.getByRole('button', { name: 'Back to canvases', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Open Canvas to recover', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Back to Home' }).waitFor();
  const graph = await call('get_page_tree', { document_id: doc.id });
  assert.ok(JSON.stringify(graph).includes('Keep my design'));
  await b.surface.getByRole('button', { name: 'Back to Home' }).click();
  await b.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  checks.push('Restore keeps the ID, checkpoint, fig backup and editable content');

  // Reopening normally writes a fresh .fig ZIP timestamp on the next flush.
  // Compare Trash against the bytes immediately preceding this deletion.
  const secondFig = await readFile(resolve(data, 'canvases', doc.id + '.fig'));
  const before = deletedCalls; uncertain = true;
  await b.surface.getByRole('button', { name: 'Delete Canvas to recover', exact: true }).click();
  await b.surface.getByRole('button', { name: 'Delete canvas', exact: true }).click();
  await b.surface.getByText(/Simulated lost acknowledgement/).waitFor();
  await b.surface.getByRole('button', { name: 'Open Canvas to recover', exact: true }).waitFor({ state: 'detached' });
  assert.equal(deletedCalls, before + 1);
  checks.push('Uncertain deletion refreshes the catalogue without replaying the mutation');

  ws = new WebSocket(origin.replace('http', 'ws') + '/bridge?token=' + token, { origin });
  await once(ws, 'open');
  assert.equal((await library('delete', { document_id: 'freecanvas' })).ok, false);
  const closed = once(ws, 'close'); ws.close(); await closed; ws = null;
  assert.equal((await library('delete', { document_id: 'freecanvas' })).ok, true);
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  assert.equal(bootstrap.document, null); assert.equal(typeof bootstrap.token, 'string');
  assert.ok((await library('list')).ok, 'Authentication still works when the legacy default is in Trash');
  checks.push('Browser writer protection and archived default bootstrap remain valid');

  const { document: raceDoc } = await library('create', { name: 'Concurrent open test' });
  const [opened, removed] = await Promise.all([
    request('/api/native', { operation: 'bootstrap', document_id: raceDoc.id }),
    library('delete', { document_id: raceDoc.id })
  ]);
  assert.notEqual(opened.ok, removed.ok, 'A delete and a new writer must never both succeed');
  if (opened.ok) await request('/api/native', { operation: 'disconnect', session: (await opened.json()).session });
  checks.push('Concurrent opening and deletion cannot both acquire the document');

  assert.deepEqual(host.errors, []);
  await host.close(); host = null; await client.close(); client = null;
  const exited = once(service, 'exit'); service.kill(); await exited;
  const store = await createDocumentStore(data);
  assert.ok(store.trash().some(d => d.id === doc.id));
  await store.restore(doc.id); await store.restore('freecanvas');
  assert.equal((await store.read(doc.id)).state, checkpoint.toString());
  assert.deepEqual(await readFile(resolve(data, 'canvases', doc.id + '.fig')), secondFig);
  checks.push('Trash survives a cold restart and restores the original files');
  console.log('PROTOCOL HARNESS, NOT CODEX DESKTOP\nPASS ' + checks.join('\nPASS '));
} finally {
  ws?.close(); await host?.close(); await client?.close();
  if (service.exitCode === null && service.signalCode === null) { const exited = once(service, 'exit'); service.kill(); await exited; }
}
