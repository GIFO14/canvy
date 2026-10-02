// Lossless, bounded envelopes for the native MCP bridge. No executable payloads.
export const WIRE_MAX_BYTES = 48 * 1024 * 1024;
export const WIRE_CHUNK_CHARS = 256 * 1024;
export function base64Bytes(data) {
  return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}
export function bytesBase64(data) {
  let text = '';
  for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(text);
}
async function streamBytes(stream, limit) {
  const reader = stream.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Native transfer exceeds its decoded size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function encodeWire(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > WIRE_MAX_BYTES) throw new Error('Native transfer exceeds 48 MiB');
  const gzip = await streamBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')), WIRE_MAX_BYTES);
  return { encoding: 'gzip-base64', bytes: bytes.length, data: bytesBase64(gzip) };
}
export async function decodeWire(wire) {
  if (wire.encoding !== 'gzip-base64' || !Number.isSafeInteger(wire.bytes) || wire.bytes < 0 || wire.bytes > WIRE_MAX_BYTES || typeof wire.data !== 'string' || wire.data.length > WIRE_MAX_BYTES) throw new Error('Invalid native transfer envelope');
  const decoded = await streamBytes(new Blob([base64Bytes(wire.data)]).stream().pipeThrough(new DecompressionStream('gzip')), wire.bytes);
  if (decoded.length !== wire.bytes) throw new Error('Native transfer length mismatch');
  return JSON.parse(new TextDecoder().decode(decoded));
}
