import { createApp } from 'vue';
import App from './App.vue';
import { connectNativeHost } from './native-host.js';
import assets from 'virtual:freecanvas-native-assets';
import './style.css';
window.__FREECANVAS_NATIVE_ASSETS__ = assets;
try {
  window.__FREECANVAS_NATIVE_HOST__ = await connectNativeHost();
  const face = await new FontFace('Inter', assets.fonts.Inter.Regular).load();
  document.fonts.add(face);
  createApp(App).mount('#app');
} catch (error) {
  document.getElementById('app').textContent = `Could not open Canvy: ${error.message}`;
}
