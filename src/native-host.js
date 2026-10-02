import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { encodeWire, decodeWire, WIRE_CHUNK_CHARS } from './wire-format.js';
export async function connectNativeHost() {
  const app = new App({ name: 'Canvy', version: '0.5.10' }, {}, { autoResize: false });
  // ui_version below is the compatible bridge ABI. Keep it at 0.5.4 so live
  // backends and unsaved panels survive compatible UI updates. New library
  // features negotiate their capability through list before sending mutations.
  const extensions = new OpenAIExtensions(app);
  // Install notification handlers before the initial host handshake.
  let requestedDocument;
  app.ontoolinput = params => { requestedDocument = params.arguments?.document_id; };
  app.ontoolresult = params => { requestedDocument = params.structuredContent?.document_id ?? requestedDocument; };
  await app.connect();
  async function tool(name, args = {}) {
    const result = await app.callServerTool({ name, arguments: { ...args, wire_version: 1 } });
    if (result.isError) throw new Error(result.content?.find((c) => c.type === 'text')?.text ?? 'Codex tool failed');
    const value = result.structuredContent;
    if (!value?.canvy_wire) return value;
    const wire = { ...value.canvy_wire };
    if (wire.transfer) {
      const chunks = [];
      for (let index = 0; index < wire.transfer.total; index++) {
        const chunk = await tool('_canvas_exchange', { session: args.session ?? value.session, download: { id: wire.transfer.id, index } });
        if (chunk.id !== wire.transfer.id || chunk.index !== index || typeof chunk.data !== 'string') throw new Error('Invalid native download acknowledgement');
        chunks.push(chunk.data);
      }
      wire.data = chunks.join('');
    }
    return decodeWire(wire);
  }
  // Attach to Home first. A claimed/missing requested document must not prevent
  // the panel from mounting and offering the user's other persistent canvases.
  const bootstrap = await tool('_canvas_bootstrap', { ui_version: '0.5.4' });
  let lastInteraction = 0;
  const interaction = () => { lastInteraction = Date.now(); };
  document.addEventListener('pointerdown', interaction);
  document.addEventListener('click', interaction);
  document.addEventListener('keydown', interaction);
  let reconnecting;
  async function reconnect() {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      const previous = { ...bootstrap };
      const attached = await tool('_canvas_bootstrap', { document_id: bootstrap.document?.id, ui_version: '0.5.4', previous_session: previous.session });
      Object.assign(bootstrap, attached);
      try { await host.onReconnect?.(attached); }
      catch (error) {
        await tool('_canvas_disconnect', { session: attached.session }).catch(() => {});
        Object.assign(bootstrap, previous); throw error;
      }
    })();
    try { await reconnecting; } finally { reconnecting = undefined; }
  }
  async function nativeTool(name, argumentsForSession, checkpoint) {
    if (reconnecting) {
      await reconnecting;
      if (name === '_canvas_persist') host.validateCheckpoint?.(checkpoint ?? argumentsForSession().state);
    }
    try { return await tool(name, argumentsForSession()); }
    catch (error) {
      // A lease rejection happens before execution. Reattach, then retry once;
      // never replay an edit or write after an uncertain transport failure.
      if (!/Native canvas session expired/.test(error.message)) throw error;
      await reconnect();
      if (name === '_canvas_persist') host.validateCheckpoint?.(checkpoint ?? argumentsForSession().state);
      return tool(name, argumentsForSession());
    }
  }
  const control = async (operation, args = {}) => (await nativeTool('_canvas_exchange', () => ({ session: bootstrap.session, responses: [{ id: '$freecanvas/control', result: { operation, ...args } }] }))).control;
  const host = {
    app, bootstrap,
    save: async (document_id, state, fig) => {
      const wire = await encodeWire({ state, fig });
      const id = crypto.randomUUID(), total = Math.ceil(wire.data.length / WIRE_CHUNK_CHARS);
      let result;
      for (let index = 0; index < total; index++) {
        result = await nativeTool('_canvas_persist', () => ({ session: bootstrap.session, document_id, transfer: { id, index, total, bytes: wire.bytes, data: wire.data.slice(index * WIRE_CHUNK_CHARS, (index + 1) * WIRE_CHUNK_CHARS) } }), state);
        if (index < total - 1 && (!result.transfer_received || result.index !== index)) throw new Error('Invalid native upload acknowledgement');
      }
      if (!result.saved || result.document_id !== document_id) throw new Error('Native save was not acknowledged');
      return result;
    },
    exchange: (responses) => nativeTool('_canvas_exchange', () => ({ session: bootstrap.session, responses, view: { document_id: bootstrap.document?.id ?? null, navigation: true, ui_version: '0.5.4', ready: Boolean(host.view?.ready), switching: Boolean(host.view?.switching), active: document.visibilityState !== 'hidden' && document.hasFocus(), last_interaction_at: lastInteraction } })),
    library: control,
    switch: document_id => control('switch', { document_id }),
    context: async (packet) => {
      const data = { structuredContent: packet, content: [{ type: 'text', text: JSON.stringify(packet) }] };
      if (extensions.modelContext) await extensions.modelContext.update(data); else await app.updateModelContext(data);
    },
    send: async (packet) => {
      await host.context(packet);
      const message = { role: 'user', content: [{ type: 'text', text: `Work on this Canvy selection:\n${JSON.stringify(packet)}` }] };
      const result = extensions.message ? await extensions.message.send(message) : await app.sendMessage(message);
      if (result?.isError) throw new Error('Codex rejected the message');
    }
  };
  // Hosts may send the opening tool result after initialization completes.
  app.ontoolresult = params => {
    const id = params.structuredContent?.document_id;
    if (id && id !== host.bootstrap.document?.id) {
      requestedDocument = id;
      if (host.onOpen) void host.onOpen(id);
    }
  };
  host.requestedDocument = () => requestedDocument;
  app.ontoolinput = params => {
    const id = params.arguments?.document_id;
    requestedDocument = id;
    if (id && id !== host.bootstrap.document?.id && host.onOpen) void host.onOpen(id);
  };
  app.onteardown = async () => {
    document.removeEventListener('pointerdown', interaction);
    document.removeEventListener('click', interaction);
    document.removeEventListener('keydown', interaction);
    await host.beforeClose?.();
    host.closed = true;
    await tool('_canvas_disconnect', { session: bootstrap.session });
    return {};
  };
  return host;
}
