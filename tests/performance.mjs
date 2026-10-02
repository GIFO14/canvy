import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SceneGraph } from '@open-pencil/scene-graph';
import { expect } from '@playwright/test';
import { createDocumentStore } from '../server/documents.mjs';
import { compileFrontend } from '../server/frontend-import.mjs';
import { encodeDocument, decodeDocument } from '../src/document-state.js';
import { nativeHarness } from './native-harness.mjs';
import { waitForService } from './service-ready.mjs';

// Synthetic public fixture: no user's design, checkpoint or screenshot is used.
await mkdir('.runtime', { recursive: true });
const data = await mkdtemp(resolve('.runtime/performance-qa-'));
const store = await createDocumentStore(data), document = await store.create('Heavy interactive board');
const graph = new SceneGraph(), pageId = graph.getPages()[0].id;
const fill = (r, g, b) => [{ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true }];
const frames = [];
for (let n = 0; n < 12; n++) {
  const frame = graph.createNode('FRAME', pageId, { name: `Board ${n + 1}`, x: n % 4 * 740, y: Math.floor(n / 4) * 680, width: 660, height: 600, clipsContent: true, fills: fill(1, 1, 1) });
  frames.push({ id: frame.id, viewport: { width: 660, height: 600 } });
  for (let row = 0; row < 60; row++) for (let col = 0; col < 7; col++) {
    graph.createNode('RECTANGLE', frame.id, { name: 'Table cell', x: col * 90 + 15, y: row * 8 + 80, width: 75, height: 5, fills: fill(.8, .85, .9) });
  }
}
const marker = graph.createNode('RECTANGLE', pageId, { name: 'Cache invalidation marker', x: 0, y: 3000, width: 240, height: 100, fills: fill(1, 0, 1) });
const compiled = await compileFrontend({ source: `import {useState,useEffect} from 'react';
export default function Screen(){const[open,setOpen]=useState(false);useEffect(()=>{document.documentElement.dataset.boot=String(Math.random())},[]);return <main><button onClick={()=>setOpen(!open)}>Open menu</button><input aria-label="Notes"/>{open&&<aside role="dialog">Independent menu</aside>}<table><tbody>{Array.from({length:60},(_,row)=><tr key={row}>{Array.from({length:7},(_,col)=><td key={col} style={{padding:3,color:'#235',borderBottom:'1px solid #ddd'}}>Cell {row}:{col}</td>)}</tr>)}</tbody></table></main>}`,
  css: 'body{font:12px sans-serif}main{padding:80px 16px 16px}button,input{padding:8px}aside{padding:10px;background:#def}table{width:100%}' });
graph.canvyResources = { fonts: {}, imports: { fixture: { name: 'Dense table', html: compiled.html, frames, assets: [], originals: [], issues: [] } } };
const path = resolve(data, 'canvases', document.id + '.freecanvas');
await writeFile(path, encodeDocument(graph));
const before = await readFile(path, 'utf8');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
const client = new Client({ name: 'performance-native-protocol-qa', version: '1' });
let host;
const checks = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { document_id: document.id, ...args } }, { timeout: 90000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  await waitForService(origin, service);
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  host = await nativeHarness(client, origin, { width: 1400, height: 900 }, { nonceCsp: true });
  const panel = await host.addPanel(document.id), canvas = panel.surface.getByTestId('design-canvas');
  const fit = () => call('canvas_viewport_zoom_to_fit', { ids: frames.map(f => f.id) });
  const prototypes = panel.surface.locator('.inline-prototype'), iframes = prototypes.locator('iframe');
  await fit();
  await expect(panel.surface.locator('.inline-prototype[data-ready="true"][data-error="false"]')).toHaveCount(12, { timeout: 60000 });
  const sources = await iframes.evaluateAll(elements => elements.map(e => e.src));
  assert.equal(new Set(sources).size, 1, 'Identical responsive variants share one prepared HTML blob');
  await expect(canvas).toHaveAttribute('data-scene-cache', 'true');
  const first = iframes.nth(0).contentFrame(), second = iframes.nth(1).contentFrame();
  // Translate the child control's CSS coordinates through the canvas camera.
  // This checks pointer hit testing at board-fit zoom, away from the floating
  // editor controls. Supplied prototypes have no access to editor state.
  const camera = await call('canvas_viewport_get'), canvasBox = await canvas.boundingBox();
  const control = await first.getByRole('button', { name: 'Open menu' }).evaluate(button => {
    const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await host.page.mouse.click(canvasBox.x + canvasBox.width / 2 + (control.x - camera.center.x) * camera.zoom, canvasBox.y + canvasBox.height / 2 + (control.y - camera.center.y) * camera.zoom);
  await first.getByRole('dialog').waitFor();
  await first.getByRole('textbox', { name: 'Notes' }).fill('Retained input');
  assert.equal(await second.getByRole('dialog').count(), 0);
  const boot = await first.locator('html').getAttribute('data-boot');
  checks.push('5,055 native nodes and twelve dense React tables load under inherited nonce CSP', 'Identical bundles share an HTML resource while each prototype keeps independent React state');

  await canvas.focus(); await host.page.keyboard.down('Space');
  await prototypes.first().evaluate(() => {
    window.__performanceMutations = { child: 0, world: 0 };
    window.__performanceObserver = new MutationObserver(records => { for (const r of records) if (r.type === 'attributes' && r.attributeName === 'style') window.__performanceMutations[r.target.classList.contains('interaction-world') ? 'world' : 'child']++; });
    window.__performanceObserver.observe(document.querySelector('.interaction-world'), { attributes: true, subtree: true, attributeFilter: ['style'] });
  });
  const box = await canvas.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await host.page.mouse.move(x, y); await host.page.mouse.down();
  await host.page.mouse.move(x + 50, y + 20, { steps: 20 });
  await host.page.mouse.move(x, y, { steps: 20 });
  const mutations = await prototypes.first().evaluate(() => { window.__performanceObserver.disconnect(); return window.__performanceMutations; });
  assert.ok(mutations.world > 0, 'Camera updates the shared transform');
  assert.equal(mutations.child, 0, 'Pan must not rewrite every frame or its React DOM');
  await host.page.mouse.up(); await host.page.keyboard.up('Space');
  assert.equal(await first.locator('html').getAttribute('data-boot'), boot, 'No iframe reboot during navigation');
  await first.getByRole('dialog').waitFor();
  assert.equal(await first.getByRole('textbox', { name: 'Notes' }).inputValue(), 'Retained input');
  assert.equal(await readFile(path, 'utf8'), before, 'Navigation and prototype state must not save design edits');
  checks.push('Space-drag changes only the shared transform; iframe boot, menu and form state survive; checkpoints remain unchanged');

  async function markerPixel() {
    const view = await call('canvas_viewport_get');
    return canvas.evaluate((element, { view }) => {
      const copy = document.createElement('canvas'); copy.width = element.width; copy.height = element.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(element, 0, 0);
      const x = (element.clientWidth / 2 + (120 - view.center.x) * view.zoom) * element.width / element.clientWidth;
      const y = (element.clientHeight / 2 + (3050 - view.center.y) * view.zoom) * element.height / element.clientHeight;
      return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    }, { view });
  }
  await call('canvas_viewport_zoom_to_fit', { ids: [marker.id] });
  await expect(prototypes).toHaveCount(0);
  await expect.poll(markerPixel).toEqual([255, 0, 255, 255]);
  await call('canvas_set_fill', { id: marker.id, color: '#00ff00' });
  await expect.poll(markerPixel).toEqual([0, 255, 0, 255]);
  await call('canvas_viewport_set', { x: 100, y: 3060, zoom: .7 });
  await expect.poll(markerPixel).toEqual([0, 255, 0, 255]);
  const saved = decodeDocument(await readFile(path, 'utf8'));
  assert.deepEqual([...saved.nodes.keys()].sort(), [...graph.nodes.keys()].sort());
  assert.equal(saved.canvyResources.imports.fixture.html, compiled.html);
  checks.push('Retained backing invalidates an agent fill edit, redraws after zoom, and preserves all node IDs and source bytes');

  await fit(); await expect(prototypes).toHaveCount(12);
  await expect(panel.surface.locator('.inline-prototype[data-ready="true"][data-error="false"]')).toHaveCount(12, { timeout: 60000 });
  assert.notEqual(await iframes.first().getAttribute('src'), sources[0], 'Last unmount releases the shared document resource');
  await panel.surface.getByRole('button', { name: 'Visual edits', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-scene-cache', 'false');
  await panel.surface.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-scene-cache', 'true');
  await panel.surface.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await expect(prototypes).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-scene-cache', 'false');
  checks.push('Offscreen prototypes release shared resources; Visual edits bypasses the cache; Home releases iframe and scene backing');
  assert.deepEqual(host.errors, []);
  await writeFile('artifacts/performance-report.json', JSON.stringify({ harness: 'Opaque MCP App protocol harness, not the actual Codex host', native_nodes: graph.nodes.size, prototypes: 12, mutations, checks, errors: host.errors }, null, 2));
  console.log(`Performance protocol QA passed: ${checks.length} checks`);
} finally { await host?.close().catch(() => {}); await client.close().catch(() => {}); service.kill(); }
