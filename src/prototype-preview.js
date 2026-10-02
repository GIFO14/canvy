import { reactive } from 'vue';
export const preview = reactive({ current: null, ready: false, error: '' });
let frame, pending = new Map(), listener;
// This function executes only inside the opaque, script-only prototype frame.
function childBridge() {
  const channel = 'canvy-prototype-v1';
  const snapshot = () => ({ text: document.body.innerText.slice(0, 20000), controls: [...document.querySelectorAll('button,input,select,textarea,[role=dialog],a')].slice(0, 100).map(e => ({ tag: e.tagName.toLowerCase(), id: e.id, role: e.getAttribute('role'), label: e.getAttribute('aria-label') || e.textContent?.slice(0, 100), value: 'value' in e ? e.value : undefined })) });
  addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== parent || data?.channel !== channel || !data.id) return;
    try {
      const { action, selector, value } = data;
      if (action === 'click' || action === 'fill') {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Preview selector was not found');
        if (action === 'click') { if (node.disabled) throw new Error('Preview control is disabled'); node.click(); }
        else {
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) throw new Error('Fill requires a form field');
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set;
          setter.call(node, value ?? ''); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (action !== 'snapshot') throw new Error('Unsupported preview action');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      parent.postMessage({ channel, id: data.id, result: snapshot() }, '*');
    } catch (error) { parent.postMessage({ channel, id: data.id, error: error.message }, '*'); }
  });
  addEventListener('error', event => parent.postMessage({ channel, error: event.message }, '*'));
  addEventListener('securitypolicyviolation', event => parent.postMessage({ channel, warning: `Blocked prototype resource: ${event.violatedDirective}` }, '*'));
  addEventListener('load', async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); parent.postMessage({ channel, ready: true }, '*'); });
}
export function previewHtml(html) {
  return html.replace('</body>', `<script>(${childBridge.toString()})();</script></body>`);
}
export function attachPreview(element) {
  frame = element;
  listener = event => {
    if (event.source !== frame?.contentWindow || event.data?.channel !== 'canvy-prototype-v1') return;
    const data = event.data;
    if (data.ready) preview.ready = true;
    if (data.error && !data.id) preview.error = data.error;
    if (data.warning) preview.error = data.warning;
    const request = pending.get(data.id);
    if (request) { pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(new Error(data.error)) : request.resolve(data.result); }
  };
  window.addEventListener('message', listener);
}
export function detachPreview() {
  window.removeEventListener('message', listener); frame = null; preview.ready = false;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Preview closed')); }
  pending.clear();
}
export function closePreview() { preview.current = null; preview.ready = false; preview.error = ''; detachPreview(); }
export function openPreview(graph, args = {}) {
  const imports = Object.entries(graph.canvyResources?.imports ?? {});
  const match = args.import_id ? imports.find(([id]) => id === args.import_id) : imports.find(([, value]) => value.frames.some(f => f.id === args.frame_id));
  if (!match) throw new Error('Choose a frame created by canvas_import_react');
  const [import_id, data] = match;
  const variant = data.frames.find(f => f.id === args.frame_id) ?? data.frames[0];
  if (!graph.getNode(variant.id)) throw new Error('Imported frame no longer exists');
  closePreview();
  preview.current = { import_id, name: data.name, html: data.html, width: args.width ?? variant.viewport.width, height: args.height ?? variant.viewport.height };
  return { import_id, frame_id: variant.id, width: preview.current.width, height: preview.current.height };
}
export async function previewAction(args) {
  if (args.action === 'close') { closePreview(); return { closed: true }; }
  if (!preview.current) throw new Error('Open an imported prototype with canvas_preview_import first');
  const deadline = Date.now() + 10000;
  while (!preview.ready && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (!preview.ready || !frame) throw new Error(preview.error || 'Interactive preview did not initialize; check host iframe CSP support');
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Preview action timed out; do not replay an uncertain action')); }, 8000);
    pending.set(id, { resolve, reject, timer });
    frame.contentWindow.postMessage({ channel: 'canvy-prototype-v1', id, action: args.action, selector: args.selector, value: args.value }, '*');
  });
}
