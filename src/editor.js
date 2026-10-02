import { createEditor, createDefaultEditorState, executeAtomicTool } from '@open-pencil/core/editor';
import { SceneGraph, captureGraphCheckpoint } from '@open-pencil/scene-graph';
import { FigmaAPI } from '@open-pencil/core/figma-api';
import { ALL_TOOLS, isAtomicTool, isToolExposed } from '@open-pencil/core/tools';
import { executeRPCCommand } from '@open-pencil/core/rpc';
import { exportFigFile, parseFigFile, renderNodesToImage } from '@open-pencil/core/io';
import { selectionToJSX } from '@open-pencil/core/io/formats/jsx';
import { fontManager } from '@open-pencil/core/text';
import { encodeDocument, decodeDocument } from './document-state.js';
import { reactive } from 'vue';
import { importFrontend, restoreImportFonts } from './frontend-import.js';
import { openPreview, closePreview, previewAction } from './prototype-preview.js';

let viewport = { width: 800, height: 600 };
export function setViewportSize(size) { viewport = size; }
const initialGraph = new SceneGraph();
export const editor = createEditor({ graph: initialGraph, state: reactive(createDefaultEditorState(initialGraph.getPages()[0].id)), getViewportSize: () => viewport });
fontManager.setOnlineFontProviders({ google: false, fontsource: false });
fontManager.setHostFontLoader(async (family, style = 'Regular') => {
  if (!['Inter', 'Roboto'].includes(family)) return null;
  const variants = { Regular: 'Regular', Medium: 'Medium', 'Semi Bold': 'SemiBold', SemiBold: 'SemiBold', Bold: 'Bold', 'Extra Bold': 'ExtraBold', ExtraBold: 'ExtraBold' };
  const face = variants[style];
  if (!face) return null; // Report unsupported faces instead of silently using Regular.
  if (window.__FREECANVAS_NATIVE_ASSETS__) return window.__FREECANVAS_NATIVE_ASSETS__.fonts[family][face];
  const response = await fetch(`/${family}-${face}.ttf`);
  return response.ok ? response.arrayBuffer() : null;
});
let token;
let saveQueue = Promise.resolve();
let lastSaveError = '';
let lastSavedState, lastSaveResult, retryTimer, saveScheduled = false;
export const status = reactive({ ready: false, connected: false, savedAt: null, revision: 0, saving: false, dirty: false, saveError: '', openError: '', document: null, documents: [], home: false, switching: false });
function loadDocument(bootstrap) {
  closePreview();
  editor.replaceGraph(bootstrap.state ? decodeDocument(bootstrap.state) : new SceneGraph());
  restoreImportFonts(editor.graph);
  editor.undo.clear();
  status.document = bootstrap.document;
  status.documents = bootstrap.documents ?? status.documents;
  status.home = !bootstrap.document;
  status.savedAt = bootstrap.state ? bootstrap.document.updatedAt : null;
  status.dirty = false; status.saveError = ''; status.openError = ''; status.revision = 0;
  lastSavedState = bootstrap.state ?? null; lastSaveResult = undefined;
  editor.state.pageColor = { r: 43 / 255, g: 43 / 255, b: 43 / 255, a: 1 };
  editor.zoomToFit(); editor.requestRender();
}
export async function initialize() {
  const bootstrap = window.__FREECANVAS_NATIVE_HOST__?.bootstrap ?? await (await fetch('/api/bootstrap')).json();
  token = bootstrap.token;
  loadDocument(bootstrap);
  if (!bootstrap.state && bootstrap.saved) {
    const data = Uint8Array.from(atob(bootstrap.saved), (c) => c.charCodeAt(0));
    editor.replaceGraph(await parseFigFile(data.buffer));
  }
  editor.state.pageColor = { r: 43 / 255, g: 43 / 255, b: 43 / 255, a: 1 };
  if (window.__FREECANVAS_NATIVE_HOST__) {
    const host = window.__FREECANVAS_NATIVE_HOST__;
    host.view = status;
    host.beforeClose = flushPendingSave;
    host.validateCheckpoint = state => {
      if (state !== encodeDocument(editor.graph)) throw new Error('The canvas changed during reconnection. Retrying with the latest checkpoint.');
    };
    host.onReconnect = async data => {
      editor.commitTextEdit();
      if (status.dirty && data.state !== lastSavedState) {
        status.openError = 'This canvas changed while the panel was inactive. Your unsaved changes are still here; reload the latest version before editing further.';
        throw new Error(status.openError);
      }
      if (!status.dirty && data.state !== lastSavedState) loadDocument(data);
      status.document = data.document; status.documents = data.documents;
      await host.context(contextPacket());
    };
    host.onOpen = id => switchDocument(id).catch(error => { status.openError = error.message; });
    const requested = host.requestedDocument();
    if (requested && requested !== status.document?.id) {
      try { await switchDocument(requested); } catch (error) { status.openError = error.message; }
    }
  }
  return token;
}
export async function refreshDocuments() {
  const host = window.__FREECANVAS_NATIVE_HOST__;
  const data = host ? await host.library('list') : await (await fetch('/api/library', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list' }) })).json();
  status.documents = data.documents; return data.documents;
}
export async function createDocument(name) {
  const host = window.__FREECANVAS_NATIVE_HOST__;
  if (!host) throw new Error('Open Canvy inside Codex to create canvases');
  const data = await host.library('create', { name });
  await switchDocument(data.document.id);
}
export async function renameDocument(document_id, name) {
  await window.__FREECANVAS_NATIVE_HOST__.library('rename', { document_id, name });
  if (status.document?.id === document_id) status.document.name = name;
  await refreshDocuments();
}
export async function switchDocument(id) {
  if ((id ?? null) === (status.document?.id ?? null)) return;
  if (status.switching) throw new Error('Canvas is already switching');
  status.switching = true;
  try {
    await flushPendingSave();
    const host = window.__FREECANVAS_NATIVE_HOST__;
    if (!host) throw new Error('Open Canvy inside Codex to switch canvases');
    const data = await host.switch(id);
    clearTimeout(retryTimer); saveScheduled = false;
    loadDocument(data);
    host.bootstrap.document = data.document;
    await host.context(contextPacket());
  } finally { status.switching = false; }
}
export async function saveDocument() {
  saveScheduled = false;
  const work = saveQueue.catch(() => {}).then(async () => {
    if (!status.document) return { saved: true, home: true };
    const document_id = status.document.id;
    const state = encodeDocument(editor.graph);
    if (lastSaveResult && state === lastSavedState) {
      status.dirty = false; status.saveError = ''; lastSaveError = ''; clearTimeout(retryTimer);
      return lastSaveResult;
    }
    status.saving = true;
    const bytes = await exportFigFile(editor.graph);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    let result;
    if (window.__FREECANVAS_NATIVE_HOST__) {
      result = await window.__FREECANVAS_NATIVE_HOST__.save(document_id, state, btoa(binary));
    } else {
      const response = await fetch('/api/document', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, document_id, state, fig: btoa(binary) }) });
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      result = await response.json();
    }
    lastSavedState = state; lastSaveResult = result;
    status.savedAt = new Date().toISOString(); lastSaveError = ''; status.saveError = '';
    status.dirty = encodeDocument(editor.graph) !== state;
    clearTimeout(retryTimer);
    return result;
  }).catch((error) => {
    lastSaveError = error.message; status.saveError = error.message; status.dirty = true;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { void saveDocument().catch(() => {}); }, 2000);
    throw error;
  }).finally(() => {
    status.saving = false;
  });
  saveQueue = work;
  return work;
}
export function scheduleSave() {
  if (!status.document || status.switching) return;
  status.dirty = true;
  if (saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    if (!saveScheduled) return;
    saveScheduled = false;
    void saveDocument().catch(() => {});
  });
}
export async function flushPendingSave() {
  editor.commitTextEdit();
  await saveDocument();
}
export function contextPacket() {
  return {
    document_id: status.document?.id ?? null, document_name: status.document?.name ?? null, page_id: editor.state.currentPageId, revision: status.revision,
    panel_id: window.__FREECANVAS_NATIVE_HOST__?.bootstrap.session ?? null,
    selectedIds: [...editor.state.selectedIds],
    selection: [...editor.state.selectedIds].slice(0, 20).map((id) => {
      const n = editor.graph.getNode(id);
      return n && { id: n.id, name: n.name, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height, text: n.text?.slice(0, 1000), children: n.childIds.slice(0, 40) };
    }).filter(Boolean)
  };
}
function makeFigma(pageId) {
  const figma = new FigmaAPI(editor.graph);
  figma.setRenderer(editor.renderer);
  figma.currentPage = figma.wrapNode(pageId ?? editor.state.currentPageId);
  figma.currentPage.selection = [...editor.state.selectedIds].map((id) => figma.getNodeById(id)).filter(Boolean);
  figma.exportImage = async (ids, options) => {
    if (!editor.renderer) throw new Error('Renderer unavailable');
    return renderNodesToImage(editor.renderer.ck, editor.renderer, editor.graph, figma.currentPageId, ids, options);
  };
  return figma;
}
function snapshot() {
  const checkpoint = captureGraphCheckpoint(editor.graph);
  const resources = structuredClone(editor.graph.canvyResources);
  const pageId = editor.state.currentPageId;
  const selection = new Set(editor.state.selectedIds);
  return () => {
    checkpoint.restore();
    editor.graph.canvyResources = structuredClone(resources);
    if (editor.graph.getNode(pageId)) editor.switchPage(pageId);
    editor.select([...selection].filter((id) => editor.graph.getNode(id)));
    editor.requestRender(); scheduleSave();
  };
}
async function ensureFonts() {
  for (const n of editor.graph.nodes.values()) if (n.type === 'TEXT') await fontManager.ensureNodeFont(n.fontFamily, n.fontWeight);
}
export async function runRPC({ command, args = {} }) {
  if (command === 'freecanvas_navigate') {
    await switchDocument(args.document_id ?? null);
    return { ...contextPacket(), connected: true, ready: status.ready, home: status.home };
  }
  if (!status.ready) throw new Error('Canvas is still loading');
  if (status.home || status.switching) throw new Error('Choose a canvas from Home before editing');
  if (args.document_id && args.document_id !== status.document.id) throw new Error('Unknown document');
  if (args.page_id && editor.graph.getNode(args.page_id)?.type !== 'CANVAS') throw new Error('Unknown page');
  if (command === 'freecanvas_status') return { ...status, ...contextPacket(), saveError: lastSaveError, nodes: editor.graph.nodes.size };
  if (command === 'freecanvas_context') return contextPacket();
  if (command === 'freecanvas_save') return saveDocument();
  if (command === 'canvy_get_import_report') {
    const imports = editor.graph.canvyResources?.imports ?? {};
    const entry = imports[args.import_id];
    if (!entry) throw new Error('Unknown frontend import');
    const { html, originals, assets, ...report } = entry;
    return { import_id: args.import_id, ...report, original_assets: (assets ?? []).map(({ data, ...asset }) => ({ ...asset, available: Boolean(data) })), original_svgs: originals.length, original_fonts: Object.values(editor.graph.canvyResources.fonts).map(({data, ...font}) => font) };
  }
  if (command === 'canvy_preview_import') { const result = openPreview(editor.graph, args); return { ...result, opening_requested: true }; }
  if (command === 'canvy_preview_action') return previewAction(args);
  if (command === 'canvy_import_frontend') {
    const before = snapshot();
    let result;
    try {
      result = await importFrontend(editor, makeFigma(), args.packet, args);
      await ensureFonts();
      const after = snapshot();
      editor.pushUndoEntry({ label: 'Import React frontend', inverse: before, forward: after });
    } catch (error) { before(); throw error; }
    status.revision++; await saveDocument();
    if (args.preview) openPreview(editor.graph, { import_id: result.import_id });
    return result;
  }
  if (command === 'freecanvas_undo' || command === 'freecanvas_redo') {
    command.endsWith('undo') ? editor.undoAction() : editor.redoAction();
    status.revision++; await saveDocument(); return contextPacket();
  }
  if (command === 'freecanvas_jsx') {
    for (const id of args.ids) if (!editor.graph.getNode(id)) throw new Error(`Unknown node: ${id}`);
    return { jsx: selectionToJSX(args.ids, editor.graph, 'tailwind') };
  }
  if (command === 'list_documents') return { ok: true, result: { documents: [{ id: 'freecanvas', name: 'Canvy', active: true, current_page_id: editor.state.currentPageId, pages: editor.graph.getPages().map((n) => ({ id: n.id, name: n.name })) }] } };
  if (command !== 'tool') return { ok: true, result: executeRPCCommand(editor.graph, command, args) };
  const def = ALL_TOOLS.find((t) => t.name === args.name && isToolExposed(t, 'mcp'));
  if (!def || def.availability === 'eval') throw new Error(`Unavailable tool: ${args.name}`);
  // The Figma proxy expects spaced weight names whereas our bundled loader and
  // font-status API use compact names. Preserve semibold/extra bold on edits.
  if (def.name === 'set_font' && typeof args.args?.style === 'string') {
    args.args = { ...args.args, style: args.args.style.replace(/semi\s*bold/gi, 'Semi Bold').replace(/extra\s*bold/gi, 'Extra Bold') };
  }
  const figma = makeFigma(args.page_id);
  figma.viewport = { center: { x: (viewport.width / 2 - editor.state.panX) / editor.state.zoom, y: (viewport.height / 2 - editor.state.panY) / editor.state.zoom }, zoom: editor.state.zoom };
  let result;
  if (isAtomicTool(def)) result = executeAtomicTool(editor, figma, def, args.args ?? {}, { label: 'Codex' });
  else if (def.mutates && def.execution.mutation === 'document') {
    if (editor.graph.nodes.size + editor.graph.variables.size > 10000) throw new Error('Document too large for reversible agent editing');
    const before = snapshot();
    try {
      result = await def.execute(figma, args.args ?? {});
      if (result?.error) throw new Error(result.error);
      // appendChild preserves world position. create_shape's supplied coordinates
      // describe the new parent's local space in Canvy.
      if (def.name === 'create_shape' && args.args?.parent_id && result?.id) {
        editor.graph.updateNode(result.id, { x: args.args.x, y: args.args.y });
      }
      await ensureFonts();
      const after = snapshot();
      editor.pushUndoEntry({ label: `Codex: ${def.name}`, inverse: before, forward: after });
    } catch (error) { before(); throw error; }
  } else result = await def.execute(figma, args.args ?? {});
  if (result?.error) throw new Error(result.error);
  if (def.name === 'select_nodes') {
    const ids = (args.args?.ids ?? []);
    if (ids.some((id) => !editor.graph.getNode(id))) throw new Error('Selection contains an unknown node');
    editor.select(figma.currentPage.selection.map((n) => n.id));
  }
  if (def.name === 'viewport_zoom_to_fit') {
    const b = result.bounds;
    editor.zoomToBounds(b.x, b.y, b.x + b.width, b.y + b.height);
  }
  if (def.name === 'viewport_set') {
    editor.setZoomAroundPoint(figma.viewport.zoom, viewport.width / 2, viewport.height / 2);
    editor.pan(viewport.width / 2 - figma.viewport.center.x * editor.state.zoom - editor.state.panX,
      viewport.height / 2 - figma.viewport.center.y * editor.state.zoom - editor.state.panY);
  }
  if (def.name === 'switch_page') editor.switchPage(figma.currentPageId);
  if (def.execution.mutation === 'document' || def.execution.mutation === 'properties') {
    status.revision++; await ensureFonts();
    editor.runLayoutForNode(figma.currentPageId);
    editor.requestRender(); await saveDocument();
  }
  return { ok: true, result };
}
export function connectBridge(authToken, onStatus) {
  if (window.__FREECANVAS_NATIVE_HOST__) {
    let disposed = false;
    async function poll() {
      let responses = [];
      while (!disposed && !window.__FREECANVAS_NATIVE_HOST__.closed) {
        let failed = false;
        try {
          const data = await window.__FREECANVAS_NATIVE_HOST__.exchange(responses); responses = [];
          status.connected = true; onStatus(true);
          for (const request of data.requests) {
            // The browser transport already JSON-normalizes RPC results. Apply
            // the same wire contract before the host's structured-clone bridge:
            // native viewport adapters include convenience methods.
            try { responses.push({ id: request.id, result: JSON.parse(JSON.stringify(await runRPC(request))) }); }
            catch (error) { responses.push({ id: request.id, error: error.message }); }
          }
        } catch (error) { failed = true; status.connected = false; onStatus(false); console.error(error.message); }
        await new Promise((r) => setTimeout(r, failed ? 1000 : responses.length ? 0 : 400));
      }
    }
    void poll(); return () => { disposed = true; };
  }
  let socket; let timer; let disposed = false; let queue = Promise.resolve();
  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge?token=${authToken}`);
    socket.onopen = () => { status.connected = true; onStatus(true); };
    socket.onclose = () => { status.connected = false; onStatus(false); if (!disposed) timer = setTimeout(connect, 2000); };
    socket.onmessage = (event) => {
      const request = JSON.parse(event.data);
      queue = queue.catch(() => {}).then(async () => {
        try { const result = await runRPC(request); socket.send(JSON.stringify({ id: request.id, result })); }
        catch (error) { socket.send(JSON.stringify({ id: request.id, error: error.message })); }
      });
    };
  }
  connect();
  return () => { disposed = true; clearTimeout(timer); socket?.close(); };
}
