// Serialized into the capture browser. Keep this function self-contained.
export async function collectFrontend({ selector, maxNodes }) {
  const root = document.querySelector(selector);
  if (!root) throw new Error('Capture selector was not found');
  const bounds = root.getBoundingClientRect(), nodes = [], issues = [], assets = [];
  window.__canvyCaptureAttributes = [];
  const issue = (code, element, message) => issues.push({ code, selector: element.id ? '#' + element.id : element.tagName.toLowerCase(), message });
  const color = value => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  };
  const box = r => ({ x: r.x - bounds.x, y: r.y - bounds.y, width: r.width, height: r.height });
  const shadows = value => value === 'none' ? [] : value.split(/,(?![^()]*\))/).map(shadow => {
    const paint = shadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0] ?? 'black';
    const lengths = shadow.replace(paint, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
    return { type: shadow.includes('inset') ? 'INNER_SHADOW' : 'DROP_SHADOW', color: color(paint), offset: { x: lengths[0] ?? 0, y: lengths[1] ?? 0 }, radius: lengths[2] ?? 0, spread: lengths[3] ?? 0, visible: true };
  });
  const split = value => {
    const parts = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) { if (value[i] === '(') depth++; if (value[i] === ')') depth--; if (value[i] === ',' && !depth) { parts.push(value.slice(start, i).trim()); start = i + 1; } }
    parts.push(value.slice(start).trim()); return parts;
  };
  function linearGradient(value, width, height) {
    if (!value.startsWith('linear-gradient(') || !value.endsWith(')')) return null;
    const parts = split(value.slice(16, -1)); let angle = Math.PI;
    if (/^(to |[-\d.]+(?:deg|rad|turn))/.test(parts[0])) {
      const direction = parts.shift();
      if (direction.startsWith('to ')) {
        const dx = direction.includes('right') ? 1 : direction.includes('left') ? -1 : 0;
        const dy = direction.includes('bottom') ? 1 : direction.includes('top') ? -1 : 0;
        angle = Math.atan2(dx * (dy ? height : 1), -dy * (dx ? width : 1));
      } else angle = parseFloat(direction) * (direction.endsWith('turn') ? Math.PI * 2 : direction.endsWith('rad') ? 1 : Math.PI / 180);
    }
    const dx = Math.sin(angle), dy = -Math.cos(angle), length = Math.abs(width * dx) + Math.abs(height * dy);
    const stops = [];
    for (const part of parts) {
      const match = part.match(/^(.*?)(?:\s+(-?[\d.]+)(%|px))?$/);
      if (!CSS.supports('color', match[1]) || stops.length >= 32) return null;
      stops.push({ color: color(match[1]), position: match[2] === undefined ? null : Number(match[2]) / (match[3] === '%' ? 100 : length) });
    }
    if (stops.length < 2) return null;
    stops[0].position ??= 0; stops.at(-1).position ??= 1;
    let previous = 0;
    for (let i = 1; i < stops.length; i++) if (stops[i].position !== null) {
      stops[i].position = Math.max(stops[previous].position, stops[i].position);
      for (let j = previous + 1; j < i; j++) stops[j].position = stops[previous].position + (stops[i].position - stops[previous].position) * (j - previous) / (i - previous);
      previous = i;
    }
    if (stops.some(s => s.position < 0 || s.position > 1)) return null;
    // OpenPencil's native shader traverses the transform from endpoint to origin.
    const ex = .5 + dx * length / width / 2, ey = .5 + dy * length / height / 2;
    return { type: 'GRADIENT_LINEAR', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, gradientStops: stops, gradientTransform: { m00: -dx * length / width, m01: 0, m02: ex, m10: -dy * length / height, m11: 1, m12: ey } };
  }
  const fonts = [];
  function rules(list) {
    for (const rule of list) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const s = rule.style, src = s.getPropertyValue('src'), url = src.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
        fonts.push({ family: s.getPropertyValue('font-family').replace(/["']/g, ''), weight: s.getPropertyValue('font-weight') || '400', style: s.getPropertyValue('font-style') || 'normal', url: url ? new URL(url, document.baseURI).href : undefined });
      } else if (rule.cssRules) rules(rule.cssRules);
    }
  }
  for (const sheet of document.styleSheets) { try { rules(sheet.cssRules); } catch { issue('STYLESHEET_UNREADABLE', root, 'Stylesheet rules could not be read'); } }
  function visit(element, parent) {
    if (nodes.length >= maxNodes) throw new Error(`Capture exceeds ${maxNodes} nodes`);
    const s = getComputedStyle(element), r = element.getBoundingClientRect();
    if (s.display === 'contents') { for (const child of element.children) visit(child, parent); return; }
    if (s.display === 'none' || s.visibility === 'hidden' || !r.width || !r.height) return;
    const key = 'dom:' + nodes.length;
    window.__canvyCaptureAttributes.push([element, element.getAttribute('data-canvy-capture')]);
    element.setAttribute('data-canvy-capture', key);
    const background = color(s.backgroundColor);
    const common = { key, parent, name: element.getAttribute('data-canvy-name') || element.getAttribute('aria-label') || element.id || element.tagName.toLowerCase(), box: box(r), opacity: Number(s.opacity), fill: background, radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(v => v.endsWith('%') ? parseFloat(v) / 100 * Math.min(r.width, r.height) : parseFloat(v)), clip: ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflow), borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({ width: parseFloat(s['border' + side + 'Width']), color: color(s['border' + side + 'Color']), style: s['border' + side + 'Style'] })), effects: shadows(s.boxShadow) };
    common.css = { backgroundImage: s.backgroundImage, filter: s.filter, backdropFilter: s.backdropFilter, transform: s.transform, zIndex: s.zIndex, mixBlendMode: s.mixBlendMode };
    const raster = (mode, reason) => { if (common.raster?.mode !== 'composite') common.raster = { mode, reason }; };
    if (s.transform !== 'none') {
      const m = new DOMMatrix(s.transform);
      if (!m.is2D || m.b || m.c || m.a !== 1 || m.d !== 1) raster('composite', 'Transform preserved as a browser visual layer');
    }
    for (const [value, type] of [[s.filter, 'LAYER_BLUR'], [s.backdropFilter, 'BACKGROUND_BLUR']]) if (value !== 'none') {
      const blur = value.match(/^blur\(([\d.]+)px\)$/);
      if (blur) common.effects.push({ type, radius: parseFloat(blur[1]) * 2, color: { r: 0, g: 0, b: 0, a: 0 }, offset: { x: 0, y: 0 }, spread: 0, visible: true });
      else raster('composite', 'CSS filter preserved as a browser visual layer');
    }
    if (s.backgroundImage !== 'none') {
      common.backgroundPaint = linearGradient(s.backgroundImage, r.width, r.height);
      if (!common.backgroundPaint) raster('decoration', 'CSS background preserved as a browser visual layer');
      for (const match of s.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) assets.push({ kind: 'image', url: match[1], data: window.__canvyAssetOriginals?.get(match[1]) ?? (match[1].startsWith('data:') ? match[1] : null) });
    }
    if (s.mixBlendMode !== 'normal') {
      if (['plus-lighter', 'plus-darker'].includes(s.mixBlendMode)) { raster('composite', 'Browser blend operation preserved with its initial backdrop'); common.raster.backdrop = true; }
      else common.blendMode = s.mixBlendMode.replaceAll('-', '_').toUpperCase();
    }
    if (s.clipPath !== 'none' || s.maskImage !== 'none') raster('composite', 'CSS clipping or mask preserved as a browser visual layer');
    if (s.backgroundBlendMode !== 'normal') raster('decoration', 'Blended CSS background preserved as a decoration layer');
    if (common.borders.some(b => b.width && !['solid', 'none'].includes(b.style))) raster('decoration', 'CSS border decoration preserved as a browser visual layer');
    if (s.writingMode !== 'horizontal-tb') raster('composite', 'Vertical text layout preserved as a browser visual layer');
    if (s.zIndex !== 'auto' && element.parentElement !== root && getComputedStyle(element.parentElement).zIndex === 'auto') issue('STACKING_CONTEXT', element, 'Cross-ancestor stacking requires visual review; ordinary sibling order is preserved');
    if (s.textOverflow === 'ellipsis') raster('composite', 'Browser text truncation preserved as a visual layer');
    if (s.animationName !== 'none') issue('ANIMATION', element, 'Animation is captured at one instant; native nodes do not animate');
    for (const pseudo of ['::before', '::after']) { const p = getComputedStyle(element, pseudo); if (p.content !== 'none' && p.content !== 'normal') raster('decoration', 'Generated CSS content preserved as a browser decoration layer'); }
    if (element instanceof SVGElement && element.tagName.toLowerCase() === 'svg') {
      const clone = element.cloneNode(true), originals = [element, ...element.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
      originals.forEach((source, index) => {
        const style = getComputedStyle(source);
        for (const attribute of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'color']) copies[index].setAttribute(attribute, style.getPropertyValue(attribute));
      });
      clone.setAttribute('width', String(r.width)); clone.setAttribute('height', String(r.height));
      const svg = new XMLSerializer().serializeToString(clone);
      const unsupported = element.querySelector('filter,mask,foreignObject,text,image,animate,animateTransform');
      if (unsupported) raster('composite', `Complex SVG ${unsupported.tagName} preserved as a browser visual layer and original markup`);
      nodes.push({ ...common, type: 'svg', svg }); return;
    }
    if (element instanceof HTMLImageElement) {
      const url = element.currentSrc || element.src;
      if (!element.complete || !element.naturalWidth) issue('IMAGE_MISSING', element, 'Image did not decode; no replacement image will be invented');
      assets.push({ kind: 'image', url, data: window.__canvyAssetOriginals?.get(url) ?? (url.startsWith('data:') ? url : null) });
      nodes.push({ ...common, type: 'image', url, objectFit: s.objectFit, objectPosition: s.objectPosition, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight }); return;
    }
    if (element instanceof HTMLCanvasElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) raster('composite', 'Browser control or canvas visual preserved; its original interactive implementation remains in the preview');
    if (['VIDEO', 'IFRAME'].includes(element.tagName)) issue('REPLACED_ELEMENT', element, `${element.tagName.toLowerCase()} requires a local poster; nested/network documents are blocked`);
    nodes.push({ ...common, type: 'container' });
    // CSS painting order for ordinary sibling stacking contexts. Cross-ancestor
    // positioned descendants are detected and disclosed rather than flattened.
    const children = [...element.childNodes].sort((a, b) => (a.nodeType === 1 ? parseInt(getComputedStyle(a).zIndex) || 0 : 0) - (b.nodeType === 1 ? parseInt(getComputedStyle(b).zIndex) || 0 : 0));
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, key);
      else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(child);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = s.whiteSpace.startsWith('pre') ? child.textContent : child.textContent.replace(/\s+/g, ' ');
        const transformed = s.textTransform === 'uppercase' ? text.toUpperCase() : s.textTransform === 'lowercase' ? text.toLowerCase() : text;
        const family = s.fontFamily.split(',')[0].trim().replace(/["']/g, '');
        if (nodes.length >= maxNodes) throw new Error(`Capture exceeds ${maxNodes} nodes`);
        const textProps = { parent: key, type: 'text', color: color(s.color), family, weight: parseInt(s.fontWeight) || 400, fontStyle: s.fontStyle, fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2, letterSpacing: parseFloat(s.letterSpacing) || 0, align: s.textAlign, decoration: s.textDecorationLine };
        // Preserve actual line breaks/inline wrapping instead of asking Skia to
        // reflow a bounding rectangle with a potentially different line breaker.
        if (range.getClientRects().length > 1) {
          const lines = [];
          for (let i = 0; i < child.textContent.length; i++) {
            range.setStart(child, i); range.setEnd(child, i + 1); const glyph = range.getBoundingClientRect();
            if (!glyph.width || !glyph.height) continue;
            let line = lines.at(-1);
            if (!line || Math.abs(line.rect.y - glyph.y) > 1) lines.push(line = { text: '', rect: { x: glyph.x, y: glyph.y, width: 0, height: glyph.height } });
            line.text += child.textContent[i]; line.rect.width = Math.max(line.rect.width, glyph.right - line.rect.x);
          }
          for (const line of lines) {
            const text = s.textTransform === 'uppercase' ? line.text.toUpperCase() : s.textTransform === 'lowercase' ? line.text.toLowerCase() : line.text;
            if (nodes.length >= maxNodes) throw new Error(`Capture exceeds ${maxNodes} nodes`);
            nodes.push({ ...textProps, key: 'dom:' + nodes.length, name: text.slice(0, 60), box: box(line.rect), text });
          }
        } else nodes.push({ ...textProps, key: 'dom:' + nodes.length, name: transformed.slice(0, 60), box: box(rect), text: transformed });
        if (!fonts.some(f => f.family === family)) issue('FONT_UNAVAILABLE', element, `Original font bytes are unavailable for ${family}; native fallback must be reviewed`);
        if (s.fontStyle.startsWith('oblique')) issue('FONT_STYLE', element, 'Oblique font angle requires review');
      }
    }
    if ('value' in element && element.value) nodes.push({ key: 'dom:' + nodes.length, parent: key, name: 'Control value', type: 'text', box: box(r), text: element.value, color: color(s.color), family: s.fontFamily.split(',')[0].trim().replace(/["']/g, ''), weight: parseInt(s.fontWeight) || 400, fontStyle: s.fontStyle, fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2, letterSpacing: 0, align: 'left' });
  }
  visit(root, null);
  for (const font of fonts) assets.push({ kind: 'font', ...font, data: window.__canvyAssetOriginals?.get(font.url) ?? (font.url?.startsWith('data:') ? font.url : null) });
  return { origin: { x: bounds.x + scrollX, y: bounds.y + scrollY }, width: Math.max(bounds.width, root.scrollWidth), height: Math.max(bounds.height, root.scrollHeight), nodes, assets, issues };
}
