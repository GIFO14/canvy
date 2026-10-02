import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
// OpenPencil 0.15.1's published JS still points two workers at .ts files.
// Rewrite only those package worker URLs to the shipped .js counterparts.
const openPencilWorkers = { name: 'openpencil-published-workers', enforce: 'pre', transform(code, id) {
  if (!id.replaceAll('\\', '/').includes('/@open-pencil/core/dist/')) return;
  const fixed = code.replace(/new URL\((['"])([^'"]+)\.ts\1, import\.meta\.url\)/g, 'new URL($1$2.js$1, import.meta.url)');
  return fixed === code ? undefined : { code: fixed, map: null };
} };
export default defineConfig({ plugins: [openPencilWorkers, vue()], server: { proxy: { '/bridge': { target: 'ws://127.0.0.1:4318', ws: true }, '/api': 'http://127.0.0.1:4318' } }, build: { target: 'es2023' } });
