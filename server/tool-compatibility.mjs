// Preserve existing names and handlers. Some Codex sessions omit these public
// names despite tools/list advertising them. Namespaced aliases give the host
// a second discovery path without eval, a generic command gateway or new rights.
export const COMPATIBILITY_TOOLS = new Set([
  'render', 'update_node', 'set_layout', 'set_layout_child', 'set_radius',
  'set_fill', 'set_stroke', 'set_text', 'set_text_properties', 'stock_photo',
  'viewport_zoom_to_fit', 'select_nodes', 'switch_page', 'search_icons',
  'set_effects', 'set_opacity', 'set_font', 'set_visible', 'set_constraints',
  'set_rotation', 'set_minmax', 'set_font_range', 'set_text_resize', 'set_blend',
  'set_locked', 'set_stroke_align', 'set_image_fill', 'ungroup_node',
  'set_variable', 'unbind_variable', 'viewport_get', 'viewport_set', 'undo'
]);

export const CORE_TOOLS = new Set([
  'canvas_import_react', 'canvas_get_import_report', 'canvas_preview_import', 'canvas_preview_action',
  'open_canvas', 'list_documents', 'create_canvas', 'rename_canvas',
  'canvas_status', 'canvas_diagnostics', 'list_open_canvases', 'switch_canvas', 'get_node', 'get_selection',
  'get_page_tree', 'get_current_page', 'list_pages', 'get_font_status',
  'find_nodes', 'query_nodes', 'create_shape', 'create_vector', 'create_page',
  'delete_node', 'clone_node', 'group_nodes', 'arrange', 'batch_update',
  'export_image', 'export_jsx', 'export_svg', 'redo', 'save_document',
  'send_selection_to_chat', 'canvas_set_annotation',
  ...[...COMPATIBILITY_TOOLS].map(name => `canvas_${name}`)
]);

export function addCompatibilityTools(server) {
  const profile = process.env.CANVY_TOOL_PROFILE ?? process.env.FREECANVAS_TOOL_PROFILE ?? 'core';
  if (!['core', 'full'].includes(profile)) throw new Error('CANVY_TOOL_PROFILE must be core or full');
  const isAdvertised = (name, isPublic) => !isPublic || profile === 'full' || CORE_TOOLS.has(name);
  // Filter discovery, not execution. Legacy clients keep their validated handlers;
  // Codex receives a compact list without duplicate names displacing basic reads.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (method, ...args) => {
    if (method === 'tools/list') {
      const handler = args.pop();
      args.push(async (...input) => {
        const result = await handler(...input);
        return { ...result, tools: result.tools.filter(tool => isAdvertised(tool.name, !tool._meta?.ui?.visibility || tool._meta.ui.visibility.includes('model'))) };
      });
    }
    return setRequestHandler(method, ...args);
  };
  const register = server.registerTool.bind(server);
  const catalog = [];
  catalog.profile = profile;
  server.registerTool = (name, options, handler) => {
    const tool = register(name, options, handler);
    const isPublic = !options._meta?.ui?.visibility || options._meta.ui.visibility.includes('model');
    catalog.push({ name, public: isPublic, advertised: isAdvertised(name, isPublic) });
    if (COMPATIBILITY_TOOLS.has(name)) {
      const alias = `canvas_${name}`;
      register(alias, { ...options, title: alias, description: `${options.description} Compatibility name for ${name}; same validated inputs and behavior.`, _meta: { ...options._meta, 'freecanvas/aliasOf': name } }, handler);
      catalog.push({ name: alias, public: true, advertised: isAdvertised(alias, true), aliasOf: name });
    }
    return tool;
  };
  return catalog;
}
