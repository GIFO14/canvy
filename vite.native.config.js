import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { openPencilAdapters } from './scripts/openpencil-adapters.mjs';
const embed = (file) => `Uint8Array.from(atob(${JSON.stringify(readFileSync(file).toString('base64'))}), c=>c.charCodeAt(0))`;
const native = { name: 'freecanvas-native-assets', enforce: 'pre',
  resolveId(id) { if (id === 'virtual:freecanvas-native-assets') return '\0freecanvas-native-assets'; },
  load(id) {
    if (id !== '\0freecanvas-native-assets') return;
    const fonts = ['Inter', 'Roboto'].map(family => `${family}:{${['Regular','Medium','SemiBold','Bold','ExtraBold'].map(style => `${style}:${embed(`public/${family}-${style}.ttf`)}.buffer`).join(',')}}`).join(',');
    return `export default {wasm:${embed('public/canvaskit.wasm')},fonts:{${fonts}}}`;
  },
  transform(code, id) {
    const path = id.replaceAll('\\','/');
    if (/\/canvaskit-wasm\/bin\/(full\/)?canvaskit\.js$/.test(path)) {
      let matched = false;
      const next = code.replace(/async function (\w+)\((\w+)\)\{var (\w+)=(\w+);if\("function"==typeof WebAssembly.instantiateStreaming/g, (prefix, fn, imports) => {
        matched = true;
        return prefix.replace(`{var `, `{if(window.__FREECANVAS_NATIVE_ASSETS__)return await WebAssembly.instantiate(window.__FREECANVAS_NATIVE_ASSETS__.wasm,${imports});var `);
      });
      if (!matched) throw new Error('CanvasKit binary loader changed; review the native adapter');
      return { code: next, map: null };
    }
    if (path.endsWith('/src/style.css')) return { code: code.replace(/@font-face\{[^}]*\}/g, ''), map: null };
    if (path.endsWith('/@open-pencil/vue/dist/canvas/CanvasRoot.js')) {
      // Codex can attach a collapsed app with a zero-sized viewport and suspend
      // RAF. Initialize a usable backing surface anyway; ResizeObserver restores
      // the real viewport when the host expands it. Do not change browser mode.
      const replacements = [
        ['const width = canvas.clientWidth;', 'const width = canvas.clientWidth || 800;'],
        ['const height = canvas.clientHeight;', 'const height = canvas.clientHeight || 600;'],
        ['await new Promise((resolve) => {\n\t\t\trequestAnimationFrame(resolve);\n\t\t});', 'await new Promise((resolve) => { const timer = setTimeout(done, 100); const frame = requestAnimationFrame(done); function done() { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); } });'],
        ['canvasRef.value?.clientWidth ?? 0, canvasRef.value?.clientHeight ?? 0', '(canvasRef.value?.clientWidth || 800), (canvasRef.value?.clientHeight || 600)']
      ];
      for (const [before, after] of replacements) {
        if (!code.includes(before)) throw new Error('CanvasRoot changed; review the collapsed-panel adapter');
        code = code.replace(before, after);
      }
      return { code, map: null };
    }
    if (path.includes('/@open-pencil/vue/dist/') && code.includes('function getLocalStorage() {')) {
      return { code: code.replace('function getLocalStorage() {', 'function getLocalStorage() { try {').replace('return localStorage;\n}', 'return localStorage; } catch { return null; }\n}'), map: null };
    }
    if (!path.includes('/@open-pencil/core/dist/')) return;
    let index = 0, imports = '';
    const next = code.replace(/new Worker\(new URL\("(\.\/[^"\n]+)\.ts", import\.meta\.url\), \{ type: "module" \}\)/g, (_, relative) => {
      const name = `FreeCanvasInlineWorker${index++}`;
      imports += `import ${name} from '${relative}.js?worker&inline';\n`;
      return `new ${name}()`;
    });
    if (imports) return { code: imports + next, map: null };
  }
};
export default defineConfig({ plugins: [openPencilAdapters(), native, vue(), viteSingleFile()], publicDir: false,
  build: { target: 'es2023', outDir: 'dist-native', rollupOptions: { input: 'native.html' } } });
