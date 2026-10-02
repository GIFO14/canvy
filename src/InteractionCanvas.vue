<script setup>
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { editor, status } from './editor.js';
import { interaction } from './interaction-mode.js';
import { preview } from './prototype-preview.js';
import InlinePrototype from './InlinePrototype.vue';
const root = ref(null), version = ref(0), width = ref(0), height = ref(0);
const active = computed(() => interaction.mode === 'interact' && !status.home && !status.switching && !preview.current);
const disabled = computed(() => interaction.spacePan || editor.state.activeTool === 'HAND' || !active.value);
// Frame geometry changes with the document, not with the camera. Keep stable
// objects so panning doesn't rerender every child or parse prototype HTML again.
const candidates = computed(() => {
  version.value;
  if (status.home || status.switching || !width.value || !height.value) return [];
  const result = [];
  for (const [importId, data] of Object.entries(editor.graph.canvyResources?.imports ?? {})) for (const frame of data.frames) {
    const node = editor.graph.getNode(frame.id);
    if (!node?.visible || !data.html) continue;
    let parent = node;
    while (parent?.visible && parent.parentId && parent.parentId !== editor.state.currentPageId) parent = editor.graph.getNode(parent.parentId);
    if (!parent?.visible || parent.parentId !== editor.state.currentPageId) continue;
    const position = editor.graph.getAbsolutePosition(node.id);
    result.push({ id: node.id, key: status.document?.id + ':' + importId + ':' + node.id, name: data.name, html: data.html, x: position.x, y: position.y, width: node.width, height: node.height });
  }
  return result;
});
const worldStyle = computed(() => ({ transform: `translate3d(${editor.state.panX}px, ${editor.state.panY}px, 0) scale(${editor.state.zoom})` }));
const screens = shallowRef([]);
let cullFrame;
function updateScreens() {
  cancelAnimationFrame(cullFrame);
  cullFrame = undefined;
  if (status.home || status.switching) { screens.value = []; return; }
  const retained = new Set(screens.value.map(s => s.key));
  const { zoom, panX, panY } = editor.state;
  const visible = candidates.value.filter(screen => {
    // Keep a small exit margin to avoid teardown/reboot at a viewport edge.
    const margin = retained.has(screen.key) ? 160 : 0;
    const x = screen.x * zoom + panX, y = screen.y * zoom + panY;
    return x + screen.width * zoom >= -margin && y + screen.height * zoom >= -margin && x <= width.value + margin && y <= height.value + margin;
  });
  if (visible.length !== screens.value.length || visible.some((s, i) => s !== screens.value[i])) screens.value = visible;
}
function scheduleCull() {
  // During navigation only the shared compositor transform moves. Defer iframe
  // startup and teardown until the gesture settles; the native scene remains.
  if (interaction.spacePan || editor.state.navigation?.phase !== 'idle') return;
  if (cullFrame === undefined) cullFrame = requestAnimationFrame(updateScreens);
}
watch([candidates, width, height], updateScreens, { immediate: true });
watch(() => [interaction.spacePan, editor.state.navigation?.phase], scheduleCull);
const stops = []; let resize;
onMounted(() => {
  resize = new ResizeObserver(([entry]) => { width.value = entry.contentRect.width; height.value = entry.contentRect.height; });
  resize.observe(root.value);
  for (const event of ['render:requested', 'graph:replaced', 'page:changed', 'history:changed']) stops.push(editor.onEditorEvent(event, () => { version.value++; }));
  stops.push(editor.onEditorEvent('viewport:changed', scheduleCull));
});
onUnmounted(() => { resize?.disconnect(); cancelAnimationFrame(cullFrame); stops.forEach(stop => stop()); });
</script>
<template>
  <div ref="root" :style="{ visibility: active ? 'visible' : 'hidden' }" :inert="!active" :aria-hidden="!active" class="interaction-canvas" aria-label="Interactive mockups">
    <div class="interaction-world" :style="worldStyle"><InlinePrototype v-for="screen in screens" :key="screen.key" :screen="screen" :disabled="disabled" /></div>
  </div>
</template>
<style scoped>.interaction-canvas{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}.interaction-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}</style>
