import { SceneGraph, generateId } from '@open-pencil/scene-graph';
// Use the same public graph fields that OpenPencil transfers between workers.
// .fig import creates fresh IDs, so our local checkpoint also retains exact IDs.
const fields = ['rootId', 'nodes', 'images', 'variables', 'variableCollections', 'activeMode', 'instanceIndex', 'figKiwiVersion', 'figSchemaDeflated', 'documentColorSpace', 'enabledLibraries'];
export function encodeDocument(graph) {
  return JSON.stringify({ version: 1, graph: Object.fromEntries(fields.map((key) => [key, graph[key]])) }, (_, value) => {
    if (value instanceof Map) return { $freecanvas: 'Map', value: [...value] };
    if (value instanceof Set) return { $freecanvas: 'Set', value: [...value] };
    if (value instanceof Uint8Array) return { $freecanvas: 'Bytes', value: [...value] };
    return value;
  });
}
export function decodeDocument(text) {
  const data = JSON.parse(text, (_, value) => {
    if (value?.$freecanvas === 'Map') return new Map(value.value);
    if (value?.$freecanvas === 'Set') return new Set(value.value);
    if (value?.$freecanvas === 'Bytes') return Uint8Array.from(value.value);
    return value;
  });
  if (data.version !== 1 || !(data.graph?.nodes instanceof Map)) throw new Error('Unsupported Canvy document');
  const graph = new SceneGraph();
  for (const key of fields) if (key in data.graph) graph[key] = data.graph[key];
  const maximum = Math.max(...[...graph.nodes.keys()].filter((id) => /^0:\d+$/.test(id)).map((id) => Number(id.split(':')[1])));
  if (maximum > 1000000) throw new Error('Invalid node ID range');
  // Reserve IDs before the next native create_shape call to prevent collisions.
  while (Number(generateId().split(':')[1]) <= maximum) { /* reserve */ }
  return graph;
}
