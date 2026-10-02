import { randomUUID, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { WebSocketServer } from 'ws';
import { createMcp } from './tools.mjs';
import { createDocumentStore } from './documents.mjs';
import { createPanelNavigator } from './panel-navigation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CANVY_PORT ?? process.env.FREECANVAS_PORT ?? 4318);
const origin = `http://127.0.0.1:${port}`;
const runtime = resolve(process.env.CANVY_DATA_DIR ?? process.env.FREECANVAS_DATA_DIR ?? resolve(root, '.runtime'));
const documents = await createDocumentStore(runtime);
// Browser requests are restricted to this app's own origin. No public listener or wildcard CORS.
const allowedOrigins = new Set([origin, 'http://127.0.0.1:4317']);
const bridgeToken = randomBytes(32).toString('hex');
// One navigator per backend lets different Codex chats work with the same
// global panel, even when their stdio connectors are separate processes.
const panelNavigator = createPanelNavigator(async (operation, args) => {
  const response = await app.request('/api/native', { method: 'POST', headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, ...args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Native canvas request failed');
  return result;
});
let browser = null;
const nativeCanvases = new Map();
const liveNative = () => [...nativeCanvases.values()].filter(s => Date.now() - s.seen < 15000);
const pending = new Map();
// Mark deletions before any async work so a simultaneous open cannot acquire
// a writer between the guard and the catalogue commit.
const deleting = new Set();
function assertOpenable(id) {
  if (deleting.has(id) || !documents.isActive(id)) throw new Error('This canvas is in Trash or is being deleted. Restore it from Home before opening it.');
}
async function library(body) {
  if (body.operation === 'list') return { documents: documents.list(), trash: documents.trash(), capabilities: { trash: true } };
  if (body.operation === 'create') return { document: await documents.create(body.name) };
  if (body.operation === 'rename') return { document: await documents.rename(body.document_id, body.name) };
  if (body.operation === 'restore') return { document: await documents.restore(body.document_id) };
  if (body.operation === 'delete') {
    const id = body.document_id;
    if (deleting.has(id)) throw new Error('This canvas is already being deleted');
    deleting.add(id);
    try {
      const validate = () => {
        const writers = [...nativeCanvases.values()].filter(s => s.document_id === id);
        if (id === 'freecanvas' && browser?.readyState === 1 || writers.some(s => Date.now() - s.seen < 15000 || s.requests.some(r => pending.has(r.id)) || [...pending.values()].some(p => p.session === s.id))) {
          throw new Error('This canvas is open in another panel. Return that panel to Home or close it before deleting.');
        }
      };
      return { document: await documents.delete(id, validate) };
    } finally { deleting.delete(id); }
  }
  throw new Error('Unknown library operation');
}
export async function sendRPC(body) {
  const target = body.args?.document_id;
  const surfaces = liveNative().filter(s => s.document_id && (!target || s.document_id === target));
  if (browser?.readyState === 1 && (!target || target === 'freecanvas')) surfaces.push({ browser, document_id: 'freecanvas' });
  if (!surfaces.length) throw new Error('Canvas disconnected. Open the requested canvas from Canvy Home first.');
  if (surfaces.length !== 1) throw new Error('Multiple canvases are open. Specify document_id to target the intended canvas.');
  const surface = surfaces[0];
  const id = randomUUID();
  return new Promise((resolveRPC, reject) => {
    const timeout = body.command === 'canvy_import_frontend' ? 120000 : 30000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Canvas request timed out; its outcome is uncertain. Inspect the document before retrying.')); }, timeout);
    pending.set(id, { resolve: resolveRPC, reject, timer, session: surface.id });
    const request = { id, ...body, deadline: Date.now() + timeout, args: { ...body.args, document_id: surface.document_id } };
    if (surface.browser) surface.browser.send(JSON.stringify(request));
    else surface.requests.push(request);
  });
}
const app = new Hono();
app.use('*', async (c, next) => {
  const suppliedOrigin = c.req.header('origin');
  if (suppliedOrigin && !allowedOrigins.has(suppliedOrigin)) return c.json({ error: 'Origin rejected' }, 403);
  const host = c.req.header('host');
  if (host && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return c.json({ error: 'Host rejected' }, 403);
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
// Retained launchers match this legacy version exactly. Keep the compatible
// service identity stable; release and feature negotiation carry newer behavior.
app.get('/health', (c) => c.json({ name: 'canvy', version: '0.5.4', release: '0.5.8', pid: process.pid, connected: browser?.readyState === 1 || liveNative().length > 0, url: origin }));
app.post('/api/diagnostics', async c => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  const { document_id } = await c.req.json();
  const live = liveNative();
  const open = live.filter(s => s.document_id).map(s => s.document_id);
  if (browser?.readyState === 1) open.push('freecanvas');
  const selected = document_id ? open.filter(id => id === document_id) : open;
  const connection_state = selected.length === 1 ? 'document_connected' : selected.length > 1 ? 'multiple_documents_connected' : live.length ? 'home_connected' : 'panel_not_connected';
  return c.json({ version: '0.5.8', document_id: document_id ?? (selected.length === 1 ? selected[0] : null), connection_state, native_panels: live.length, open_documents: open, requested_document_connected: selected.length === 1, guidance: selected.length === 1 ? null : selected.length > 1 ? 'Specify document_id.' : document_id ? 'Open this document from the native Canvy Home. An opening acknowledgement alone does not attach a panel.' : 'Open and expand the native Canvy panel in Codex.', limits: { save_bytes: 32 * 1024 * 1024, reversible_structure_nodes_and_variables: 10000, rpc_timeout_ms: 30000, import_timeout_ms: 120000, native_panels: 32 } });
});
app.get('/api/bootstrap', async (c) => {
  return c.json({ token: bridgeToken, ...(documents.isActive('freecanvas') ? await documents.read('freecanvas') : { document: null, state: null, saved: null }), documents: documents.list() });
});
app.put('/api/document', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  const size = Number(c.req.header('content-length') ?? 0);
  if (size > 32 * 1024 * 1024) return c.json({ error: 'Document too large' }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > 32 * 1024 * 1024) return c.json({ error: 'Document too large' }, 413);
  let envelope;
  if (c.req.header('content-type') === 'application/json') {
    envelope = JSON.parse(new TextDecoder().decode(body));
    if (envelope.version !== 1 || typeof envelope.state !== 'string' || typeof envelope.fig !== 'string') return c.json({ error: 'Invalid document' }, 400);
    if (JSON.parse(envelope.state).version !== 1) return c.json({ error: 'Unsupported document' }, 400);
  }
  if (!envelope) return c.json({ error: 'Checkpoint required' }, 400);
  return c.json(await documents.save(envelope.document_id ?? 'freecanvas', envelope.state, envelope.fig));
});
app.post('/api/library', async c => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json();
  try {
    return c.json(await library(body));
  } catch (e) { return c.json({ error: e.message }, 400); }
});
app.post('/api/rpc', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  try { return c.json(await sendRPC(await c.req.json())); } catch (error) { return c.json({ error: error.message }, 503); }
});
app.post('/api/panels', async c => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  const { operation, ...args } = await c.req.json();
  try {
    if (operation === 'list') return c.json({ panels: panelNavigator.list(), shared: true });
    if (!['bootstrap', 'exchange', 'navigate', 'disconnect'].includes(operation)) return c.json({ error: 'Unknown panel operation' }, 400);
    return c.json(await panelNavigator[operation](args));
  } catch (error) { return c.json({ error: error.message }, 409); }
});
app.post('/api/native', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${bridgeToken}`) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json();
  function claim(id, except) {
    assertOpenable(id);
    if (id === 'freecanvas' && browser?.readyState === 1 || liveNative().some(s => s.id !== except && s.document_id === id)) throw new Error('This canvas is already open in another panel. You can open a different canvas alongside it.');
  }
  try {
  if (body.operation === 'bootstrap') {
    const id = body.document_id ?? null;
    const data = id ? await documents.read(id) : { document: null, state: null, saved: null };
    if (id) claim(id);
    if (nativeCanvases.size >= 32) for (const [key, s] of nativeCanvases) if (Date.now() - s.seen >= 15000) nativeCanvases.delete(key);
    if (nativeCanvases.size >= 32) throw new Error('Too many canvas panels');
    const session = { id: randomUUID(), seen: Date.now(), requests: [], document_id: id };
    nativeCanvases.set(session.id, session);
    panelNavigator.observe(session.id, { document_id: id, navigation: ['0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.4.0', '0.4.1', '0.5.0', '0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5', '0.5.6', '0.5.7', '0.5.8'].includes(body.ui_version), ui_version: body.ui_version ?? null });
    return c.json({ session: session.id, ...data, documents: documents.list() });
  }
  const nativeCanvas = nativeCanvases.get(body.session);
  if (!nativeCanvas) return c.json({ error: 'Native canvas session expired. Reopen Canvy.' }, 409);
  if (Date.now() - nativeCanvas.seen >= 15000) { nativeCanvases.delete(nativeCanvas.id); return c.json({ error: 'Native canvas session expired. Reopen Canvy.' }, 409); }
  nativeCanvas.seen = Date.now();
  if (body.operation === 'heartbeat') {
    if (body.document_id !== undefined && body.document_id !== nativeCanvas.document_id) throw new Error('Transfer target does not match this canvas session');
    panelNavigator.observe(nativeCanvas.id, { document_id: nativeCanvas.document_id });
    return c.json({ connected: true });
  }
  async function switchCanvas(id) {
    if (nativeCanvas.requests.length || [...pending.values()].some(p => p.session === nativeCanvas.id)) throw new Error('The canvas is processing an edit. Try again in a moment.');
    const data = id ? await documents.read(id) : { document: null, state: null, saved: null };
    if (id) claim(id, nativeCanvas.id);
    nativeCanvas.document_id = id;
    panelNavigator.observe(nativeCanvas.id, { document_id: id });
    return { ...data, documents: documents.list() };
  }
  if (body.operation === 'exchange') {
    panelNavigator.observe(nativeCanvas.id, { document_id: nativeCanvas.document_id });
    // UI operations also use the original exchange contract. An already-open
    // Codex MCP process can therefore display the new UI after a plugin update.
    const control = body.responses?.find(r => r.id === '$freecanvas/control');
    if (control) {
      const args = control.result;
      if (args.operation === 'switch') return c.json({ requests: [], control: await switchCanvas(args.document_id ?? null) });
      return c.json({ requests: [], control: await library(args) });
    }
    for (const response of body.responses ?? []) {
      const item = pending.get(response.id); if (!item || item.session !== nativeCanvas.id) continue;
      pending.delete(response.id); clearTimeout(item.timer);
      response.error ? item.reject(new Error(response.error)) : item.resolve(response.result);
    }
    const requests = nativeCanvas.requests.splice(0).filter((r) => pending.has(r.id));
    return c.json({ requests });
  }
  if (body.operation === 'persist') {
    if (!nativeCanvas.document_id || body.document_id && body.document_id !== nativeCanvas.document_id) throw new Error('Save target does not match this canvas session');
    return c.json(await documents.save(nativeCanvas.document_id, body.state, body.fig));
  }
  if (body.operation === 'switch') {
    return c.json(await switchCanvas(body.document_id ?? null));
  }
  if (body.operation === 'disconnect') {
    nativeCanvases.delete(nativeCanvas.id);
    panelNavigator.detach(nativeCanvas.id);
    for (const [id, item] of pending) if (item.session === nativeCanvas.id) { clearTimeout(item.timer); item.reject(new Error('Canvas disconnected')); pending.delete(id); }
    return c.json({ disconnected: true });
  }
  return c.json({ error: 'Unknown native canvas operation' }, 400);
  } catch (e) { return c.json({ error: e.message }, 409); }
});
const sessions = new Map();
app.all('/mcp', async (c) => {
  const id = c.req.header('mcp-session-id');
  let session = id ? sessions.get(id) : null;
  if (id && !session) return c.json({ error: 'Unknown MCP session' }, 404);
  if (!session) {
    if (c.req.method !== 'POST') return c.json({ error: 'Initialize first' }, 400);
    if (sessions.size >= 16) return c.json({ error: 'Too many sessions' }, 429);
    const sessionId = randomUUID();
    const mcp = createMcp(sendRPC, origin, resolve(root, 'exports'));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true });
    await mcp.connect(transport);
    session = { transport, mcp, time: Date.now() };
    sessions.set(sessionId, session);
  }
  session.time = Date.now();
  const response = await session.transport.handleRequest(c.req.raw);
  if (c.req.method === 'DELETE' && id) { sessions.delete(id); await session.mcp.close(); }
  return response;
});
app.get('*', serveStatic({ root: resolve(root, 'dist') }));
const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, origin);
  if (url.pathname !== '/bridge' || !allowedOrigins.has(req.headers.origin) || url.searchParams.get('token') !== bridgeToken) { socket.destroy(); return; }
  if (!documents.isActive('freecanvas') || deleting.has('freecanvas') || browser?.readyState === 1 || liveNative().some(s => s.document_id === 'freecanvas')) { socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  browser = ws;
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id); clearTimeout(item.timer);
      if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
    } catch { /* Ignore invalid replies without accepting them as results. */ }
  });
  ws.on('close', () => {
    if (browser === ws) browser = null;
    for (const [id, item] of pending) if (!item.session) { clearTimeout(item.timer); item.reject(new Error('Canvas disconnected')); pending.delete(id); }
  });
});
setInterval(() => {
  for (const [id, session] of sessions) if (Date.now() - session.time > 15 * 60000) { sessions.delete(id); void session.mcp.close(); }
}, 60000).unref();
console.log(`Canvy ready at ${origin}`);
async function close() { for (const s of sessions.values()) await s.mcp.close(); wss.close(); http.close(); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
