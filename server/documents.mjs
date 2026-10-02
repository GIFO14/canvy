import { randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

// The catalogue and checkpoints live outside the plugin cache. Updating the
// plugin cannot replace a user's documents. The original file stays in place.
export async function createDocumentStore(runtime) {
  await mkdir(resolve(runtime, 'canvases'), { recursive: true });
  async function atomicWrite(path, data) {
    const staging = resolve(runtime, `${randomUUID()}.tmp`);
    const file = await open(staging, 'wx');
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(staging, path);
  }
  const indexPath = resolve(runtime, 'canvases.json');
  let catalogue;
  try { catalogue = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    catalogue = { version: 1, documents: [{ id: 'freecanvas', name: 'My first canvas', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
    await atomicWrite(indexPath, JSON.stringify(catalogue));
  }
  if (catalogue.version !== 1 || !Array.isArray(catalogue.documents)) throw new Error('Invalid canvas catalogue');
  let queue = Promise.resolve();
  function serialized(action) { const job = queue.catch(() => {}).then(action); queue = job; return job; }
  function document(id, includeDeleted = false) {
    const item = catalogue.documents.find(d => d.id === id);
    if (!item || !/^(freecanvas|[a-f0-9-]{36})$/.test(id)) throw new Error('Unknown canvas');
    if (item.deletedAt && !includeDeleted) throw new Error('This canvas is in Trash. Restore it from Home before opening or editing it.');
    return item;
  }
  function path(id, extension) {
    document(id);
    return id === 'freecanvas' ? resolve(runtime, `document.${extension}`) : resolve(runtime, 'canvases', `${id}.${extension}`);
  }
  async function read(id) {
    const item = document(id);
    let state = null, saved = null;
    try { state = await readFile(path(id, 'freecanvas'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!state) try { saved = (await readFile(path(id, 'fig'))).toString('base64'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { document: { ...item }, state, saved };
  }
  function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('Canvas name must have 1–120 characters');
    return value.trim();
  }
  return {
    read,
    isActive: id => catalogue.documents.some(d => d.id === id && !d.deletedAt),
    list: () => catalogue.documents.filter(d => !d.deletedAt).map(d => ({ ...d })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    trash: () => catalogue.documents.filter(d => d.deletedAt).map(d => ({ ...d })).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)),
    delete: (id, validate = () => {}) => serialized(async () => {
      document(id); validate();
      const next = { ...catalogue, documents: catalogue.documents.map(d => d.id === id ? { ...d, deletedAt: new Date().toISOString() } : d) };
      await atomicWrite(indexPath, JSON.stringify(next)); catalogue = next;
      return { ...document(id, true) };
    }),
    restore: id => serialized(async () => {
      if (!document(id, true).deletedAt) throw new Error('This canvas is not in Trash');
      const next = { ...catalogue, documents: catalogue.documents.map(d => {
        if (d.id !== id) return d;
        const { deletedAt, ...restored } = d; return restored;
      }) };
      await atomicWrite(indexPath, JSON.stringify(next)); catalogue = next;
      return { ...document(id) };
    }),
    create: value => serialized(async () => {
      const now = new Date().toISOString();
      const item = { id: randomUUID(), name: name(value), createdAt: now, updatedAt: now };
      const next = { ...catalogue, documents: [...catalogue.documents, item] };
      await atomicWrite(indexPath, JSON.stringify(next)); catalogue = next;
      return { ...item };
    }),
    rename: (id, value) => serialized(async () => {
      document(id);
      const next = { ...catalogue, documents: catalogue.documents.map(d => d.id === id ? { ...d, name: name(value) } : d) };
      await atomicWrite(indexPath, JSON.stringify(next)); catalogue = next;
      return { ...document(id) };
    }),
    save: (id, state, fig) => serialized(async () => {
      document(id);
      if (typeof state !== 'string' || typeof fig !== 'string' || JSON.parse(state).version !== 1) throw new Error('Invalid document');
      const data = Buffer.from(fig, 'base64');
      if (!data.length || data.length + Buffer.byteLength(state) > 32 * 1024 * 1024) throw new Error('Invalid document size');
      const nodes = JSON.parse(state).graph?.nodes?.value;
      if (!Array.isArray(nodes) || nodes.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[1]?.type)) throw new Error('Invalid document graph');
      await atomicWrite(path(id, 'fig'), data);
      await atomicWrite(path(id, 'freecanvas'), state);
      const next = { ...catalogue, documents: catalogue.documents.map(d => d.id === id ? { ...d, updatedAt: new Date().toISOString(), nodeCount: nodes.length } : d) };
      await atomicWrite(indexPath, JSON.stringify(next)); catalogue = next;
      return { saved: true, document_id: id, bytes: data.length, path: path(id, 'fig') };
    })
  };
}
