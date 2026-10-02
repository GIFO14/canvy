import { reactive } from 'vue';

// Persistent records live in the existing resource container, so legacy
// checkpoints and their IDs need no format migration. Panel focus is transient.
export const annotations = reactive({ revision: 0, activeId: null, reviewTarget: null });
export function annotationRecords(graph, pageId) {
  return (graph.canvyResources?.annotations ?? []).filter(a => a.page_id === pageId && !a.removed);
}
export function annotationContext(graph, pageId) {
  const records = annotationRecords(graph, pageId);
  const active = records.find(a => a.id === annotations.activeId);
  return records.length ? { annotations: records.slice(-50), annotation_count: records.length, active_annotation: active ?? null } : {};
}
export function resetAnnotationFocus() { annotations.activeId = null; annotations.reviewTarget = null; annotations.revision++; }
export function targetBounds(graph, target) {
  const node = graph.getNode(target.anchor_id);
  if (!node) return target.bounds;
  const position = graph.getAbsolutePosition(node.id);
  if (target.kind === 'node') return { ...position, width: node.width, height: node.height };
  const r = target.relative;
  return r ? { x: position.x + r.x * node.width, y: position.y + r.y * node.height, width: r.width * node.width, height: r.height * node.height } : target.bounds;
}
export function anchoredTarget(graph, node, bounds, details = {}) {
  const position = node && graph.getAbsolutePosition(node.id);
  return { kind: 'area', bounds, ...(node ? { anchor_id: node.id, frame_name: node.name,
    relative: { x: (bounds.x - position.x) / (node.width || 1), y: (bounds.y - position.y) / (node.height || 1), width: bounds.width / (node.width || 1), height: bounds.height / (node.height || 1) } } : {}), ...details };
}
