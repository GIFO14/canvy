import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { nativeHarness } from './native-harness.mjs';
import { createServiceClient } from '../server/service-client.mjs';

const data = await mkdtemp(resolve('.runtime/navigation-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
const uiClient = new Client({ name: 'navigation-ui', version: '1' });
const agent = new Client({ name: 'independent-agent', version: '1' });
let host;
let failPersistence = false;
let heldExchange;
let blockRecovery = false;
async function call(name, args = {}) {
  const result = await agent.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
async function failed(name, args, pattern) {
  const result = await agent.callTool({ name, arguments: args });
  assert.ok(result.isError); assert.match(result.content[0].text, pattern);
}
const checks = [];
try {
  let ready;
  for (let n = 0; n < 100; n++) { ready = await fetch(origin + '/health').then(r => r.ok, () => false); if (ready) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready);
  await uiClient.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  await agent.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  host = await nativeHarness(uiClient, origin, undefined, { interceptTool: async params => {
    if (heldExchange && params.name === '_canvas_exchange' && params.arguments.view?.document_id === heldExchange.document_id) {
      heldExchange.entered(); await heldExchange.gate;
    }
    if (blockRecovery && params.name === '_canvas_bootstrap' && params.arguments.previous_session) return { isError: true, content: [{ type: 'text', text: 'Isolated QA is holding lease recovery' }] };
    if (failPersistence && params.name === '_canvas_persist') return { isError: true, content: [{ type: 'text', text: 'Injected disk failure for isolated navigation QA' }] };
  } });
  const a = (await call('create_canvas', { name: 'Navigation A' })).document;
  const b = (await call('create_canvas', { name: 'Navigation B' })).document;
  const c = (await call('create_canvas', { name: 'Navigation C' })).document;
  const panel = await host.addPanel();
  const listing = await call('list_open_canvases');
  assert.equal(listing.shared, true); assert.equal(listing.panels.length, 1);
  const panel_id = listing.panels[0].panel_id;
  assert.equal(listing.panels[0].ui_version, '0.4.1');
  const loaded = await call('switch_canvas', { document_id: a.id, panel_id });
  assert.equal(loaded.document_id, a.id); assert.equal(loaded.panel_id, panel_id); assert.equal(loaded.ready, true);
  const shape = await call('canvas_render', { document_id: a.id, jsx: '<Frame name="Autosaved card" w={400} h={220} bg="#ffffff"><Text name="Editable heading" x={24} y={24} w={350} h={32} fontSize={20}>Persistent document A</Text></Frame>' });
  const text_id = shape.children[0];
  await panel.surface.getByRole('button', { name: 'Back to Home' }).click();
  await panel.surface.getByRole('button', { name: 'Open Navigation B', exact: true }).click();
  await panel.surface.getByRole('button', { name: 'Back to Home' }).waitFor();
  assert.equal((await call('canvas_status', { document_id: a.id })).connected, false);
  await call('canvas_set_text', { document_id: a.id, id: text_id, text: 'Continued after the user switched to B' });
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, 'Continued after the user switched to B');
  assert.equal((await call('list_open_canvases')).panels[0].panel_id, panel_id);
  assert.equal((await call('list_open_canvases')).panels.length, 1);
  checks.push('Independent MCP client sees and navigates the UI client panel', 'A user document switch does not disconnect agent edits', 'Explicit target automatically reloads the same panel without extra surfaces');
  await call('switch_canvas', { document_id: a.id, panel_id });
  await call('canvas_undo', { document_id: a.id });
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, 'Persistent document A');
  await call('redo', { document_id: a.id });
  checks.push('Selecting the already loaded document preserves its undo history');
  failPersistence = true;
  await failed('canvas_set_text', { document_id: a.id, id: text_id, text: 'Pending save must not be discarded' }, /Injected disk failure/);
  await failed('switch_canvas', { document_id: b.id, panel_id }, /Injected disk failure/);
  assert.equal((await call('list_open_canvases')).panels[0].document_id, a.id);
  failPersistence = false;
  await panel.surface.locator('main[data-saved="true"][data-save-error="false"]').waitFor();
  await call('canvas_viewport_zoom_to_fit', { document_id: a.id, ids: [shape.id] });
  const view = await call('canvas_viewport_get', { document_id: a.id });
  const box = await panel.surface.getByTestId('design-canvas').boundingBox();
  await host.page.mouse.dblclick(box.x + box.width / 2 + (120 - view.center.x) * view.zoom, box.y + box.height / 2 + (36 - view.center.y) * view.zoom);
  await panel.surface.locator('textarea').waitFor({ state: 'attached' });
  await host.page.keyboard.press('Control+A'); await host.page.keyboard.insertText('Draft committed during agent navigation');
  await call('switch_canvas', { document_id: b.id, from_document_id: a.id });
  await call('switch_canvas', { document_id: a.id, panel_id });
  await call('canvas_undo', { document_id: a.id });
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, 'Draft committed during agent navigation');
  assert.ok((await readFile(resolve(data, 'canvases', a.id + '.freecanvas'), 'utf8')).includes('Draft committed during agent navigation'));
  checks.push('A failed save blocks navigation and keeps the source graph', 'Navigation commits an active text draft before loading another document');
  await call('switch_canvas', { panel_id });
  await panel.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  const restored = await call('get_node', { document_id: a.id, id: text_id });
  assert.equal(restored.id, text_id);
  checks.push('Navigation saves changes before switching and preserves node IDs', 'Undo stays within the current document', 'Home can return to a target through an ordinary read tool');
  await failed('switch_canvas', { document_id: 'missing', panel_id }, /Unknown canvas/);
  assert.equal((await call('list_open_canvases')).panels[0].document_id, a.id);
  const second = await host.addPanel(b.id);
  const panels = (await call('list_open_canvases')).panels;
  const second_id = panels.find(p => p.document_id === b.id).panel_id;
  await failed('switch_canvas', { document_id: a.id, panel_id: second_id }, /already open/);
  assert.equal((await call('get_current_page', { document_id: b.id })).name, 'Page 1');
  await call('switch_canvas', { document_id: c.id, panel_id: second_id });
  assert.equal((await call('list_open_canvases')).panels.find(p => p.panel_id === second_id).document_id, c.id);
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, restored.characters);
  checks.push('Invalid or already claimed targets retain the source document', 'Explicit panel routing isolates multiple canvases');
  const serviceRequest = createServiceClient(origin);
  const legacy = await (await serviceRequest('/api/native', { operation: 'bootstrap' })).json();
  const legacyPanel = (await call('list_open_canvases')).panels.find(p => p.panel_id === legacy.session);
  assert.ok(legacyPanel); assert.equal(legacyPanel.navigation, false);
  await failed('switch_canvas', { document_id: c.id, panel_id: legacy.session }, /older Canvy interface/);
  await serviceRequest('/api/native', { operation: 'disconnect', session: legacy.session });
  assert.ok(!(await call('list_open_canvases')).panels.some(p => p.panel_id === legacy.session));
  checks.push('Legacy panels remain visible and report an interface upgrade instead of a false disconnection');
  await serviceRequest('/api/native', { operation: 'disconnect', session: panel_id });
  let renewed;
  for (let n = 0; n < 60; n++) {
    renewed = (await call('list_open_canvases')).panels.find(p => p.document_id === a.id && p.panel_id !== panel_id && p.navigation);
    if (renewed) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(renewed, 'The open UI must attach again after a rejected lease');
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, restored.characters);
  await call('switch_canvas', { panel_id: renewed.panel_id });
  await panel.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  await call('get_node', { document_id: a.id, id: text_id });
  checks.push('An expired session reattaches automatically without closing the panel or losing data', 'Home navigation works after automatic reconnection');
  let releaseExchange, enteredExchange;
  const entered = new Promise(r => { enteredExchange = r; });
  heldExchange = { document_id: a.id, gate: new Promise(r => { releaseExchange = r; }), entered: enteredExchange };
  await entered;
  const waitingNavigation = call('switch_canvas', { panel_id: renewed.panel_id });
  // Simulate a backgrounded panel missing the backend's actual 15-second lease.
  await new Promise(r => setTimeout(r, 16000));
  heldExchange = null; releaseExchange();
  const recoveredNavigation = await waitingNavigation;
  assert.equal(recoveredNavigation.document_id, null);
  assert.notEqual(recoveredNavigation.panel_id, renewed.panel_id);
  await panel.surface.getByRole('heading', { name: 'Your canvases' }).waitFor();
  assert.equal((await call('get_node', { document_id: a.id, id: text_id })).characters, restored.characters);
  checks.push('Navigation waiting across a real lease timeout follows the reattached panel', 'Agent panel preference survives document switching and lease recovery');
  failPersistence = true;
  await failed('canvas_set_text', { document_id: a.id, id: text_id, text: 'Keep my unsaved local draft' }, /Injected disk failure/);
  blockRecovery = true;
  const conflictPanel = (await call('list_open_canvases')).panels.find(p => p.document_id === a.id);
  await serviceRequest('/api/native', { operation: 'disconnect', session: conflictPanel.panel_id });
  const competingWriter = await (await serviceRequest('/api/native', { operation: 'bootstrap', document_id: a.id })).json();
  const newerState = JSON.parse(competingWriter.state);
  newerState.graph.nodes.value.find(([id]) => id === text_id)[1].text = 'Newer checkpoint from another writer';
  const figBackup = (await readFile(resolve(data, 'canvases', a.id + '.fig'))).toString('base64');
  const savedRemote = await serviceRequest('/api/native', { operation: 'persist', session: competingWriter.session, document_id: a.id, state: JSON.stringify(newerState), fig: figBackup });
  assert.ok(savedRemote.ok, await savedRemote.text());
  await serviceRequest('/api/native', { operation: 'disconnect', session: competingWriter.session });
  blockRecovery = false; failPersistence = false;
  await panel.surface.getByText('This canvas changed while the panel was inactive.', { exact: false }).waitFor();
  assert.equal(await panel.surface.locator('main').getAttribute('data-saved'), 'false');
  const preservedRemote = JSON.parse(await readFile(resolve(data, 'canvases', a.id + '.freecanvas'), 'utf8'));
  assert.equal(preservedRemote.graph.nodes.value.find(([id]) => id === text_id)[1].text, 'Newer checkpoint from another writer');
  checks.push('Conflicting recovery preserves the local draft and does not overwrite another writer checkpoint');
  assert.deepEqual(host.errors, []);
  await writeFile('artifacts/navigation-test.json', JSON.stringify({ status: 'PASS', host: 'OPAQUE MCP UI PROTOCOL HARNESS, NOT CODEX DESKTOP', checks, fixtureDirectory: data }, null, 2));
  console.log('PASS ' + checks.join('\nPASS '));
} finally {
  await host?.close(); await uiClient.close(); await agent.close();
  if (service.exitCode === null) { const exited = once(service, 'exit'); service.kill(); await exited; }
}
