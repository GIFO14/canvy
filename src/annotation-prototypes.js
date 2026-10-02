// Only typed, read-only picking crosses the opaque prototype boundary. The
// isolated component never receives the editor, model context or host bridge.
const prototypes = new Map();
export function registerAnnotationPrototype(id, pick) { prototypes.set(id, pick); return () => { if (prototypes.get(id) === pick) prototypes.delete(id); }; }
export function pickAnnotationPrototype(id, x, y) { return prototypes.get(id)?.(x, y); }
