// Shared limits for persistence, editor snapshots and the native bridge. Wire
// envelopes include escaped checkpoint JSON and a base64 .fig backup, so they
// need more headroom than the combined original file sizes.
export const DOCUMENT_MAX_BYTES = 256 * 1024 * 1024;
export const REVERSIBLE_MAX_NODES = 50000;
export const WIRE_MAX_BYTES = 768 * 1024 * 1024;
export const WIRE_MAX_ENCODED_CHARS = Math.ceil(WIRE_MAX_BYTES * 1.001 / 3) * 4 + 1024;
