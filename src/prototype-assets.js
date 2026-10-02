// Serialized into isolated capture/preview documents; no native host access.
export function installPrototypeAssets() {
  // The native host permits blob resources, but may reject data: webfonts.
  // Create blobs in this opaque child (not its differently originated parent).
  if (window.__canvyAssetOriginals) return;
  const originals = window.__canvyAssetOriginals = new Map(), resources = new Map();
  function resource(value) {
    if (!value?.startsWith('data:')) return value;
    if (resources.has(value)) return resources.get(value);
    const match = value.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
    if (!match) return value;
    try {
      const data = match[2] ? Uint8Array.from(atob(match[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3]));
      const url = URL.createObjectURL(new Blob([data], { type: match[1] || 'application/octet-stream' }));
      resources.set(value, url); originals.set(url, value); return url;
    } catch { return value; }
  }
  const cssValue = value => value.replace(/url\((['"]?)(data:.*?)\1\)/gs, (_, quote, data) => `url("${resource(data)}")`);
  const rewriteStyle = style => {
    for (const key of [...style]) { const value = style.getPropertyValue(key), next = cssValue(value); if (next !== value) style.setProperty(key, next, style.getPropertyPriority(key)); }
  };
  function rules(list) { for (const rule of list) { if (rule.style) rewriteStyle(rule.style); if (rule.cssRules) rules(rule.cssRules); } }
  for (const sheet of document.styleSheets) { try { rules(sheet.cssRules); } catch { /* CSP error is reported through the existing listener. */ } }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (name.toLowerCase() === 'src' && this instanceof HTMLImageElement) value = resource(String(value));
    if (name.toLowerCase() === 'style') value = cssValue(String(value));
    return setAttribute.call(this, name, value);
  };
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { ...imageSrc, set(value) { imageSrc.set.call(this, resource(String(value))); } });
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'style') rewriteStyle(record.target.style);
      for (const node of record.addedNodes) if (node.nodeType === 1) {
        for (const element of [node, ...node.querySelectorAll('img,[style]')]) {
          if (element instanceof HTMLImageElement && element.src.startsWith('data:')) element.src = element.src;
          if (element.style) rewriteStyle(element.style);
        }
        if (node.tagName === 'STYLE' && node.sheet) rules(node.sheet.cssRules);
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  addEventListener('unload', () => { for (const url of resources.values()) URL.revokeObjectURL(url); });
}
