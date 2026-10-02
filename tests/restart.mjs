import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect } from '@playwright/test';
import { nativeHarness } from './native-harness.mjs';

await mkdir('.runtime', { recursive: true });
const data = await mkdtemp(resolve('.runtime/restart-qa-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, env: { ...process.env, CANVY_PORT: String(port), CANVY_DATA_DIR: data }, stdio: 'ignore' });
const client = new Client({ name: 'restart-native-protocol-qa', version: '1' });
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
  host = await nativeHarness(client, origin, { width: 1400, height: 900 }, { nonceCsp: true });
  const document = (await call('create_canvas', { name: 'Restart QA' })).document;
  const target = { document_id: document.id }, panel = await host.addPanel(document.id);
  const imported = await call('canvas_import_react', { ...target, name: 'Restart fixture', viewports: [{ width: 600, height: 500 }, { width: 660, height: 500 }],
    files: [{ path: 'fixture.ttf', encoding: 'base64', content: (await readFile('public/Inter-Regular.ttf')).toString('base64') }, { path: 'badge.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#00aa66"/></svg>' }],
    css: '@font-face{font-family:Fixture;src:url("/fixture.ttf")}body{font:14px Fixture,sans-serif}main{padding:80px 40px}button,input{padding:8px;margin:4px}h1{font-size:22px}',
    source: `import {useState,useEffect} from 'react'; export default function Screen(){const [page,setPage]=useState('home');useEffect(()=>{document.documentElement.dataset.boot=String(Math.random())},[]);return <main><h1>{page==='home'?'Mockup Home':'Mockup Details'}</h1><img src="/badge.svg" width="32" height="32" alt="Original asset"/><input aria-label="Notes"/><button id="go" onClick={()=>{setPage('details');location.hash='details'}}>Open details</button><button id="crash" onClick={()=>{throw new Error('Canvy QA missing screen')}}>Missing screen</button><button id="reject" onClick={()=>{Promise.reject(new Error('Canvy QA rejected screen'))}}>Rejected screen</button></main>}` });
  const ids = imported.frames.map(f => f.id);
  await call('canvas_viewport_zoom_to_fit', { ...target, ids });
  const prototypes = panel.surface.locator('.inline-prototype');
  await expect(panel.surface.locator('.inline-prototype[data-ready="true"][data-error="false"]')).toHaveCount(2);
  const first = prototypes.nth(0), second = prototypes.nth(1);
  const firstFrame = first.locator('iframe').contentFrame(), secondFrame = second.locator('iframe').contentFrame();
  // Typed preview actions use DOM clicks too; our fixture controls are also
  // reached directly here at board-fit zoom without toolbar occlusion.
  for (const frame of [firstFrame, secondFrame]) {
    await frame.getByRole('button', { name: 'Open details' }).evaluate(button => button.click());
    await frame.getByRole('heading', { name: 'Mockup Details' }).waitFor();
    await frame.getByRole('textbox', { name: 'Notes' }).fill('Transient input');
  }
  const checkpoint = resolve(data, 'canvases', document.id + '.freecanvas'), before = await readFile(checkpoint, 'utf8');
  const backup = resolve(data, 'canvases', document.id + '.fig'), beforeBackup = await readFile(backup);
  const secondBoot = await secondFrame.locator('html').getAttribute('data-boot');
  const initialUrl = await first.locator('iframe').getAttribute('src');
  // A real pointer restart at low zoom; its target stays 32 CSS pixels.
  await call('canvas_viewport_set', { ...target, x: 0, y: 0, zoom: .25 });
  const restartButton = first.getByRole('button', { name: 'Restart mockup', exact: true });
  const buttonBox = await restartButton.boundingBox();
  assert.ok(Math.abs(buttonBox.width - 32) < 1 && Math.abs(buttonBox.height - 32) < 1);
  await restartButton.click();
  await first.locator('iframe').contentFrame().getByRole('heading', { name: 'Mockup Home' }).waitFor();
  await expect(first).toHaveAttribute('data-ready', 'true');
  assert.equal(await firstFrame.getByRole('textbox', { name: 'Notes' }).inputValue(), '');
  assert.equal(await firstFrame.locator('html').evaluate(() => location.hash), '');
  assert.equal(await first.locator('iframe').getAttribute('src'), initialUrl);
  await call('canvas_viewport_zoom_to_fit', { ...target, ids });
  assert.equal(await secondFrame.locator('html').getAttribute('data-boot'), secondBoot);
  assert.equal(await secondFrame.getByRole('textbox', { name: 'Notes' }).inputValue(), 'Transient input');
  await secondFrame.getByRole('heading', { name: 'Mockup Details' }).waitFor();
  checks.push('A normal restart at 25% zoom returns to Home, clears navigation/form state and leaves the other prototype intact');
  for (const [button, error] of [['Missing screen', 'Canvy QA missing screen'], ['Rejected screen', 'Canvy QA rejected screen']]) {
    if (button === 'Missing screen') await call('canvas_viewport_set', { ...target, x: 0, y: 0, zoom: .25 });
    else await call('canvas_viewport_zoom_to_fit', { ...target, ids });
    await firstFrame.getByRole('button', { name: button }).evaluate(element => element.click());
    await first.getByText('Mockup stopped', { exact: true }).waitFor();
    await first.getByText(error, { exact: false }).waitFor();
    if (button === 'Missing screen') await host.page.screenshot({ path: 'artifacts/restart-error.png' });
    await first.locator('.prototype-status').getByRole('button', { name: 'Restart mockup' }).click();
    await expect(first).toHaveAttribute('data-error', 'false');
    await expect(first).toHaveAttribute('data-ready', 'true');
    await firstFrame.getByRole('heading', { name: 'Mockup Home' }).waitFor();
    assert.equal(await firstFrame.getByRole('img', { name: 'Original asset' }).evaluate(image => image.complete && image.naturalWidth === 32), true);
    assert.equal(await firstFrame.locator('html').evaluate(() => document.fonts.check('14px Fixture')), true);
  }
  checks.push('Uncaught errors and rejected promises show a recoverable error with Restart mockup; original images/fonts reload under inherited nonce CSP');
  await call('canvas_preview_import', { ...target, frame_id: ids[0] });
  const preview = panel.surface.getByRole('dialog', { name: 'Interactive prototype' });
  await call('canvas_preview_action', { ...target, action: 'click', selector: '#go' });
  const previewFrame = preview.locator('iframe').contentFrame();
  await previewFrame.getByRole('heading', { name: 'Mockup Details' }).waitFor();
  await preview.getByRole('button', { name: 'Restart mockup' }).click();
  await previewFrame.getByRole('heading', { name: 'Mockup Home' }).waitFor();
  assert.ok((await call('canvas_preview_action', { ...target, action: 'snapshot' })).text.includes('Mockup Home'));
  // Simulate an in-flight preview action that never acknowledged. A human
  // restart must cancel it, never execute it again in the fresh browsing context.
  await previewFrame.locator('html').evaluate(() => {
    // Let the click execute but hold both paths that acknowledge its settling.
    // This produces an uncertain response, rather than assuming window message
    // listeners run before the bridge's listener on every browser.
    window.requestAnimationFrame = () => 0;
    const originalTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => delay === 100 ? 0 : originalTimeout(callback, delay, ...args);
    addEventListener('message', event => {
      if (event.source === parent && event.data?.channel === 'canvy-prototype-v1' && event.data.action === 'click') {
        document.documentElement.dataset.pendingAction = 'true';
      }
    }, true);
  });
  const pendingAction = client.callTool({ name: 'canvas_preview_action', arguments: { ...target, action: 'click', selector: '#go' } });
  await expect(previewFrame.locator('html')).toHaveAttribute('data-pending-action', 'true');
  await preview.getByRole('button', { name: 'Restart mockup' }).click();
  const cancelled = await pendingAction;
  assert.equal(cancelled.isError, true);
  assert.match(JSON.stringify(cancelled.content), /Preview closed/);
  await previewFrame.getByRole('heading', { name: 'Mockup Home' }).waitFor();
  assert.ok((await call('canvas_preview_action', { ...target, action: 'snapshot' })).text.includes('Mockup Home'));
  await call('canvas_preview_action', { ...target, action: 'click', selector: '#crash' });
  await preview.getByText('Canvy QA missing screen', { exact: false }).waitFor();
  await preview.getByRole('button', { name: 'Restart mockup' }).click();
  await previewFrame.getByRole('heading', { name: 'Mockup Home' }).waitFor();
  await call('canvas_preview_action', { ...target, action: 'close' });
  assert.equal(await readFile(checkpoint, 'utf8'), before, 'Restart is transient, not a design edit or persistence write');
  assert.deepEqual(await readFile(backup), beforeBackup);
  assert.equal(await secondFrame.locator('html').getAttribute('data-boot'), secondBoot);
  checks.push('Focused preview restarts after navigation and a crash; its bridge reattaches; pending actions cancel without replay; checkpoint and fig bytes remain unchanged');
  assert.ok(host.errors.some(error => error === 'Canvy QA missing screen'));
  assert.ok(host.errors.some(error => error === 'Canvy QA rejected screen'));
  assert.deepEqual(host.errors.filter(error => !['Canvy QA missing screen', 'Canvy QA rejected screen'].includes(error)), []);
  await writeFile('artifacts/restart-report.json', JSON.stringify({ harness: 'Opaque MCP App protocol harness, not actual Codex desktop pointer validation', checks, expectedErrors: host.errors }, null, 2));
  console.log(`Restart mockup protocol QA passed: ${checks.length} checks`);
} finally { await host?.close().catch(() => {}); await client.close().catch(() => {}); service.kill(); }
