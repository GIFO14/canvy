<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { localeSetting, toolCursor, useCanvas, useCanvasInput, useTextEdit } from '@open-pencil/vue';
import { editor, status, scheduleSave, setViewportSize } from './editor.js';
import { preview } from './prototype-preview.js';
// Keep built-in editor messages in English without changing stored preferences.
localeSetting.set('en');
const emit = defineEmits(['ready']);
const canvas = ref(null);
// Top-level screens are independent mockups. A casual overlap must not nest
// one screen inside another; inner elements retain native drag/reparent behavior.
const originalReparent = editor.reparentNodes;
const originalReorder = editor.reorderInAutoLayout;
const isBoardFrame = (id) => { const node = editor.graph.getNode(id); return node?.type === 'FRAME' && node.parentId === editor.state.currentPageId; };
editor.reparentNodes = (ids, parentId) => { const movable = ids.filter((id) => !isBoardFrame(id)); if (movable.length) originalReparent(movable, parentId); };
editor.reorderInAutoLayout = (id, parentId, index) => { if (!isBoardFrame(id)) originalReorder(id, parentId, index); };
const surface = useCanvas(canvas, editor, { preserveDrawingBuffer: true, showRulers: false, onViewportResize: (width, height) => setViewportSize({ width, height }), onReady: () => {
  status.ready = true; editor.zoomToFit(); editor.requestRender(); emit('ready');
} });
const enabled = () => status.ready && !status.home && !status.switching && !preview.current;
const input = useCanvasInput(canvas, editor, surface.hitTestSectionTitle, surface.hitTestComponentLabel, surface.hitTestFrameTitle, undefined, undefined, enabled);
const spacePan = ref(false);
let previousTool;
function releaseSpace() {
  if (!spacePan.value) return;
  spacePan.value = false;
  // A tool change cancels the native pan drag, including release before mouseup.
  input.cleanupInteractions();
  if (editor.state.activeTool === 'HAND') editor.setTool(previousTool);
  previousTool = undefined;
}
function keydown(event) {
  if (event.code !== 'Space' || !enabled() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (editor.state.editingTextId || event.target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
  if (!spacePan.value && input.drag.value) return;
  // Also suppress page scrolling and activation of a focused toolbar button.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (spacePan.value) return;
  previousTool = editor.state.activeTool;
  spacePan.value = true;
  editor.setTool('HAND');
}
function keyup(event) { if (event.code === 'Space') releaseSpace(); }
function visibilityChanged() { if (document.visibilityState === 'hidden') releaseSpace(); }
const cursor = computed(() => editor.state.activeTool === 'HAND'
  ? input.drag.value?.type === 'pan' ? 'grabbing' : 'grab'
  : input.cursorOverride.value ?? toolCursor(editor.state.activeTool));
watch(() => [status.home, status.switching, status.document?.id, preview.current], releaseSpace);
onMounted(() => {
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', releaseSpace);
  document.addEventListener('visibilitychange', visibilityChanged);
});
useTextEdit(canvas, editor);
const stop = editor.onEditorEvent('history:changed', scheduleSave);
onUnmounted(() => {
  releaseSpace();
  window.removeEventListener('keydown', keydown, true);
  window.removeEventListener('keyup', keyup, true);
  window.removeEventListener('blur', releaseSpace);
  document.removeEventListener('visibilitychange', visibilityChanged);
  stop(); editor.reparentNodes = originalReparent; editor.reorderInAutoLayout = originalReorder;
});
</script>
<template><canvas ref="canvas" class="canvas" :style="{ cursor }" tabindex="0" aria-label="Design canvas" data-testid="design-canvas" /></template>
