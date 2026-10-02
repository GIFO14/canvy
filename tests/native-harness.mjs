import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
export async function nativeHarness(client, origin, viewport = { width: 1200, height: 900 }, { interceptTool, nonceCsp = false } = {}) {
  await mkdir('artifacts', { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.CANVY_BROWSER_CHANNEL ? { channel: process.env.CANVY_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport, locale: 'es-ES' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const sessions = new Set();
  await page.exposeFunction('serverTool', async params => {
    const result = await interceptTool?.(params) ?? await client.callTool(params);
    if (params.name === '_canvas_bootstrap' && result.structuredContent?.session) sessions.add(result.structuredContent.session);
    if (params.name === '_canvas_disconnect') sessions.delete(params.arguments.session);
    return result;
  });
  const tools = await client.listTools();
  const uri = tools.tools.find(tool => tool.name === 'open_canvas')._meta.ui.resourceUri;
  const resource = await client.readResource({ uri });
  const nonce = 'canvy-native-qa';
  const csp = "default-src 'none'; script-src 'nonce-" + nonce + "' blob: 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src blob:; font-src blob:; connect-src 'none'; frame-src 'self' blob:; worker-src blob:";
  await page.route(origin + '/native-test', route => route.fulfill({ contentType: 'text/html', ...(nonceCsp ? { headers: { 'Content-Security-Policy': csp } } : {}), body: `<!doctype html><html><style>html,body{margin:0;height:100%;background:#2b2b2b}iframe{width:100%;height:100%;border:0;position:absolute;inset:0}</style><body><script nonce="${nonce}">
    window.nativeMessages=[];window.nativeContexts=[];
    window.addEventListener('message',async e=>{
      const frame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow===e.source);
      if(!frame||e.data?.jsonrpc!=='2.0')return;
      const m=e.data;let result;
      if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Native protocol QA, not Codex',version:'1'},hostCapabilities:{serverTools:{},message:{text:{}},updateModelContext:{text:{},structuredContent:{}}},hostContext:{theme:'dark',displayMode:'fullscreen'}};
      else if(m.method==='tools/call')result=await window.serverTool(m.params);
      else if(m.method==='ui/update-model-context'){window.nativeContexts.push(m.params);result={};}
      else if(m.method==='ui/message'){window.nativeMessages.push(m.params);result=window.rejectMessages?{isError:true}:{};}
      else return;
      e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
      if(m.method==='ui/initialize' && frame.dataset.document) e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{document_id:frame.dataset.document}}},'*');
    });
  </script></body></html>` }));
  await page.goto(origin + '/native-test');
  let count = 0;
  async function addPanel(document_id, { collapsed = false, visualEdits = false, readyTimeout = 30000 } = {}) {
    const id = `canvas${++count}`;
    await page.evaluate(({ id, html, document_id, collapsed }) => {
      for (const frame of document.querySelectorAll('iframe')) frame.style.visibility = 'hidden';
      const frame = document.createElement('iframe'); frame.id = id;
      if (collapsed) { frame.style.width = '0px'; frame.style.height = '0px'; }
      frame.setAttribute('sandbox', 'allow-scripts allow-forms');
      if (document_id) frame.dataset.document = document_id;
      frame.srcdoc = html; document.body.append(frame);
    }, { id, html: nonceCsp ? resource.contents[0].text.replace('<script>', `<script nonce="${nonce}">`) : resource.contents[0].text, document_id, collapsed });
    const surface = page.frameLocator('#' + id);
    await surface.locator('main[data-connected="true"][data-ready="true"]').waitFor({ state: 'attached', timeout: readyTimeout });
    if (visualEdits) { await surface.getByRole('button', { name: 'Visual edits', exact: true }).click(); await surface.locator('main[data-mode="visual"]').waitFor(); }
    return { id, surface };
  }
  async function show(id) { await page.evaluate(id => { for (const frame of document.querySelectorAll('iframe')) frame.style.visibility = frame.id === id ? 'visible' : 'hidden'; }, id); }
  async function close() {
    for (const session of sessions) await client.callTool({ name: '_canvas_disconnect', arguments: { session } }).catch(() => {});
    await browser.close();
  }
  return { page, addPanel, show, close, errors };
}
