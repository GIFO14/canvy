<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { PhArrowCounterClockwise } from '@phosphor-icons/vue';
import { acquireInlinePrototype } from './prototype-preview.js';
const props = defineProps({ screen: Object, disabled: Boolean });
const iframe = ref(null), ready = ref(false), error = ref(''), generation = ref(0);
const documentResource = acquireInlinePrototype(props.screen.html), url = documentResource.url;
const style = computed(() => ({ width: props.screen.width + 'px', height: props.screen.height + 'px', transform: `translate(${props.screen.x}px, ${props.screen.y}px)`, pointerEvents: props.disabled ? 'none' : 'auto' }));
function restart() {
  // A new browsing context resets React, URL/hash navigation and failed code.
  // Keep the immutable source resource and every other frame's state intact.
  ready.value = false; error.value = ''; generation.value++;
}
function message(event) {
  if (event.source !== iframe.value?.contentWindow || event.data?.channel !== 'canvy-prototype-v1') return;
  const data = event.data;
  if (data.ready) ready.value = true;
  if (data.warning || data.error) error.value = data.warning || data.error;
  if (typeof data.panKey === 'boolean' && !error.value) window.dispatchEvent(new CustomEvent('canvy:prototype-pan', { detail: { pressed: data.panKey } }));
}
onMounted(() => window.addEventListener('message', message));
onUnmounted(() => { window.removeEventListener('message', message); documentResource.release(); });
</script>
<template>
  <div class="inline-prototype" :style="style" :data-frame-id="screen.id" :data-ready="ready" :data-error="Boolean(error)">
    <iframe :key="generation" ref="iframe" :src="url" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="`Interactive mockup: ${screen.name} (${screen.width}px)`" />
    <div v-if="error || !ready" class="prototype-status" role="status"><div class="prototype-status-content"><strong v-if="error">Mockup stopped</strong><p>{{ error || 'Preparing interactions…' }}</p><button v-if="error" @click.stop="restart" :disabled="disabled">Restart mockup</button></div></div>
    <button v-if="!error" class="prototype-restart" @click.stop="restart" :disabled="disabled" aria-label="Restart mockup" title="Restart mockup"><PhArrowCounterClockwise :size="16" /></button>
  </div>
</template>
<style scoped>
.inline-prototype{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden;background:white;contain:layout style paint}
iframe{display:block;width:100%;height:100%;border:0;background:white}
.prototype-status{position:absolute;inset:0;display:grid;place-items:center;background:#ffffffeb;color:#555;text-align:center;font-size:14px}
.prototype-status-content{width:320px;max-width:calc(100% / var(--prototype-ui-scale,1));max-height:calc(100% / var(--prototype-ui-scale,1));display:flex;flex-direction:column;padding:12px;box-sizing:border-box;transform:scale(var(--prototype-ui-scale,1));overflow-wrap:anywhere}.prototype-status p{margin:8px 0;white-space:pre-wrap;min-height:0;overflow:auto}.prototype-status strong,.prototype-status button{flex-shrink:0}.prototype-status button{padding:8px}
button{background:#242424;color:#eee;border:1px solid #555;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}button:hover{background:#353535;color:#fff}button:focus-visible{outline:2px solid #9dc5ae;outline-offset:2px}button:disabled{cursor:default;opacity:.4}
.prototype-restart{position:absolute;top:calc(8px * var(--prototype-ui-scale,1));right:calc(8px * var(--prototype-ui-scale,1));width:32px;height:32px;padding:0;display:grid;place-items:center;transform:scale(var(--prototype-ui-scale,1));transform-origin:top right;opacity:.75}.prototype-restart:hover,.prototype-restart:focus-visible{opacity:1}
</style>
