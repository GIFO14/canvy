<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { PhMicrophone, PhPaperPlaneTilt, PhX, PhTrash, PhArrowCounterClockwise } from '@phosphor-icons/vue';
import { editor, status, contextPacket, saveDocument, scheduleSave } from './editor.js';
import { interaction } from './interaction-mode.js';
import { annotations, annotationRecords, anchoredTarget, targetBounds } from './annotation-state.js';
import { pickAnnotationPrototype } from './annotation-prototypes.js';

const root = ref(null), version = ref(0), hover = ref(null), drag = ref(null), error = ref(''), notice = ref('');
const commentInput = ref(null);
const busy = ref(false), uncertain = ref(false), removed = ref(null), width = ref(800), height = ref(600);
const enabled = computed(() => interaction.mode === 'annotate' && !interaction.spacePan && editor.state.activeTool !== 'HAND' && !status.switching);
const records = computed(() => { annotations.revision; version.value; return annotationRecords(editor.graph, editor.state.currentPageId); });
const active = computed(() => records.value.find(a => a.id === annotations.activeId));
const pins = computed(() => { version.value; return records.value.map((note, index) => ({ note, number: index + 1, box: screenBounds(note.target) })); });
const activeBox = computed(() => { version.value; return active.value && screenBounds(active.value.target); });
const cardStyle = computed(() => {
  const box = activeBox.value;
  return box ? { left: Math.max(8, Math.min(box.x + box.width + 14, width.value - 328)) + 'px', top: Math.max(58, Math.min(box.y, height.value - 310)) + 'px' } : {};
});
const highlight = computed(() => drag.value?.box ?? (hover.value && screenBounds(hover.value)));
const styleFor = box => ({ left: box.x + 'px', top: box.y + 'px', width: Math.max(2, box.width) + 'px', height: Math.max(2, box.height) + 'px' });
function screenBounds(target) {
  const b = targetBounds(editor.graph, target), { panX, panY, zoom } = editor.state;
  return { x: b.x * zoom + panX, y: b.y * zoom + panY, width: b.width * zoom, height: b.height * zoom };
}
function point(event) {
  const b = root.value.getBoundingClientRect();
  return { x: event.clientX - b.left, y: event.clientY - b.top };
}
const world = p => ({ x: (p.x - editor.state.panX) / editor.state.zoom, y: (p.y - editor.state.panY) / editor.state.zoom });
function boardFrame(node) {
  while (node?.parentId && node.parentId !== editor.state.currentPageId) node = editor.graph.getNode(node.parentId);
  return node?.type === 'FRAME' ? node : null;
}
function nativeTarget(p) {
  const w = world(p), node = editor.hitTestAtPoint(w.x, w.y, true);
  return node ? { kind: 'node', anchor_id: node.id, node_id: node.id, label: node.name, text: node.text?.slice(0, 240), bounds: { ...editor.graph.getAbsolutePosition(node.id), width: node.width, height: node.height }, source: 'native-design' } : null;
}
async function pick(p) {
  const native = nativeTarget(p), frame = boardFrame(native && editor.graph.getNode(native.node_id));
  if (frame) {
    const position = editor.graph.getAbsolutePosition(frame.id), w = world(p);
    const result = await pickAnnotationPrototype(frame.id, w.x - position.x, w.y - position.y);
    const b = result?.bounds;
    if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 0 && b.height >= 0 && b.width <= 10000 && b.height <= 10000) {
      return anchoredTarget(editor.graph, frame, { x: position.x + b.x, y: position.y + b.y, width: b.width, height: b.height }, { kind: 'prototype-element', selector: String(result.selector ?? '').slice(0, 1024), label: String(result.label ?? 'Element').slice(0, 240), role: String(result.role ?? '').slice(0, 80), source: 'live-prototype' });
    }
  }
  return native;
}
let hoverTimer, saveTimer, contextTimer, pickGeneration = 0;
function changed() {
  annotations.revision++; status.revision++; status.dirty = true;
  clearTimeout(saveTimer); saveTimer = setTimeout(scheduleSave, 400);
  syncContext();
}
function syncContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    if (!status.home && !status.switching) void window.__FREECANVAS_NATIVE_HOST__?.context(contextPacket()).catch(e => { error.value = e.message; });
  }, 200);
}
function updateText(value) {
  if (!active.value) return;
  active.value.text = value.slice(0, 4000); active.value.updated_at = new Date().toISOString(); changed();
}
function pointerDown(event) {
  if (!enabled.value || event.button !== 0 || busy.value) return;
  event.preventDefault(); annotations.activeId = null; hover.value = null; ++pickGeneration;
  clearTimeout(hoverTimer);
  const p = point(event); drag.value = { start: p, end: p, box: { ...p, width: 0, height: 0 } };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function pointerMove(event) {
  if (!enabled.value) return;
  const p = point(event);
  if (drag.value) {
    const start = drag.value.start;
    drag.value = { start, end: p, box: { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) } }; return;
  }
  const generation = ++pickGeneration;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => { const target = await pick(p); if (generation === pickGeneration && enabled.value) hover.value = target; }, 80);
}
async function pointerUp(event) {
  const gesture = drag.value; drag.value = null;
  if (!gesture || !enabled.value) return;
  event.currentTarget.releasePointerCapture(event.pointerId);
  const generation = ++pickGeneration, documentId = status.document?.id;
  let target;
  if (gesture.box.width > 5 || gesture.box.height > 5) {
    const b = gesture.box, w = world({ x: b.x, y: b.y });
    const center = world({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const frame = boardFrame(editor.hitTestAtPoint(center.x, center.y, true));
    target = anchoredTarget(editor.graph, frame, { ...w, width: b.width / editor.state.zoom, height: b.height / editor.state.zoom }, { label: 'Selected area', source: 'canvas-area' });
  } else target = await pick(gesture.end);
  if (generation !== pickGeneration || !enabled.value || documentId !== status.document?.id) return;
  if (!target) {
    const w = world(gesture.end);
    target = { kind: 'area', bounds: { ...w, width: 12 / editor.state.zoom, height: 12 / editor.state.zoom }, label: 'Canvas point', source: 'canvas-area' };
  }
  const note = { id: crypto.randomUUID(), page_id: editor.state.currentPageId, target, text: '', created_at: new Date().toISOString() };
  const resources = editor.graph.canvyResources ??= { fonts: {}, imports: {} };
  (resources.annotations ??= []).push(note); annotations.activeId = note.id;
  notice.value = ''; error.value = ''; hover.value = null; uncertain.value = false; changed();
}
function remove() {
  if (!active.value) return;
  removed.value = active.value; active.value.removed = true; annotations.activeId = null; changed();
}
function restore() { if (removed.value) { removed.value.removed = false; annotations.activeId = removed.value.id; removed.value = null; changed(); } }
async function deliver(voice = false) {
  const note = active.value, documentId = status.document?.id, host = window.__FREECANVAS_NATIVE_HOST__;
  if (!note || busy.value || !host || !voice && uncertain.value) return;
  busy.value = true; error.value = ''; notice.value = ''; let sending = false;
  try {
    await saveDocument();
    if (documentId !== status.document?.id || !records.value.includes(note)) throw new Error('The canvas changed. Select the annotation again.');
    const packet = { ...contextPacket(), annotations: [structuredClone(note)], active_annotation: structuredClone(note), annotation_count: 1 };
    if (voice) {
      await host.context(packet);
      notice.value = 'Target ready in chat. Use Codex’s microphone to dictate your feedback.';
    } else { sending = true; await host.sendAnnotations(packet); notice.value = 'Annotation sent to Codex'; }
  } catch (e) { if (sending) uncertain.value = true; error.value = sending ? 'Delivery could not be confirmed. Check your chat before sending again.' : e.message; }
  finally { busy.value = false; }
}
function wheel(event) {
  const p = point(event);
  if (event.ctrlKey || event.metaKey) editor.setZoomAroundPoint(Math.max(.02, Math.min(64, editor.state.zoom * Math.exp(-event.deltaY * .01))), p.x, p.y);
  else editor.pan(-event.deltaX, -event.deltaY);
}
function clearGesture() { drag.value = null; hover.value = null; ++pickGeneration; clearTimeout(hoverTimer); }
watch(() => [interaction.mode, interaction.spacePan, status.document?.id, editor.state.currentPageId], () => { clearGesture(); removed.value = null; });
watch(() => annotations.activeId, async () => {
  error.value = ''; notice.value = ''; uncertain.value = false; syncContext();
  await nextTick(); commentInput.value?.focus({ preventScroll: true });
});
const stops = []; let resize;
onMounted(() => {
  resize = new ResizeObserver(([entry]) => { width.value = entry.contentRect.width; height.value = entry.contentRect.height; }); resize.observe(root.value);
  for (const event of ['viewport:changed', 'history:changed', 'graph:replaced', 'page:changed']) stops.push(editor.onEditorEvent(event, () => { version.value++; }));
  window.addEventListener('blur', clearGesture);
});
onUnmounted(() => { clearGesture(); clearTimeout(saveTimer); clearTimeout(contextTimer); if (status.dirty && !status.switching) scheduleSave(); resize?.disconnect(); stops.forEach(stop => stop()); window.removeEventListener('blur', clearGesture); });
</script>
<template>
  <div ref="root" class="annotation-layer" aria-label="Canvas annotations">
    <div class="annotation-pick" :style="{ pointerEvents: enabled ? 'auto' : 'none' }" data-testid="annotation-surface" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="clearGesture" @wheel.prevent="wheel" />
    <div v-if="highlight" class="annotation-highlight" :style="styleFor(highlight)" />
    <template v-for="pin in pins" :key="pin.note.id">
      <div v-if="pin.note.id === annotations.activeId" class="annotation-highlight selected" :style="styleFor(pin.box)" />
      <button class="annotation-pin" :class="{ selected: pin.note.id === annotations.activeId }" :style="{ left: pin.box.x + 'px', top: pin.box.y + 'px' }" :aria-label="`Annotation ${pin.number}: ${pin.note.text || pin.note.target.label}`" @click="annotations.activeId = pin.note.id">{{ pin.number }}</button>
    </template>
    <section v-if="active" class="annotation-card" :style="cardStyle" role="dialog" aria-label="Edit annotation">
      <header><strong>{{ active.target.label || 'Annotation' }}</strong><button aria-label="Close annotation" @click="annotations.activeId = null"><PhX :size="16" /></button></header>
      <textarea ref="commentInput" :key="active.id" :value="active.text" @input="updateText($event.target.value)" placeholder="Describe what should change…" aria-label="Annotation comment" maxlength="4000" autofocus />
      <p v-if="active.target.anchor_id && !editor.graph.getNode(active.target.anchor_id)" class="annotation-error">The original target was removed. This annotation retains its captured position.</p>
      <div class="annotation-actions"><button :disabled="busy" @click="remove" aria-label="Remove annotation"><PhTrash :size="17" /></button><button class="dictate" @click="deliver(true)" :disabled="busy" title="Prepare this target for the native Codex chat microphone"><PhMicrophone :size="16" />Dictate in Codex</button><button class="send" @click="deliver()" :disabled="busy || uncertain || !active.text.trim()" aria-label="Send annotation to Codex"><PhPaperPlaneTilt :size="17" /></button></div>
      <p class="annotation-meta">Saved automatically · {{ active.target.source === 'live-prototype' ? 'Live mockup element' : active.target.source === 'native-design' ? 'Design element' : 'Canvas area' }}</p>
      <p v-if="notice || error" role="status" :class="{ 'annotation-error': error }">{{ error || notice }}</p>
    </section>
    <div v-if="!active" class="annotation-hint" role="status">Click an element or drag an area to annotate.<button v-if="removed" @click="restore"><PhArrowCounterClockwise :size="15" />Undo remove</button></div>
  </div>
</template>
<style scoped>
.annotation-layer{position:absolute;inset:0;z-index:7;pointer-events:none;overflow:hidden}.annotation-pick{position:absolute;inset:0;cursor:crosshair;touch-action:none}.annotation-highlight{position:absolute;border:2px solid #67b9f2;background:#2898eb13;box-sizing:border-box;pointer-events:none}.annotation-highlight.selected{border-color:#8ad4bc;background:#8ad4bc0c}.annotation-pin{position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;background:#216cb5;color:white;border:2px solid #9fceff;border-radius:50%;font-size:12px;box-shadow:0 2px 8px #0007;pointer-events:auto}.annotation-pin.selected{background:#176948;border-color:#8ad4bc}.annotation-card{position:absolute;width:312px;max-width:calc(100% - 16px);max-height:calc(100% - 66px);overflow:auto;padding:12px;background:#252525;color:#ddd;border:1px solid #505050;border-radius:12px;box-shadow:0 8px 30px #0005;pointer-events:auto;box-sizing:border-box;font-size:12px}.annotation-card header{display:flex;align-items:center;gap:12px;margin-bottom:12px}.annotation-card strong{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.annotation-card button{padding:6px;border-radius:5px;display:flex;gap:6px;align-items:center;justify-content:center;color:inherit;background:transparent}.annotation-card button:hover{background:#3a3a3a}.annotation-card button:focus-visible,.annotation-pin:focus-visible{outline:2px solid #8ad4bc;outline-offset:2px}.annotation-card textarea{box-sizing:border-box;width:100%;height:100px;min-height:60px;resize:vertical;background:#202020;color:#eee;border:1px solid #555;border-radius:8px;padding:10px;font:inherit;line-height:1.5;outline:none}.annotation-card textarea:focus{border-color:#8ad4bc}.annotation-actions{display:flex;gap:8px;align-items:center;margin-top:8px}.annotation-actions .dictate{margin-left:auto}.annotation-actions .send{background:#276749;color:white}.annotation-actions button:disabled{opacity:.4}.annotation-card p{line-height:1.5;overflow-wrap:anywhere;margin-bottom:0}.annotation-meta{color:#999;font-size:10px}.annotation-error{color:#f1aaa5}.annotation-hint{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);padding:10px 14px;background:#222e;color:#bbb;border:1px solid #444;border-radius:9px;white-space:nowrap;font-size:12px}.annotation-hint button{pointer-events:auto;display:inline-flex;gap:5px;align-items:center;color:#8ad4bc;margin-left:12px}
@media(max-width:500px){.annotation-hint{bottom:58px;max-width:90%;white-space:normal;text-align:center}.annotation-card{width:280px}}
</style>
