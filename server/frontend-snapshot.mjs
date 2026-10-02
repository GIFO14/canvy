// Serialized into the capture browser. Keep this function self-contained.
export async function collectFrontend({ selector, maxNodes }) {
  const root = document.querySelector(selector);
  if (!root) throw new Error('Capture selector was not found');
  const bounds = root.getBoundingClientRect(), nodes = [], issues = [], assets = [];
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
    const background = color(s.backgroundColor);
    const common = { key, parent, name: element.getAttribute('data-canvy-name') || element.getAttribute('aria-label') || element.id || element.tagName.toLowerCase(), box: box(r), opacity: Number(s.opacity), fill: background, radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(v => v.endsWith('%') ? parseFloat(v) / 100 * Math.min(r.width, r.height) : parseFloat(v)), clip: ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflow), borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({ width: parseFloat(s['border' + side + 'Width']), color: color(s['border' + side + 'Color']), style: s['border' + side + 'Style'] })), effects: shadows(s.boxShadow) };
    if (s.zIndex !== 'auto' && s.zIndex !== '0') issue('STACKING_ORDER', element, 'Explicit stacking contexts need visual review; capture preserves DOM order');
    if (s.transform !== 'none') issue('TRANSFORM', element, 'Transformed bounds are captured; non-axis-aligned transforms are not yet converted');
    if (s.filter !== 'none' || s.backdropFilter !== 'none') issue('FILTER', element, 'CSS filter/backdrop-filter cannot be reproduced as editable nodes');
    if (s.backgroundImage !== 'none') issue('BACKGROUND_IMAGE', element, 'CSS background images/gradients are not converted yet');
    if (s.mixBlendMode !== 'normal') issue('BLEND_MODE', element, `Unsupported blend mode: ${s.mixBlendMode}`);
    if (s.animationName !== 'none') issue('ANIMATION', element, 'Animation is captured at one instant; native nodes do not animate');
    for (const pseudo of ['::before', '::after']) { const p = getComputedStyle(element, pseudo); if (p.content !== 'none' && p.content !== 'normal' && p.content !== '""') issue('PSEUDO_ELEMENT', element, `${pseudo} content is not converted yet`); }
    if (element instanceof SVGElement && element.tagName.toLowerCase() === 'svg') {
      const clone = element.cloneNode(true), originals = [element, ...element.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
      originals.forEach((source, index) => {
        const style = getComputedStyle(source);
        for (const attribute of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'color']) copies[index].setAttribute(attribute, style.getPropertyValue(attribute));
      });
      clone.setAttribute('width', String(r.width)); clone.setAttribute('height', String(r.height));
      const svg = new XMLSerializer().serializeToString(clone);
      const unsupported = element.querySelector('filter,mask,foreignObject,text,image,animate,animateTransform');
      if (unsupported) issue('SVG_FEATURE', element, `SVG ${unsupported.tagName} may not convert faithfully; original markup is preserved`);
      nodes.push({ ...common, type: 'svg', svg }); return;
    }
    if (element instanceof HTMLImageElement) {
      const url = element.currentSrc || element.src;
      if (!element.complete || !element.naturalWidth) issue('IMAGE_MISSING', element, 'Image did not decode; no replacement image will be invented');
      assets.push({ kind: 'image', url, data: url.startsWith('data:') ? url : null });
      nodes.push({ ...common, type: 'image', url, objectFit: s.objectFit }); return;
    }
    if (element instanceof HTMLCanvasElement || ['VIDEO', 'IFRAME'].includes(element.tagName)) { issue('REPLACED_ELEMENT', element, `${element.tagName.toLowerCase()} is not editable in the native import`); }
    nodes.push({ ...common, type: 'container' });
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child, key);
      else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(child);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const text = s.whiteSpace.startsWith('pre') ? child.textContent : child.textContent.replace(/\s+/g, ' ');
        const transformed = s.textTransform === 'uppercase' ? text.toUpperCase() : s.textTransform === 'lowercase' ? text.toLowerCase() : text;
        const family = s.fontFamily.split(',')[0].trim().replace(/["']/g, '');
        if (nodes.length >= maxNodes) throw new Error(`Capture exceeds ${maxNodes} nodes`);
        nodes.push({ key: 'dom:' + nodes.length, parent: key, name: transformed.slice(0, 60), type: 'text', box: box(rect), text: transformed, color: color(s.color), family, weight: parseInt(s.fontWeight) || 400, fontStyle: s.fontStyle, fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2, letterSpacing: parseFloat(s.letterSpacing) || 0, align: s.textAlign, decoration: s.textDecorationLine });
        if (range.getClientRects().length > 1) issue('TEXT_WRAPPING', element, 'Browser line fragments are captured as one editable text block; shaping may differ');
        if (!fonts.some(f => f.family === family)) issue('FONT_UNAVAILABLE', element, `Original font bytes are unavailable for ${family}; native fallback must be reviewed`);
        if (s.fontStyle !== 'normal') issue('FONT_STYLE', element, 'Italic/oblique font rendering needs review');
      }
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) issue('FORM_CONTROL', element, 'Browser form-control chrome is not converted; interactive preview preserves it');
  }
  visit(root, null);
  for (const font of fonts) assets.push({ kind: 'font', ...font, data: font.url?.startsWith('data:') ? font.url : null });
  return { width: Math.max(bounds.width, root.scrollWidth), height: Math.max(bounds.height, root.scrollHeight), nodes, assets, issues };
}
