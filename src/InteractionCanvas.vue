<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { editor, status } from './editor.js';
import { interaction } from './interaction-mode.js';
import { preview } from './prototype-preview.js';
import InlinePrototype from './InlinePrototype.vue';
const root = ref(null), version = ref(0), width = ref(0), height = ref(0);
const active = computed(() => interaction.mode === 'interact' && !status.home && !status.switching && !preview.current);
const disabled = computed(() => interaction.spacePan || editor.state.activeTool === 'HAND' || !active.value);
const screens = computed(() => {
  version.value;
  if (status.home || status.switching || !width.value || !height.value) return [];
  const result = [], zoom = editor.state.zoom;
  for (const [importId, data] of Object.entries(editor.graph.canvyResources?.imports ?? {})) for (const frame of data.frames) {
    const node = editor.graph.getNode(frame.id);
    if (!node?.visible || !data.html) continue;
    let parent = node;
    while (parent?.visible && parent.parentId && parent.parentId !== editor.state.currentPageId) parent = editor.graph.getNode(parent.parentId);
    if (!parent?.visible || parent.parentId !== editor.state.currentPageId) continue;
    const position = editor.graph.getAbsolutePosition(node.id);
    const x = position.x * zoom + editor.state.panX, y = position.y * zoom + editor.state.panY;
    if (x + node.width * zoom < 0 || y + node.height * zoom < 0 || x > width.value || y > height.value) continue;
    result.push({ id: node.id, key: status.document?.id + ':' + importId + ':' + node.id, name: data.name, html: data.html, x, y, zoom, width: node.width, height: node.height });
  }
  return result;
});
const stops = []; let resize;
onMounted(() => {
  resize = new ResizeObserver(([entry]) => { width.value = entry.contentRect.width; height.value = entry.contentRect.height; });
  resize.observe(root.value);
  for (const event of ['render:requested', 'page:changed', 'viewport:changed', 'history:changed']) stops.push(editor.onEditorEvent(event, () => { version.value++; }));
});
onUnmounted(() => { resize?.disconnect(); stops.forEach(stop => stop()); });
</script>
<template>
  <div ref="root" :style="{ visibility: active ? 'visible' : 'hidden' }" :inert="!active" :aria-hidden="!active" class="interaction-canvas" aria-label="Interactive mockups">
    <InlinePrototype v-for="screen in screens" :key="screen.key" :screen="screen" :disabled="disabled" />
  </div>
</template>
<style scoped>.interaction-canvas{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}</style>
