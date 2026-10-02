import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { nativeHarness } from './native-harness.mjs';
import { expect } from '@playwright/test';

await mkdir('.runtime', { recursive: true });
const data = await mkdtemp(resolve('.runtime/interaction-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
const client = new Client({ name: 'interaction-native-protocol-qa', version: '1' });
let host;
const checks = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 90000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  for (let n = 0; n < 100; n++) { if (await fetch(origin + '/health').then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 50)); }
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  host = await nativeHarness(client, origin, undefined, { nonceCsp: true });
  const document = (await call('create_canvas', { name: 'Interaction modes QA' })).document;
  const target = { document_id: document.id };
  const panel = await host.addPanel(document.id);
  await panel.surface.locator('main[data-mode="interact"]').waitFor();
  assert.equal((await call('canvas_status', target)).ui_release, '0.5.5');
  const imported = await call('canvas_import_react', { ...target, name: 'Menu demo', viewports: [{ width: 600, height: 500 }], css: 'body{margin:0;font:16px sans-serif}main{padding:80px;background:#fff;height:500px;box-sizing:border-box}button,input{padding:12px}aside{margin-top:20px;background:#eef;padding:20px}', source: `import {useState} from 'react'; export default function Screen(){const [open,setOpen]=useState(false);return <main><button id="menu" onClick={()=>setOpen(!open)}>Open menu</button><input aria-label="Notes" placeholder="Notes"/>{open&&<aside role="dialog">Menu is open<button id="close" onClick={()=>setOpen(false)}>Close menu</button></aside>}</main>}` });
  const frameId = imported.frames[0].id;
  await call('canvas_viewport_zoom_to_fit', { ...target, ids: [frameId] });
  const frame = panel.surface.frameLocator('iframe[title^="Interactive mockup:"]');
  const menu = frame.getByRole('button', { name: 'Open menu', exact: true });
  await panel.surface.locator('.inline-prototype[data-ready="true"][data-error="false"]').waitFor();
  assert.equal(await panel.surface.locator('iframe[title^="Interactive mockup:"]').getAttribute('sandbox'), 'allow-scripts');
  const checkpointPath = resolve(data, 'canvases', document.id + '.freecanvas');
  const before = await readFile(checkpointPath, 'utf8');
  await menu.click(); await frame.getByRole('dialog').waitFor();
  await frame.getByRole('textbox', { name: 'Notes' }).fill('Words with spaces');
  await host.page.keyboard.press('Space');
  assert.equal(await frame.getByRole('textbox', { name: 'Notes' }).inputValue(), 'Words with spaces ');
  assert.equal(await readFile(checkpointPath, 'utf8'), before);
  checks.push('Fresh panels default to Interact; a direct mockup click opens a React menu under inherited nonce CSP', 'React form spaces work and transient interactions do not modify the checkpoint', 'Inline prototypes retain the opaque script-only sandbox');

  const canvas = panel.surface.getByTestId('design-canvas');
  const hand = panel.surface.getByRole('button', { name: 'Pan canvas', exact: true });
  const initialNode = await call('get_node', { ...target, id: frameId });
  for (let attempt = 0; attempt < 2; attempt++) {
    await menu.focus();
    const initial = await call('canvas_viewport_get', target);
    await host.page.keyboard.down('Space');
    await expect(hand).toHaveClass(/active/);
    const box = await canvas.boundingBox();
    await host.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await host.page.mouse.down(); await host.page.mouse.move(box.x + box.width / 2 + 55, box.y + box.height / 2 + 35, { steps: 8 }); await host.page.mouse.up();
    await host.page.keyboard.up('Space');
    await expect(hand).not.toHaveClass(/active/);
    const moved = await call('canvas_viewport_get', target);
    assert.ok(Math.abs(moved.center.x - initial.center.x) > 10, 'Focused React frame must hand Space pan to the canvas');
  }
  const afterPan = await call('get_node', { ...target, id: frameId });
  assert.deepEqual([afterPan.x, afterPan.y], [initialNode.x, initialNode.y]);
  checks.push('Repeated Space + left drag works from a focused prototype without moving nodes');

  await panel.surface.getByRole('button', { name: 'Visual edits', exact: true }).click();
  await panel.surface.locator('main[data-mode="visual"]').waitFor();
  assert.equal(await panel.surface.locator('iframe[title^="Interactive mockup:"]').isVisible(), false);
  await call('canvas_select_nodes', { ...target, ids: [frameId] });
  await call('canvas_viewport_zoom_to_fit', { ...target, ids: [frameId] });
  const box = await canvas.boundingBox(), view = await call('canvas_viewport_get', target);
  // Drag the screen title: imported main containers cover its whole interior.
  const point = { x: box.x + box.width / 2 + (initialNode.x - view.center.x) * view.zoom + 30, y: box.y + box.height / 2 + (initialNode.y - view.center.y) * view.zoom - 8 };
  await host.page.mouse.move(point.x, point.y); await host.page.mouse.down(); await host.page.mouse.move(point.x + 45, point.y + 25, { steps: 8 }); await host.page.mouse.up();
  const movedNode = await call('get_node', { ...target, id: frameId });
  assert.ok(Math.abs(movedNode.x - initialNode.x) > 5);
  await panel.surface.locator('main[data-saved="true"][data-save-error="false"]').waitFor();
  assert.notEqual(await readFile(checkpointPath, 'utf8'), before);
  checks.push('Visual edits exposes real native frame dragging and saves automatically');

  await panel.surface.getByRole('button', { name: 'Interact', exact: true }).click();
  await panel.surface.locator('main[data-mode="interact"]').waitFor();
  await frame.getByRole('dialog').waitFor();
  await call('canvas_select_nodes', { ...target, ids: [frameId] });
  await canvas.focus(); await host.page.keyboard.press('Delete'); await host.page.keyboard.press('Control+z');
  const unchanged = await call('get_node', { ...target, id: frameId });
  assert.deepEqual([unchanged.x, unchanged.y], [movedNode.x, movedNode.y]);
  await frame.getByRole('button', { name: 'Close menu', exact: true }).click();
  await frame.getByRole('dialog').waitFor({ state: 'detached' });
  checks.push('Switching modes keeps an onscreen prototype state; Interact blocks native Delete and Undo');
  assert.deepEqual(host.errors, []);
  await writeFile('artifacts/interaction-report.json', JSON.stringify({ harness: 'Opaque MCP App protocol harness, not the actual Codex host', checks, errors: host.errors }, null, 2));
  console.log(`Interaction mode protocol QA passed: ${checks.length} checks`);
} finally { await host?.close().catch(() => {}); await client.close().catch(() => {}); service.kill(); }
