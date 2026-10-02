import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '@open-pencil/mcp';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { OpenAIUiToolMetadataSchema, OpenAIUiResourceMetadataSchema } from '@openai/mcp-extensions/server';
import { addCompatibilityTools } from './tool-compatibility.mjs';
import { createServiceClient } from './service-client.mjs';
import { createPanelNavigator } from './panel-navigation.mjs';
import { captureFrontend } from './frontend-import.mjs';
import { createNativeWire } from './native-wire.mjs';
import { WIRE_CHUNK_CHARS } from '../src/wire-format.js';

export function createMcp(sendRPC, origin, root, { ensureService } = {}) {
  const server = new McpServer({ name: 'canvy', version: '0.5.6' });
  const catalog = addCompatibilityTools(server);
  const wire = createNativeWire();
  registerTools(server, { policy: { allowEval: false, disabledTools: ['open_file', 'save_file', 'new_document', 'list_documents'] }, mcpRoot: root, sendRPC: routedRPC });
  const register = (name, description, entries, handler, meta = {}, readOnly = false) => server.registerTool(name, {
    title: name === 'open_canvas' ? 'Canvy' : name, description, inputSchema: toStandardJsonSchema(v.object(entries)),
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false }, _meta: meta
  }, async (args) => {
    try {
      const value = await handler(args);
      const data = args.wire_version === 1 && !args.download ? wire.encode(value) : value;
      if (args.wire_version === 1) return { content: [{ type: 'text', text: 'Canvy native response' }], structuredContent: data };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  // Codex may route a fresh tool catalog through a retained older per-chat
  // connector. UI-only releases must keep an address that connector knows.
  const uri = 'ui://canvy/canvas/v5';
  const openMetadata = OpenAIUiToolMetadataSchema.parse({ entrypoints: [{ type: 'thread' }, { type: 'global' }], preferredModelDisplayMode: 'fullscreen' });
  const resourceMetadata = OpenAIUiResourceMetadataSchema.parse({ preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'pip'] });
  function registerCanvasResource(resourceUri, name) {
  server.registerResource(name, resourceUri, {
    mimeType: 'text/html;profile=mcp-app',
    _meta: { 'openai/ui': resourceMetadata, ui: { csp: { frameDomains: ['blob:'], connectDomains: [], resourceDomains: ['blob:'] } } }
  }, async () => {
    const html = await readFile(fileURLToPath(new URL('../dist/mcp-app.html', import.meta.url)), 'utf8');
    return { contents: [{ uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: html,
    _meta: { 'openai/ui': resourceMetadata, ui: { csp: { frameDomains: ['blob:'], connectDomains: [], resourceDomains: ['blob:'] } } }
  }] };
  });
  }
  registerCanvasResource(uri, 'canvy-canvas');
  registerCanvasResource('ui://canvy/canvas/v6', 'canvy-canvas-v6');
  registerCanvasResource('ui://canvy/canvas/v4', 'canvy-canvas-v4');
  registerCanvasResource('ui://canvy/canvas/v3', 'canvy-canvas-v3');
  registerCanvasResource('ui://canvy/canvas/v2', 'canvy-canvas-v2');
  registerCanvasResource('ui://canvy/canvas/v1', 'canvy-canvas-v1');
  registerCanvasResource('ui://freecanvas/canvas/v11', 'freecanvas-canvas-v11');
  registerCanvasResource('ui://freecanvas/canvas/v10', 'freecanvas-canvas-v10');
  registerCanvasResource('ui://freecanvas/canvas/v9', 'freecanvas-canvas-v9');
  registerCanvasResource('ui://freecanvas/canvas/v8', 'freecanvas-canvas-v8');
  registerCanvasResource('ui://freecanvas/canvas/v7', 'freecanvas-canvas-v7');
  registerCanvasResource('ui://freecanvas/canvas/v6', 'freecanvas-canvas-v6');
  registerCanvasResource('ui://freecanvas/canvas/v5', 'freecanvas-canvas-legacy');
  register('open_canvas', 'Open Canvy Home inside Codex to choose or create a persistent local canvas. Supply document_id to open that canvas directly. Different documents can be open simultaneously. Use this native UI resource, not a browser tab.', { document_id: v.optional(v.string()) },
    async (args) => { if (args.document_id) { const list = await library('list'); if (!list.documents.some(d => d.id === args.document_id)) throw new Error('Unknown canvas'); } return { document_id: args.document_id ?? null, local: true, presentation: 'native-plugin-canvas', opening_requested: true, connection: await diagnostics(args) }; },
    { ui: { resourceUri: uri }, 'openai/outputTemplate': uri, 'openai/ui': openMetadata }, true);
  const target = { document_id: v.optional(v.string()) };
  const dimension = v.pipe(v.number(), v.integer(), v.minValue(240), v.maxValue(3840));
  const bounded = (limit) => v.pipe(v.string(), v.maxLength(limit));
  register('canvas_import_react', 'Render a default-exported React component with its real CSS/Tailwind in local Chromium, capture computed geometry, and import editable native nodes. Original fonts, images, SVGs, prototype and issue report persist with the canvas. Supply inline source/files or a local project_dir and entry. Local imports only; network/API access is blocked. Tailwind=true compiles v4 utility candidates; supply compiled CSS for other configurations. Unsupported CSS is explicitly reported. Requires the current native Canvy panel and Chromium. Editing waits for autosave; do not replay an uncertain import.', {
    ...target, name: v.optional(bounded(120)), source: v.optional(bounded(1024 * 1024)), css: v.optional(bounded(1024 * 1024)),
    project_dir: v.optional(v.string()), entry: v.optional(v.string()), selector: v.optional(bounded(500)), tailwind: v.optional(v.boolean()), props: v.optional(v.record(v.string(), v.unknown())),
    files: v.optional(v.pipe(v.array(v.object({ path: v.string(), content: bounded(3 * 1024 * 1024), encoding: v.optional(v.picklist(['utf8', 'base64'])) })), v.maxLength(100))),
    viewports: v.optional(v.pipe(v.array(v.object({ width: dimension, height: dimension })), v.minLength(1), v.maxLength(4))),
    x: v.optional(v.number()), y: v.optional(v.number()), preview: v.optional(v.boolean())
  }, async args => {
    // Check the actual target before compiling; an old mounted UI cannot handle
    // import commands. This read also performs explicit document navigation.
    const targetStatus = await routedRPC({ command: 'freecanvas_status', args: { document_id: args.document_id } });
    const attached = (await panels('list')).panels.find(p => p.document_id === targetStatus.document_id);
    const [major, minor, patch] = (attached?.ui_version ?? '').split('.').map(Number);
    if (!(major === 0 && (minor > 5 || minor === 5 && patch >= 2))) throw new Error('React import requires Canvy 0.5.2 or newer. Refresh the plugin session and reopen its native panel; your saved canvases are preserved.');
    const packet = await captureFrontend(args);
    return routedRPC({ command: 'canvy_import_frontend', args: { document_id: targetStatus.document_id, packet, x: args.x, y: args.y, preview: args.preview } });
  });
  register('canvas_get_import_report', 'Read conversion issues, responsive frame IDs, original font registration and asset preservation for a saved frontend import. Does not return bundled prototype source.', { ...target, import_id: v.string() }, args => routedRPC({ command: 'canvy_get_import_report', args }), {}, true);
  register('canvas_preview_import', 'Open the original bundled React prototype inside the native Canvy panel. This isolated, offline preview is separate from editable design nodes; native edits do not rewrite React source. Supply import_id or frame_id. Preview interaction state is temporary; its original code and assets persist.', { ...target, import_id: v.optional(v.string()), frame_id: v.optional(v.string()), width: v.optional(dimension), height: v.optional(dimension) }, args => routedRPC({ command: 'canvy_preview_import', args }));
  register('canvas_preview_action', 'Interact with an open React prototype using a CSS selector: click or fill a form field; snapshot reads visible text and controls; close returns to the editable canvas. Typed actions only, no JavaScript evaluation. A timed-out action has an uncertain outcome and must not be replayed automatically.', { ...target, action: v.picklist(['click', 'fill', 'snapshot', 'close']), selector: v.optional(bounded(500)), value: v.optional(bounded(20000)) }, args => routedRPC({ command: 'canvy_preview_action', args }));
  register('save_document', 'Persist the canvas locally. Edits already autosave. Specify document_id when multiple canvases are open.', target, async (args) => routedRPC({ command: 'freecanvas_save', args }));
  register('undo', 'Undo the last edit in the specified canvas.', target, async (args) => routedRPC({ command: 'freecanvas_undo', args }));
  register('redo', 'Redo the last undone edit in the specified canvas.', target, async (args) => routedRPC({ command: 'freecanvas_redo', args }));
  register('canvas_status', 'Inspect canvas connection even when no panel is open. Returns connected=false and an actionable connection state for closed documents. A connected document includes live selection and persistence status.', target, async (args) => {
    const connection = await diagnostics(args);
    if (connection.connection_state !== 'document_connected') return { ...connection, connected: false, ready: false };
    return { ...await sendRPC({ command: 'freecanvas_status', args }), ...connection };
  }, {}, true);
  register('canvas_diagnostics', 'Inspect native panel attachment, loaded documents, interface versions, runtime limits, and the advertised public tool catalog. Does not require an open canvas. Opening requested is distinct from a connected document.', target, async args => ({ ...await diagnostics(args), ...await panels('list'), connector_version: '0.5.6', tool_profile: catalog.profile, registered_public_tools: catalog.filter(t => t.public).length, tools: catalog.filter(t => t.public && t.advertised) }), {}, true);
  register('export_jsx', 'Export a frame or selection to JSX with Tailwind classes. This is a design export, not a running React app.', { ...target, ids: v.array(v.string()) }, async (args) => routedRPC({ command: 'freecanvas_jsx', args }), {}, true);
  register('send_selection_to_chat', 'Read the selected nodes and a bounded context packet for a targeted change request.', target, async (args) => routedRPC({ command: 'freecanvas_context', args }), {}, true);
  const serviceRequest = createServiceClient(origin, { ensureService });
  const localNavigator = createPanelNavigator(native);
  let preferredPanel;
  async function panels(operation, args = {}) {
    const response = await serviceRequest('/api/panels', { operation, ...args });
    if (response.status === 404) {
      const attached = localNavigator.list();
      if (operation === 'list') return { panels: attached, shared: false, navigation_scope: 'connector', guidance: 'This running backend predates shared panel navigation. Updated panels can navigate through their own connector; shared navigation requires a cold backend start.' };
      if (operation === 'navigate' && !attached.length && (await diagnostics()).native_panels > 0) throw new Error('Canvy panels are connected through an older connector. Reload the plugin panel once to attach the updated navigation tools. Shared navigation also requires the updated backend.');
      return localNavigator[operation](args);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Panel navigation unavailable');
    return result;
  }
  async function navigate(args) {
    if (args.document_id && !(await library('list')).documents.some(d => d.id === args.document_id)) throw new Error('Unknown canvas');
    let target = args;
    if (!args.panel_id && args.from_document_id === undefined && preferredPanel && (await panels('list')).panels.some(p => p.panel_id === preferredPanel && p.navigation)) target = { ...args, panel_id: preferredPanel };
    const result = await panels('navigate', target);
    preferredPanel = result.panel_id;
    return result;
  }
  async function routedRPC(body) {
    const document_id = body.args?.document_id;
    if (document_id && (await diagnostics({ document_id })).connection_state !== 'document_connected') {
      await navigate({ document_id });
    }
    return sendRPC(body);
  }
  async function diagnostics(args = {}) {
    const response = await serviceRequest('/api/diagnostics', args);
    // Keep the currently open 0.3.0 service and its unsuspended panels alive
    // during installation. Only a cold service start adopts the new endpoint.
    if (response.status === 404) {
      try {
        const live = await sendRPC({ command: 'freecanvas_status', args });
        return { version: '0.5.6', service_compatibility: '0.3.0', connection_state: 'document_connected', document_id: live.document_id, open_documents: [live.document_id], requested_document_connected: true, guidance: null, live_status: live };
      } catch (error) {
        const ambiguous = /Multiple canvases/.test(error.message);
        const state = ambiguous ? 'multiple_documents_connected' : /disconnected/.test(error.message) ? 'panel_not_connected' : 'connection_error';
        return { version: '0.5.6', service_compatibility: '0.3.0', connection_state: state, document_id: args.document_id ?? null, requested_document_connected: false, guidance: ambiguous ? 'Specify document_id.' : error.message };
      }
    }
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Connection diagnostics unavailable'); return result;
  }
  async function native(operation, args) {
    const response = await serviceRequest('/api/native', { operation, ...args });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  async function library(operation, args = {}) {
    const response = await serviceRequest('/api/library', { operation, ...args });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  register('list_documents', 'List all persistent local canvases, including closed ones. Their IDs target editing tools.', {}, () => library('list'), {}, true);
  register('list_open_canvases', 'List attached native panels, their current documents, navigation support and activity. Use panel_id to choose a panel when several are open.', {}, () => panels('list'), {}, true);
  register('switch_canvas', 'Load a persistent canvas or Home in an existing native panel. Flushes pending edits, waits for the loaded document acknowledgement and resets undo history. Omit document_id for Home. Specify panel_id or from_document_id if the active panel is ambiguous.', { document_id: v.optional(v.nullable(v.string())), panel_id: v.optional(v.string()), from_document_id: v.optional(v.nullable(v.string())) }, navigate);
  register('create_canvas', 'Create a separate persistent local canvas. Use switch_canvas to load it in an existing panel, or open_canvas to open a panel.', { name: v.string() }, args => library('create', args));
  register('rename_canvas', 'Rename a persistent local canvas without changing its contents or ID.', { document_id: v.string(), name: v.string() }, args => library('rename', args));
  const appOnly = { ui: { visibility: ['app'] } };
  const wireVersion = { wire_version: v.optional(v.literal(1)) };
  const chunk = v.object({ id: v.string(), index: v.pipe(v.number(), v.integer(), v.minValue(0)), total: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(192)), bytes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(48 * 1024 * 1024)), data: bounded(WIRE_CHUNK_CHARS) });
  register('_canvas_bootstrap', 'Internal native canvas initialization.', { ...target, ...wireVersion, ui_version: v.optional(v.string()), previous_session: v.optional(v.string()) }, async args => {
    const result = await panels('bootstrap', args);
    if (preferredPanel === args.previous_session) preferredPanel = result.session;
    return result;
  }, appOnly);
  register('_canvas_exchange', 'Internal native canvas RPC exchange.', { ...wireVersion, session: v.optional(v.string()), responses: v.optional(v.array(v.object({ id: v.string(), result: v.optional(v.unknown()), error: v.optional(v.string()) }))), download: v.optional(v.object({ id: v.string(), index: v.pipe(v.number(), v.integer(), v.minValue(0)) })), view: v.optional(v.object({ document_id: v.nullable(v.string()), navigation: v.boolean(), ui_version: v.string(), ready: v.boolean(), switching: v.boolean(), active: v.boolean(), last_interaction_at: v.number() })) }, async args => {
    if (args.download && args.wire_version === 1) {
      if (args.session) await native('heartbeat', { session: args.session });
      return wire.download(args.download);
    }
    if (!args.session || !args.responses) throw new Error('Native exchange requires session and responses');
    return panels('exchange', args);
  }, appOnly);
  register('_canvas_persist', 'Internal native canvas checkpoint persistence.', { ...wireVersion, session: v.string(), document_id: v.string(), state: v.optional(v.string()), fig: v.optional(v.string()), transfer: v.optional(chunk) }, async args => {
    if (!args.transfer) {
      if (typeof args.state !== 'string' || typeof args.fig !== 'string') throw new Error('Checkpoint required');
      return native('persist', args);
    }
    if (args.state !== undefined || args.fig !== undefined || args.wire_version !== 1) throw new Error('Ambiguous native checkpoint transfer');
    await native('heartbeat', { session: args.session, document_id: args.document_id });
    const checkpoint = wire.upload(args.session, args.document_id, args.transfer);
    if (!checkpoint) return { transfer_received: true, index: args.transfer.index };
    return native('persist', { session: args.session, document_id: args.document_id, ...checkpoint });
  }, appOnly);
  register('_canvas_switch', 'Internal switch or return to Home after flushing edits.', { ...wireVersion, session: v.string(), document_id: v.optional(v.string()) }, args => native('switch', args), appOnly);
  register('_canvas_disconnect', 'Internal native canvas teardown.', { ...wireVersion, session: v.string() }, (args) => panels('disconnect', args), appOnly);
  return server;
}
