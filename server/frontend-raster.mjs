// Capture only browser-only decorations or unsupported composites. Every raster
// is disclosed; its source CSS/SVG and editable subtree remain in the checkpoint.
export async function captureRasterLayers(page, snapshot) {
  for (const node of snapshot.nodes.filter(n => n.raster)) {
    const locator = page.locator(`[data-canvy-capture="${node.key}"]`);
    const state = await locator.evaluate((element, mode) => {
      const changed = [], alter = (e, property, value) => {
        changed.push([e, property, e.style.getPropertyValue(property), e.style.getPropertyPriority(property)]);
        e.style.setProperty(property, value, 'important');
      };
      for (const e of document.querySelectorAll('body *')) {
        if (mode === 'backdrop') break;
        if (e === element || element.contains(e) || e.contains(element) || e.tagName === 'STYLE') continue;
        alter(e, 'visibility', 'hidden');
      }
      for (let e = element.parentElement; e; e = e.parentElement) {
        if (mode === 'backdrop') break;
        for (const property of ['background', 'box-shadow', 'border-color']) alter(e, property, property === 'box-shadow' ? 'none' : 'transparent');
      }
      alter(element, 'opacity', '1');
      if (mode === 'decoration') {
        // Keep generated content; hide direct text through transparent color,
        // and children without changing their layout or React state.
        const rules = document.createElement('style');
        rules.textContent = ['::before', '::after'].map(p => {
          const s = getComputedStyle(element, p);
          return `[data-canvy-capture="${element.dataset.canvyCapture}"]${p}{color:${s.color}!important}`;
        }).join(''); document.head.append(rules);
        for (const child of element.children) alter(child, 'visibility', 'hidden');
        const style = getComputedStyle(element);
        for (const side of ['top', 'right', 'bottom', 'left']) alter(element, `border-${side}-color`, style.getPropertyValue(`border-${side}-color`));
        alter(element, 'color', 'transparent'); alter(element, 'text-shadow', 'none'); alter(element, 'box-shadow', 'none');
        changed.push([rules, '__remove']);
      }
      window.__canvyRasterRestore = () => {
        for (const [e, property, value, priority] of changed.reverse()) {
          if (property === '__remove') e.remove();
          else if (value) e.style.setProperty(property, value, priority); else e.style.removeProperty(property);
        }
        delete window.__canvyRasterRestore;
      };
      return true;
    }, node.raster.backdrop ? 'backdrop' : node.raster.mode);
    try {
      if (state) {
        const clip = await locator.evaluate(element => {
          const r = element.getBoundingClientRect();
          const x = Math.max(0, Math.floor(r.x + scrollX)), y = Math.max(0, Math.floor(r.y + scrollY));
          return { x, y, width: Math.ceil(r.right + scrollX) - x, height: Math.ceil(r.bottom + scrollY) - y };
        });
        const png = await page.screenshot({ clip, omitBackground: true, animations: 'disabled' });
        node.raster.box = { ...clip, x: clip.x - snapshot.origin.x, y: clip.y - snapshot.origin.y };
        node.raster.data = 'data:image/png;base64,' + png.toString('base64');
        snapshot.issues.push({ code: 'RASTERIZED_LAYER', selector: node.name, message: `${node.raster.reason}; ${node.raster.mode === 'decoration' ? 'text and children remain editable' : 'editable source subtree is retained hidden beneath the visual layer'}` });
      }
    } finally { await page.evaluate(() => window.__canvyRasterRestore?.()); }
  }
  await page.evaluate(() => {
    for (const [e, value] of window.__canvyCaptureAttributes ?? []) value === null ? e.removeAttribute('data-canvy-capture') : e.setAttribute('data-canvy-capture', value);
    delete window.__canvyCaptureAttributes;
  });
}
