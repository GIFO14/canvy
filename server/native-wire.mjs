import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { WIRE_MAX_BYTES, WIRE_CHUNK_CHARS } from '../src/wire-format.js';

export function createNativeWire() {
  const downloads = new Map(), uploads = new Map();
  function clean(map) { for (const [id, entry] of map) if (Date.now() - entry.seen > 120000) map.delete(id); }
  function encode(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > WIRE_MAX_BYTES) throw new Error('Native transfer exceeds 48 MiB');
    if (bytes.length < 64 * 1024) return value;
    const wire = { encoding: 'gzip-base64', bytes: bytes.length, data: gzipSync(bytes).toString('base64') };
    if (wire.data.length <= WIRE_CHUNK_CHARS) return { canvy_wire: wire };
    clean(downloads);
    if (downloads.size >= 8) for (const [id, entry] of downloads) if (entry.completed) { downloads.delete(id); break; }
    if (downloads.size >= 8) throw new Error('Too many native downloads');
    const id = randomUUID(), total = Math.ceil(wire.data.length / WIRE_CHUNK_CHARS);
    downloads.set(id, { ...wire, seen: Date.now() });
    return { ...(value.session ? { session: value.session } : {}), canvy_wire: { encoding: wire.encoding, bytes: wire.bytes, transfer: { id, total } } };
  }
  function download({ id, index }) {
    clean(downloads); const entry = downloads.get(id);
    if (!entry || !Number.isInteger(index) || index < 0 || index >= Math.ceil(entry.data.length / WIRE_CHUNK_CHARS)) throw new Error('Native download expired or invalid');
    entry.seen = Date.now();
    const data = entry.data.slice(index * WIRE_CHUNK_CHARS, (index + 1) * WIRE_CHUNK_CHARS);
    if (index === Math.ceil(entry.data.length / WIRE_CHUNK_CHARS) - 1) entry.completed = true;
    // Reads are safe to repeat; retain until TTL instead of consuming a chunk.
    return { id, index, data };
  }
  function upload(session, document_id, transfer) {
    clean(uploads);
    const { id, index, total, bytes, data } = transfer;
    if (!id || !Number.isInteger(total) || total < 1 || total > 192 || !Number.isInteger(index) || index < 0 || index >= total || !Number.isInteger(bytes) || bytes < 0 || bytes > WIRE_MAX_BYTES || typeof data !== 'string' || data.length > WIRE_CHUNK_CHARS) throw new Error('Invalid native upload chunk');
    let entry = uploads.get(id);
    if (!entry) {
      if (index !== 0 || uploads.size >= 8) throw new Error('Native upload expired or unavailable');
      entry = { session, document_id, total, bytes, chunks: [], length: 0 }; uploads.set(id, entry);
    }
    if (entry.session !== session || entry.document_id !== document_id || entry.total !== total || entry.bytes !== bytes || entry.chunks.length !== index) throw new Error('Native upload target or sequence mismatch; do not replay an uncertain save');
    entry.seen = Date.now(); entry.chunks.push(data); entry.length += data.length;
    if (entry.length > WIRE_MAX_BYTES) { uploads.delete(id); throw new Error('Native upload exceeds its size limit'); }
    if (entry.chunks.length !== total) return null;
    uploads.delete(id);
    const decoded = gunzipSync(Buffer.from(entry.chunks.join(''), 'base64'), { maxOutputLength: bytes || 1 });
    if (decoded.length !== bytes) throw new Error('Native upload length mismatch');
    const value = JSON.parse(decoded.toString('utf8'));
    if (typeof value.state !== 'string' || typeof value.fig !== 'string') throw new Error('Invalid native checkpoint transfer');
    return value;
  }
  return { encode, download, upload };
}
