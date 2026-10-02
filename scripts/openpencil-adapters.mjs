// Narrow adapters for the pinned 0.15.1 package. .fig's STRETCH paint is the
// scene graph's CROP + explicit transform. Never mutate the live graph to save.
export function openPencilAdapters() {
  return { name: 'canvy-openpencil-compatibility', enforce: 'pre', transform(code, id) {
    const path = id.replaceAll('\\', '/');
    const replacements = path.endsWith('/@open-pencil/fig/dist/node-change2.js') ? [
      ['paint.imageScaleMode = fill.imageScaleMode;', 'paint.imageScaleMode = fill.imageScaleMode === "CROP" ? "STRETCH" : fill.imageScaleMode;'],
      ['fill.imageScaleMode = p.imageScaleMode ?? "FILL";', 'fill.imageScaleMode = p.imageScaleMode === "STRETCH" ? "CROP" : p.imageScaleMode ?? "FILL";']
    ] : path.endsWith('/@open-pencil/core/dist/io/formats/svg/defs.js') ? [
      ['preserveAspectRatio: fill.imageScaleMode === "FIT" ? "xMidYMid meet" : "xMidYMid slice"', 'preserveAspectRatio: fill.imageScaleMode === "CROP" && fill.imageTransform?.m00 === 1 && fill.imageTransform?.m11 === 1 && !fill.imageTransform?.m02 && !fill.imageTransform?.m12 ? "none" : fill.imageScaleMode === "FIT" ? "xMidYMid meet" : "xMidYMid slice"']
    ] : [];
    if (!replacements.length) return;
    for (const [before, after] of replacements) {
      if (!code.includes(before)) throw new Error('OpenPencil paint codec changed; review the compatibility adapter');
      code = code.replace(before, after);
    }
    return { code, map: null };
  } };
}
