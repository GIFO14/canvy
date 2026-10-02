<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { PhCursor, PhHand, PhCornersOut, PhChatCircle, PhArrowCounterClockwise, PhHouse, PhPlus, PhPencilSimple, PhSquaresFour, PhTrash } from '@phosphor-icons/vue';
import { editor, status, initialize, connectBridge, contextPacket, saveDocument, scheduleSave, switchDocument, createDocument, refreshDocuments, renameDocument, trashDocument } from './editor.js';
import Canvas from './Canvas.vue';
import PrototypePreview from './PrototypePreview.vue';
import InteractionCanvas from './InteractionCanvas.vue';
import { interaction } from './interaction-mode.js';
import { preview, openPreview, closePreview } from './prototype-preview.js';
const booted = ref(false), connected = ref(false), ready = ref(false), version = ref(0);
const error = ref(''), notice = ref(''), hostConnected = ref(false), sending = ref(false);
const activeTool = computed(() => editor.state.activeTool);
const newName = ref(''), creating = ref(false), renameId = ref(null), renameName = ref('');
const showTrash = ref(false), deletingDocument = ref(null), libraryBusy = ref(false);
const visibleDocuments = computed(() => showTrash.value ? status.trash : status.documents);
const deleteDialog = ref(null);
watch(deletingDocument, async document => { if (document) { await nextTick(); deleteDialog.value?.showModal(); } });
const selected = computed(() => { version.value; return editor.state.selectedIds.size > 0; });
const importedSelection = computed(() => { version.value; return Object.values(editor.graph.canvyResources?.imports ?? {}).flatMap(i => i.frames).find(f => editor.state.selectedIds.has(f.id)); });
const zoom = computed(() => { version.value; return Math.round(editor.state.zoom * 100); });
const saveLabel = computed(() => status.saveError ? 'Could not save. Retrying…' : status.saving || status.dirty ? 'Saving…' : status.savedAt ? 'Saved locally' : 'Autosave');
let disconnect, noticeTimer, libraryTimer;
const stops = [];
function setTool(id) { editor.setTool(id); }
function setMode(mode) {
  try {
    editor.commitTextEdit();
    // Switching review modes neither discards nor replaces the document. Keep
    // dirty drafts visible and autosaving even when persistence is retrying.
    if (status.dirty) scheduleSave();
    closePreview(); interaction.mode = mode; editor.setTool('SELECT');
    if (mode === 'interact') editor.select([]);
  } catch (e) { error.value = e.message; }
}
function notify(text) { notice.value = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.value = ''; }, 3500); }
async function openDocument(id) { try { await switchDocument(id); } catch (e) { error.value = e.message; } }
async function home() { try { showTrash.value = false; await switchDocument(null); await refreshDocuments(); } catch (e) { error.value = e.message; } }
async function refreshHome() {
  if (!status.home || libraryBusy.value || status.switching) return;
  try { await refreshDocuments(); } catch (e) { error.value = e.message; }
}
async function manageDocument(id, operation) {
  if (libraryBusy.value) return;
  libraryBusy.value = true; error.value = '';
  try {
    await trashDocument(id, operation);
    notify(operation === 'delete' ? 'Canvas moved to Trash' : 'Canvas restored');
  } catch (e) { error.value = e.message; }
  finally { deletingDocument.value = null; libraryBusy.value = false; }
}
function cancelDelete() { if (!libraryBusy.value) deletingDocument.value = null; }
async function create() {
  if (!newName.value.trim() || creating.value) return;
  creating.value = true;
  try { await createDocument(newName.value); newName.value = ''; } catch (e) { error.value = e.message; }
  finally { creating.value = false; }
}
async function rename() {
  try { await renameDocument(renameId.value, renameName.value); renameId.value = null; } catch (e) { error.value = e.message; }
}
const editedDate = date => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(date));
async function sendContext() {
  if (!hostConnected.value || !selected.value || sending.value) return;
  const packet = contextPacket(); sending.value = true;
  try { await window.__FREECANVAS_NATIVE_HOST__.send(packet); notify('Selection sent to Codex'); }
  catch (e) { error.value = e.message; }
  finally { sending.value = false; }
}
function keydown(e) {
  if (preview.current) return;
  if (status.home || status.switching) return;
  if (e.target.closest('input,textarea,[contenteditable]')) return;
  if (e.key.toLowerCase() === 'h') { setTool('HAND'); return; }
  if (e.key.toLowerCase() === 'v') { void setMode('visual'); return; }
  if (interaction.mode !== 'visual') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.shiftKey ? editor.redoAction() : editor.undoAction(); scheduleSave(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); void saveDocument().catch((e) => { error.value = e.message; }); return;
  }
  if (e.key === 'Escape') { editor.select([]); setTool('SELECT'); error.value = ''; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelected(); scheduleSave(); }
}
onMounted(async () => {
  try {
    const token = await initialize(); booted.value = true;
    hostConnected.value = Boolean(window.__FREECANVAS_NATIVE_HOST__);
    disconnect = connectBridge(token, (value) => { connected.value = value; });
    await refreshHome();
    libraryTimer = setInterval(refreshHome, 5000);
    for (const event of ['render:requested', 'selection:changed', 'history:changed', 'page:changed', 'viewport:changed']) stops.push(editor.onEditorEvent(event, () => {
      version.value++;
      if (['selection:changed', 'history:changed'].includes(event) && hostConnected.value && !status.switching) {
        const packet = contextPacket();
        void window.__FREECANVAS_NATIVE_HOST__.context(packet).catch((e) => { error.value = e.message; });
      }
    }));
    window.addEventListener('keydown', keydown);
  } catch (e) { error.value = e.message; }
});
onUnmounted(() => { disconnect?.(); stops.forEach((stop) => stop()); clearTimeout(noticeTimer); clearInterval(libraryTimer); window.removeEventListener('keydown', keydown); });
</script>
<template>
  <main class="canvas-shell" aria-label="Canvy" data-ui-release="0.5.8" :data-mode="interaction.mode" :data-connected="connected" :data-ready="ready" :data-save-error="Boolean(status.saveError)" :data-saved="Boolean(status.savedAt) && !status.dirty && !status.saving">
    <Canvas v-if="booted" :inert="status.home || status.switching || Boolean(preview.current)" @ready="ready = true" />
    <InteractionCanvas v-if="booted" />
    <PrototypePreview v-if="preview.current" :key="preview.current.import_id + ':' + preview.current.width" />
    <div v-if="!ready" class="loading" role="status">Preparing canvas…</div>
    <section v-if="booted && status.home" class="canvas-home" aria-label="Canvy Home">
      <div class="home-content">
        <div class="home-brand"><PhSquaresFour :size="22" weight="duotone" /> Canvy</div>
        <div class="home-heading"><h1>{{ showTrash ? 'Trash' : 'Your canvases' }}</h1><button class="trash-toggle" @click="showTrash = !showTrash; refreshHome()" :disabled="libraryBusy"><PhTrash v-if="!showTrash" :size="17" />{{ showTrash ? 'Back to canvases' : `Trash${status.trash.length ? ` (${status.trash.length})` : ''}` }}</button></div>
        <p class="home-description">{{ showTrash ? 'Deleted canvases stay on your computer. Restore them whenever you need.' : 'A space for every idea. Everything saves automatically to your computer.' }}</p>
        <form v-if="!showTrash" class="create-canvas" @submit.prevent="create">
          <input v-model="newName" aria-label="New canvas name" placeholder="New canvas name" maxlength="120" required />
          <button type="submit" :disabled="creating || !newName.trim() || status.switching"><PhPlus :size="17" />{{ creating ? 'Creating…' : 'Create canvas' }}</button>
        </form>
        <div class="document-grid">
          <article v-for="document in visibleDocuments" :key="document.id" class="document-card" :data-document-id="document.id">
            <button class="document-open" @click="openDocument(document.id)" :disabled="status.switching || libraryBusy || showTrash" :aria-label="`Open ${document.name}`">
              <div class="document-preview"><PhSquaresFour :size="38" weight="thin" /></div>
              <div class="document-info"><strong>{{ document.name }}</strong><span>{{ document.nodeCount ? `${document.nodeCount} elements · ` : '' }}{{ editedDate(document.updatedAt) }}</span></div>
            </button>
            <div v-if="!showTrash" class="document-actions">
              <button :aria-label="`Rename ${document.name}`" title="Rename canvas" :disabled="libraryBusy || status.switching" @click="renameId = document.id; renameName = document.name"><PhPencilSimple :size="16" /></button>
              <button class="document-delete" :aria-label="`Delete ${document.name}`" title="Delete canvas" :disabled="libraryBusy || status.switching" @click="deletingDocument = document"><PhTrash :size="16" /></button>
            </div>
            <button v-else class="document-restore" :aria-label="`Restore ${document.name}`" :disabled="libraryBusy" @click="manageDocument(document.id, 'restore')">Restore</button>
          </article>
        </div>
        <p v-if="!visibleDocuments.length" class="empty-library">{{ showTrash ? 'Trash is empty.' : 'No canvases yet. Create your first canvas above.' }}</p>
        <dialog v-if="deletingDocument" ref="deleteDialog" class="delete-dialog" aria-labelledby="delete-title" @cancel.prevent="cancelDelete">
          <form class="library-dialog" @submit.prevent="manageDocument(deletingDocument.id, 'delete')">
            <h2 id="delete-title">Delete canvas?</h2>
            <p>Move <strong>{{ deletingDocument.name }}</strong> to Trash? You can restore it later.</p>
            <div><button type="button" :disabled="libraryBusy" @click="cancelDelete" autofocus>Cancel</button><button class="danger-button" type="submit" :disabled="libraryBusy">{{ libraryBusy ? 'Deleting…' : 'Delete canvas' }}</button></div>
          </form>
        </dialog>
        <form v-if="renameId" class="rename-dialog" @submit.prevent="rename" role="dialog" aria-label="Rename canvas">
          <label for="canvas-name">Canvas name</label><input id="canvas-name" v-model="renameName" maxlength="120" required />
          <div><button type="button" @click="renameId = null">Cancel</button><button type="submit" :disabled="!renameName.trim()">Rename</button></div>
        </form>
      </div>
    </section>
    <nav v-if="booted && !status.home" class="canvas-tools" aria-label="Canvas controls">
      <button @click="home" aria-label="Back to Home" :title="status.document?.name" :disabled="status.switching"><PhHouse :size="19" /></button>
      <span class="tool-divider" />
      <button v-if="interaction.mode === 'visual'" :class="{ active: activeTool === 'SELECT' }" @click="setTool('SELECT')" aria-label="Select" title="Select and move (V)"><PhCursor :size="19" /></button>
      <button :class="{ active: activeTool === 'HAND' }" @click="setTool('HAND')" aria-label="Pan canvas" title="Pan canvas (H or hold Space + drag)"><PhHand :size="19" /></button>
      <span class="tool-divider" />
      <button @click="editor.zoomToFit()" aria-label="Fit canvas" title="Fit mockups"><PhCornersOut :size="19" /></button>
      <button v-if="interaction.mode === 'visual'" @click="editor.undoAction()" aria-label="Undo" title="Undo (Ctrl Z)"><PhArrowCounterClockwise :size="19" /></button>
      <button v-if="importedSelection" @click="openPreview(editor.graph, { frame_id: importedSelection.id })" aria-label="Preview React prototype" title="Preview original React prototype">▶</button>
    </nav>
    <div v-if="booted && !status.home" class="mode-control" role="group" aria-label="Canvas mode">
      <button :aria-pressed="interaction.mode === 'interact'" @click="setMode('interact')" :disabled="status.switching">Interact</button>
      <button :aria-pressed="interaction.mode === 'visual'" @click="setMode('visual')" :disabled="status.switching" title="Select and move design elements (V)">Visual edits</button>
    </div>
    <button v-if="!status.home" class="zoom-control" @click="editor.zoomToFit()" aria-label="Fit canvas and show zoom"><span class="connection-dot" :class="{ connected, saving: status.saving || status.dirty, failed: status.saveError }" :title="saveLabel" /><span>{{ zoom }}%</span></button>
    <button v-if="!status.home && interaction.mode === 'visual' && hostConnected && selected" class="selection-action" @click="sendContext" :disabled="sending" aria-label="Send selection to Codex"><PhChatCircle :size="17" />{{ sending ? 'Sending…' : 'Send to Codex' }}</button>
    <div v-if="notice || error || status.saveError || status.openError" class="toast" :class="{ error: error || status.saveError || status.openError }" role="status" @click="notice = ''; error = ''; status.openError = ''">{{ status.openError || (status.saveError ? 'Could not save locally. Retrying automatically…' : error || notice) }}</div>
  </main>
</template>
