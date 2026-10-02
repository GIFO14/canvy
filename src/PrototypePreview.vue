<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { preview, previewHtml, attachPreview, detachPreview, closePreview } from './prototype-preview.js';
const iframe = ref(null);
const url = URL.createObjectURL(new Blob([previewHtml(preview.current.html)], { type: 'text/html' }));
const size = computed(() => ({ width: preview.current.width + 'px', height: preview.current.height + 'px' }));
onMounted(() => attachPreview(iframe.value));
onUnmounted(() => { detachPreview(); URL.revokeObjectURL(url); });
</script>
<template>
  <section class="prototype-overlay" role="dialog" aria-label="Interactive prototype">
    <header><strong>{{ preview.current.name }}</strong><span>{{ preview.current.width }} × {{ preview.current.height }} · Original React prototype</span><button @click="closePreview" aria-label="Close prototype">Close</button></header>
    <p v-if="preview.error" role="status">{{ preview.error }}</p>
    <div class="prototype-scroll"><iframe ref="iframe" :src="url" sandbox="allow-scripts" referrerpolicy="no-referrer" title="Imported React prototype" :style="size" /></div>
  </section>
</template>
<style scoped>
.prototype-overlay{position:absolute;inset:12px;z-index:50;background:#222;border:1px solid #444;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;color:#eee}.prototype-overlay header{display:flex;gap:16px;align-items:center;padding:12px 16px;min-height:52px}.prototype-overlay header span{font-size:12px;color:#aaa;flex:1}.prototype-overlay button{background:#333;color:#eee;border:1px solid #555;border-radius:6px;padding:6px 12px;cursor:pointer}.prototype-scroll{flex:1;overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:flex-start}.prototype-scroll iframe{border:0;background:white;flex-shrink:0}.prototype-overlay p{margin:0;padding:8px 16px;color:#eab174;font-size:12px}
</style>
