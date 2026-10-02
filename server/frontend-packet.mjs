import { createHash } from 'node:crypto';

// Share identical original bytes across viewport captures. Geometry and CSS
// remain per viewport; the interactive HTML remains independently portable.
export function deduplicateFrontendPacket(packet) {
  const originalBytes = Buffer.byteLength(JSON.stringify(packet)), blobs = {};
  const intern = (object, field = 'data') => {
    if (!object?.[field]) return;
    if (field === 'url' && !object.url.startsWith('data:')) return;
    const key = createHash('sha256').update(object[field]).digest('hex');
    blobs[key] ??= object[field]; object[field + '_ref'] = key; delete object[field];
  };
  for (const asset of packet.assets) { intern(asset); intern(asset, 'url'); }
  for (const variant of packet.variants) {
    for (const asset of variant.assets) { intern(asset); intern(asset, 'url'); }
    for (const node of variant.nodes) { intern(node.raster); intern(node, 'url'); }
  }
  packet.blobs = blobs;
  packet.capture_stats = { bytes_before_deduplication: originalBytes, unique_resources: Object.keys(blobs).length, unique_resource_bytes: Object.values(blobs).reduce((sum, data) => sum + Buffer.byteLength(data), 0) };
  packet.capture_stats.packet_bytes = Buffer.byteLength(JSON.stringify(packet));
  return packet;
}
