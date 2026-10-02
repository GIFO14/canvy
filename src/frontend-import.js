import { createSVGNodes } from '@open-pencil/core/io';
import { fontManager } from '@open-pencil/core/text';
import { weightToStyle } from '@open-pencil/scene-graph';

const bytes = data => {
  const match = data?.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) return null;
  return { mime: match[1], data: match[2] ? Uint8Array.from(atob(match[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3])) };
};
const paint = color => ({ type: 'SOLID', color, opacity: 1, visible: true });
const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('');
export function restoreImportFonts(graph) {
  for (const font of Object.values(graph.canvyResources?.fonts ?? {})) {
    const resource = bytes(font.data);
    if (resource && font.registered) fontManager.markLoaded(font.alias, font.style, resource.data.buffer, 'registered');
  }
}

export async function importFrontend(editor, figma, packet, position = {}) {
  if (packet.version !== 1 || !Array.isArray(packet.variants)) throw new Error('Unsupported frontend capture');
  if (editor.graph.nodes.size + packet.variants.reduce((n, v) => n + v.nodes.length, 0) > 10000) throw new Error('Import exceeds reversible document node limit');
  const graph = editor.graph;
  const resources = graph.canvyResources ??= { fonts: {}, imports: {} };
  const import_id = crypto.randomUUID(), report = [...packet.issues], families = new Map();
  for (const asset of packet.variants.flatMap(v => v.assets).filter(a => a.kind === 'font')) {
    if (!asset.data) { report.push({ code: 'FONT_MISSING', message: `Original bytes unavailable: ${asset.family}` }); continue; }
    const data = bytes(asset.data), hash = await digest(data.data);
    const alias = `${asset.family} Canvy ${hash.slice(0, 12)}`;
    const weight = parseInt(asset.weight) || 400, style = weightToStyle(weight) + (asset.style === 'italic' ? ' Italic' : '');
    const key = `${alias}:${style}`;
    if (!resources.fonts[key]) {
      // CanvasKit may not support every webfont format. Preserve bytes and
      // report a failed registration rather than calling a fallback faithful.
      const face = editor.renderer?.ck.Typeface.MakeFreeTypeFaceFromData(data.data);
      const registered = Boolean(face); face?.delete();
      resources.fonts[key] = { family: asset.family, alias, weight, style, data: asset.data, registered };
      if (registered) fontManager.markLoaded(alias, style, data.data.buffer, 'registered');
      else report.push({ code: 'FONT_NATIVE_UNSUPPORTED', message: `Native renderer cannot load ${asset.family}; original bytes remain in the prototype` });
    }
    if (resources.fonts[key].registered) families.set(`${asset.family}:${weight}:${asset.style}`, alias);
    if (/\d+\s+\d+/.test(asset.weight)) report.push({ code: 'VARIABLE_FONT', message: `${asset.family}: variable weight range needs review in the native renderer` });
  }
  const frames = [], originals = [], x0 = position.x ?? 0, y0 = position.y ?? 0;
  let x = x0;
  for (const variant of packet.variants) {
    const issues = [...variant.issues], mapping = {}, byKey = new Map(variant.nodes.map(n => [n.key, n]));
    const frame = graph.createNode('FRAME', editor.state.currentPageId, { name: `${packet.name} · ${variant.viewport.width}px`, x, y: y0, width: variant.width, height: variant.height, fills: [paint({ r: 1, g: 1, b: 1, a: 1 })], clipsContent: true });
    for (const source of variant.nodes) {
      const parent = source.parent ? graph.getNode(mapping[source.parent]) : frame;
      if (!parent) throw new Error('Invalid frontend node hierarchy');
      const parentBox = source.parent ? byKey.get(source.parent).box : { x: 0, y: 0 };
      const b = source.box;
      if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0) throw new Error('Invalid captured geometry');
      const props = { name: source.name, x: b.x - parentBox.x, y: b.y - parentBox.y, width: b.width, height: b.height, opacity: source.opacity ?? 1, fills: source.fill?.a ? [paint(source.fill)] : [], effects: source.effects ?? [], clipsContent: Boolean(source.clip), layoutMode: 'NONE' };
      if (source.radius) Object.assign(props, { cornerRadius: source.radius[0], independentCorners: true, topLeftRadius: source.radius[0], topRightRadius: source.radius[1], bottomRightRadius: source.radius[2], bottomLeftRadius: source.radius[3] });
      let svg = source.svg, image;
      if (source.type === 'image') {
        image = bytes(variant.assets.find(a => a.kind === 'image' && a.url === source.url)?.data);
        if (image?.mime === 'image/svg+xml') {
          svg = new TextDecoder().decode(image.data);
          // CSS dimensions are authoritative, including SVGs imported as <img>.
          svg = svg.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(?:width|height)=["'][^"']*["']/g, '')} width="${b.width}" height="${b.height}">`);
        }
      }
      let node;
      if (svg) {
        originals.push({ key: source.key, viewport: variant.viewport.width, svg });
        node = createSVGNodes(graph, parent.id, svg, props);
        if (!node) issues.push({ code: 'SVG_CONVERSION_FAILED', message: `Original SVG preserved: ${source.name}` });
      }
      if (!node) {
        if (source.type === 'text') {
          const family = families.get(`${source.family}:${source.weight}:${source.fontStyle}`) ?? source.family;
          if (family === source.family && variant.assets.some(a => a.kind === 'font' && a.family === source.family)) issues.push({ code: 'FONT_FACE_MISSING', message: `Exact ${source.weight} ${source.fontStyle} face unavailable for ${source.family}; native fallback needs review` });
          Object.assign(props, { text: source.text, fills: [paint(source.color)], fontFamily: family, fontWeight: source.weight, italic: source.fontStyle === 'italic', fontSize: source.fontSize, lineHeight: source.lineHeight, letterSpacing: source.letterSpacing, textAutoResize: 'NONE', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textDecoration: source.decoration?.includes('underline') ? 'UNDERLINE' : source.decoration?.includes('line-through') ? 'STRIKETHROUGH' : 'NONE' });
          // Range bounds already include alignment and inline positioning.
          props.y -= Math.max(0, (source.lineHeight - b.height) / 2);
          props.height = Math.max(b.height, source.lineHeight);
          // Fractional glyph bounds are sometimes rounded by Skia's layout.
          props.width += 1;
        } else if (image && !svg) {
          const hash = figma.createImage(image.data).hash;
          props.fills = [{ type: 'IMAGE', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, imageHash: hash, imageScaleMode: source.objectFit === 'contain' ? 'FIT' : 'FILL' }];
          if (!['cover', 'contain'].includes(source.objectFit)) issues.push({ code: 'IMAGE_FIT', message: `Review object-fit ${source.objectFit}: ${source.name}; native image fill uses cover` });
        } else if (source.type === 'image') issues.push({ code: 'IMAGE_MISSING', message: `Original image unavailable: ${source.name}` });
        node = graph.createNode(source.type === 'text' ? 'TEXT' : source.type === 'image' ? 'RECTANGLE' : 'FRAME', parent.id, props);
      } else graph.updateNode(node.id, props);
      mapping[source.key] = node.id;
      const borders = source.borders?.filter(v => v.width > 0 && v.style !== 'none') ?? [];
      if (borders.length) {
        if (borders.length === 4 && borders.every(v => v.style === 'solid' && v.width === borders[0].width && JSON.stringify(v.color) === JSON.stringify(borders[0].color))) graph.updateNode(node.id, { strokes: [{ color: borders[0].color, weight: borders[0].width, opacity: 1, visible: true, align: 'INSIDE' }] });
        else for (const [side, border] of source.borders.entries()) {
          if (!border.width || border.style === 'none') continue;
          if (border.style !== 'solid') issues.push({ code: 'BORDER_STYLE', message: `Border ${border.style} requires review: ${source.name}` });
          const horizontal = side === 0 || side === 2;
          graph.createNode('RECTANGLE', node.id, { name: `Border ${side}`, x: side === 1 ? b.width - border.width : 0, y: side === 2 ? b.height - border.width : 0, width: horizontal ? b.width : border.width, height: horizontal ? border.width : b.height, fills: [paint(border.color)] });
        }
      }
    }
    frames.push({ id: frame.id, viewport: variant.viewport, node_map: mapping, issues });
    x += variant.width + 80;
  }
  if (graph.nodes.size + graph.variables.size > 10000) throw new Error('Converted SVGs exceed reversible document node limit');
  resources.imports[import_id] = { name: packet.name, html: packet.html, originals, frames, issues: report, createdAt: new Date().toISOString() };
  editor.select(frames.map(f => f.id)); editor.zoomToFit(); editor.requestRender();
  return { import_id, frames, issues: report, warning_count: report.length + frames.reduce((n, f) => n + f.issues.length, 0), interactive_preview: true };
}
