<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { previewHtml } from './prototype-preview.js';
const props = defineProps({ screen: Object, disabled: Boolean });
const iframe = ref(null), ready = ref(false), error = ref('');
const url = URL.createObjectURL(new Blob([previewHtml(props.screen.html, { inline: true })], { type: 'text/html' }));
const style = computed(() => ({ width: props.screen.width + 'px', height: props.screen.height + 'px', transform: `translate(${props.screen.x}px, ${props.screen.y}px) scale(${props.screen.zoom})`, pointerEvents: props.disabled ? 'none' : 'auto' }));
function message(event) {
  if (event.source !== iframe.value?.contentWindow || event.data?.channel !== 'canvy-prototype-v1') return;
  const data = event.data;
  if (data.ready) ready.value = true;
  if (data.warning || data.error) error.value = data.warning || data.error;
  if (typeof data.panKey === 'boolean' && !error.value) window.dispatchEvent(new CustomEvent('canvy:prototype-pan', { detail: { pressed: data.panKey } }));
}
onMounted(() => window.addEventListener('message', message));
onUnmounted(() => { window.removeEventListener('message', message); URL.revokeObjectURL(url); });
</script>
<template>
  <div class="inline-prototype" :style="style" :data-frame-id="screen.id" :data-ready="ready" :data-error="Boolean(error)">
    <iframe ref="iframe" :src="url" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="`Interactive mockup: ${screen.name} (${screen.width}px)`" />
    <div v-if="error || !ready" class="prototype-status" role="status">{{ error || 'Preparing interactions…' }}</div>
  </div>
</template>
<style scoped>
.inline-prototype{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;background:white}
iframe{display:block;width:100%;height:100%;border:0;background:white}
.prototype-status{position:absolute;inset:0;display:grid;place-items:center;background:#ffffffeb;color:#555;padding:20px;text-align:center;font-size:14px}
</style>
