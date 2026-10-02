import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { nativeHarness } from './native-harness.mjs';
import { waitForService } from './service-ready.mjs';

const data = await mkdtemp(resolve('.runtime/space-pan-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
const client = new Client({ name: 'space-pan-native-qa', version: '1' });
let host;
const checks = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
function sameView(a, b) {
  assert.ok(Math.abs(a.center.x - b.center.x) < 0.01);
  assert.ok(Math.abs(a.center.y - b.center.y) < 0.01);
  assert.equal(a.zoom, b.zoom);
}
try {
  await waitForService(origin, service);
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  host = await nativeHarness(client, origin);
  const doc = (await call('create_canvas', { name: 'Space pan QA' })).document;
  const panel = await host.addPanel(doc.id, { visualEdits: true });
  const args = { document_id: doc.id };
  const shape = await call('canvas_render', { ...args, jsx: '<Frame name="Unmoved mockup" w={400} h={220} bg="#ffffff"><Text name="Editable text" x={24} y={24} w={350} h={40} fontSize={20}>Editable text</Text></Frame>' });
  const canvas = panel.surface.getByTestId('design-canvas');
  const select = panel.surface.getByRole('button', { name: 'Select', exact: true });
  const hand = panel.surface.getByRole('button', { name: 'Pan canvas', exact: true });
  const view = () => call('canvas_viewport_get', args);
  const node = () => call('get_node', { ...args, id: shape.id });
  const focus = () => canvas.focus();
  const expectSelect = async () => assert.match(await select.getAttribute('class'), /active/);
  const cursor = () => canvas.evaluate(el => getComputedStyle(el).cursor);
  const position = async (x = 200, y = 120) => {
    const v = await view(), box = await canvas.boundingBox();
    return { x: box.x + box.width / 2 + (x - v.center.x) * v.zoom, y: box.y + box.height / 2 + (y - v.center.y) * v.zoom };
  };
  async function pan(dx, dy, releaseBeforeMouse = false) {
    await focus();
    const v = await view(), p = await position();
    await host.page.keyboard.down('Space');
    assert.equal(await cursor(), 'grab');
    await host.page.mouse.move(p.x, p.y); await host.page.mouse.down();
    await host.page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
    assert.equal(await cursor(), 'grabbing');
    const moved = await view();
    assert.ok(Math.abs(moved.center.x - (v.center.x - dx / v.zoom)) < 0.01);
    assert.ok(Math.abs(moved.center.y - (v.center.y - dy / v.zoom)) < 0.01);
    if (releaseBeforeMouse) {
      await host.page.keyboard.up('Space');
      await host.page.mouse.move(p.x + dx + 45, p.y + dy + 35, { steps: 4 });
      sameView(moved, await view());
      await host.page.mouse.up();
    } else { await host.page.mouse.up(); await host.page.keyboard.up('Space'); }
    await expectSelect();
  }
  await call('canvas_viewport_zoom_to_fit', { ...args, ids: [shape.id] });
  const initial = await node();
  await pan(130, 75);
  assert.deepEqual(await node(), initial);
  await pan(-80, -45, true);
  assert.deepEqual(await node(), initial);
  checks.push('Space + left drag pans over a mockup without changing nodes', 'Releasing Space before the mouse stops panning and restores Select', 'Grab and grabbing cursors reflect the gesture');

  await hand.click(); await focus();
  await host.page.keyboard.down('Space'); await host.page.keyboard.down('Space'); await host.page.keyboard.up('Space');
  assert.match(await hand.getAttribute('class'), /active/);
  await select.click();
  await select.focus();
  await host.page.keyboard.down('Space'); await host.page.keyboard.up('Space');
  await expectSelect();
  checks.push('Repeated Space preserves the previously selected Hand tool', 'Space does not activate a focused toolbar button');

  await focus(); await host.page.keyboard.down('Space');
  await host.page.evaluate(() => { document.body.tabIndex = 0; document.body.focus(); });
  await expectSelect(); await host.page.keyboard.up('Space');
  checks.push('Losing iframe focus restores Select without requiring a keyup');

  await call('canvas_viewport_zoom_to_fit', { ...args, ids: [shape.id] });
  const textPoint = await position(110, 40);
  await host.page.mouse.dblclick(textPoint.x, textPoint.y);
  await panel.surface.locator('textarea').waitFor({ state: 'attached' });
  await host.page.keyboard.press('Control+A');
  await host.page.keyboard.type('Words with spaces');
  await expectSelect();
  await call('save_document', args);
  assert.equal((await call('get_node', { ...args, id: shape.children[0] })).characters, 'Words with spaces');
  checks.push('Spaces remain ordinary characters while editing mockup text');

  await focus(); await host.page.keyboard.down('Space');
  const listing = await call('list_open_canvases');
  await call('switch_canvas', { panel_id: listing.panels[0].panel_id });
  await host.page.keyboard.up('Space');
  const name = panel.surface.getByRole('textbox', { name: 'New canvas name' });
  await name.fill('Name'); await name.press('End'); await name.press('Space');
  assert.equal(await name.inputValue(), 'Name ');
  await call('switch_canvas', { ...args, panel_id: listing.panels[0].panel_id });
  await expectSelect();
  checks.push('Home navigation cancels temporary panning; form inputs accept spaces');

  // After release the ordinary left drag still moves a mockup, rather than panning.
  await call('canvas_viewport_zoom_to_fit', { ...args, ids: [shape.id] });
  const before = await node(), v = await view(), p = await position();
  await host.page.mouse.move(p.x, p.y); await host.page.mouse.down();
  await host.page.mouse.move(p.x + 35, p.y + 20, { steps: 8 }); await host.page.mouse.up();
  const after = await node();
  assert.ok(Math.abs(after.x - before.x - 35 / v.zoom) < 1);
  assert.ok(Math.abs(after.y - before.y - 20 / v.zoom) < 1);
  sameView(v, await view());
  checks.push('Ordinary mockup dragging works after Space is released');
  assert.deepEqual(host.errors, []);
  const report = { pass: true, scope: 'Opaque native MCP App protocol harness; not an actual Codex pointer test', checks };
  await writeFile('artifacts/space-pan-test.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await host?.close(); await client.close(); service.kill(); }
