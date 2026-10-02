import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFrontend } from './frontend-snapshot.mjs';
import { captureRasterLayers } from './frontend-raster.mjs';
import { installPrototypeAssets } from '../src/prototype-assets.js';
import { deduplicateFrontendPacket } from './frontend-packet.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const escapeScript = s => s.replace(/<\/script/gi, match => '<\\/' + match.slice(2));
const escapeStyle = s => s.replace(/<\/style/gi, match => '<\\/' + match.slice(2));
const safePath = path => { if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || path.includes(':')) throw new Error('Import file paths must be relative, without .. segments'); return path; };

export async function compileFrontend(input) {
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new Error('Frontend source input exceeds 8 MiB');
  const project = input.project_dir ? await realpath(resolve(input.project_dir)) : checkout;
  const files = new Map((input.files ?? []).map(f => [safePath(f.path), f]));
  const entry = safePath(input.entry ?? 'Screen.tsx');
  if (input.source !== undefined) files.set(entry, { path: entry, content: input.source });
  if (!files.has(entry) && !input.project_dir) throw new Error('Supply source, files with an entry, or project_dir and entry');
  const css = input.css ?? '';
  files.set('__canvy_styles.css', { path: '__canvy_styles.css', content: css });
  const issues = [];
  const bundle = await build({ stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Screen from ${JSON.stringify('./' + entry)};import './__canvy_styles.css';createRoot(document.getElementById('canvy-root')).render(React.createElement(Screen,${JSON.stringify(input.props ?? {})}));`,
    loader: 'tsx', resolveDir: project, sourcefile: '__canvy_entry.tsx'
  }, bundle: true, write: false, metafile: true, outfile: 'screen.js', platform: 'browser', format: 'iife', jsx: 'automatic', minify: true,
  nodePaths: [resolve(checkout, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' },
  loader: Object.fromEntries(Object.keys(mime).map(extension => [extension, 'dataurl'])),
  plugins: [{ name: 'canvy-source-files', setup(builder) {
    builder.onResolve({ filter: /.*/ }, async args => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) {
        const base = args.namespace === 'canvy' ? posix.dirname(args.importer) : args.importer ? relative(project, dirname(args.importer)).replaceAll('\\', '/') : '';
        const candidate = posix.normalize(posix.join(base, args.path));
        const candidates = [candidate, ...['.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx'].map(e => candidate + e)];
        const found = candidates.find(c => files.has(c));
        if (found) return { path: found, namespace: 'canvy' };
      }
      if (args.namespace === 'canvy' && !args.path.startsWith('.')) return builder.resolve(args.path, { kind: args.kind, resolveDir: project, namespace: 'file' });
    });
    builder.onLoad({ filter: /.*/, namespace: 'canvy' }, args => {
      const file = files.get(args.path), extension = extname(args.path);
      return { contents: file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
        loader: mime[extension] ? 'dataurl' : extension === '.css' ? args.path.endsWith('.module.css') ? 'local-css' : 'css' : ['.ts', '.tsx'].includes(extension) ? 'tsx' : 'jsx', resolveDir: resolve(project, posix.dirname(args.path)) };
    });
  } }] });
  let styles = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
  if (input.tailwind) {
    // Explicit candidates also cover inline/virtual source files that Tailwind's
    // filesystem scanner cannot see. Original project's compiled CSS can be
    // supplied directly when it uses another Tailwind version/configuration.
    const sources = [input.source ?? '', ...[...files.values()].filter(f => f.encoding !== 'base64').map(f => f.content)];
    // Scan original project inputs, not minified React runtime strings: those
    // contain arbitrary delimiters that can corrupt Tailwind inline candidates.
    for (const filename of Object.keys(bundle.metafile.inputs)) {
      if (!/\.[jt]sx?$/.test(filename) || filename.includes('node_modules') || filename.startsWith('canvy:') || filename.endsWith('__canvy_entry.tsx')) continue;
      const path = resolve(filename), rel = relative(project, path);
      if (rel.startsWith('..')) continue;
      sources.push(await readFile(path, 'utf8'));
    }
    const candidates = [...new Set(sources.join('\n').match(/[A-Za-z0-9_!:\[\]./%#()-]+/g) ?? [])];
    styles = (await postcss([tailwind({ base: checkout })]).process(`@import "tailwindcss" source(none);\n@source inline(${JSON.stringify(candidates.join(' '))});\n${styles}`, { from: resolve(checkout, '__canvy_styles.css') })).css;
  }
  const script = bundle.outputFiles.find(f => f.path.endsWith('.js')).text;
  // No bridge credentials or host APIs are included in this document. React is
  // run in an isolated browser for capture and an opaque iframe for preview.
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0}</style><style>${escapeStyle(styles)}</style></head><body><script>(${installPrototypeAssets.toString()})();</script><div id="canvy-root"></div><script>${escapeScript(script)}</script></body></html>`;
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new Error('Compiled prototype exceeds 4 MiB; reduce its bundled assets');
  async function asset(path) {
    const local = safePath(decodeURIComponent(path.replace(/^\/+/, '')));
    const f = files.get(local);
    if (f) return { body: Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8'), type: mime[extname(local)] };
    if (!input.project_dir) return null;
    for (const base of [resolve(project, 'public'), project]) {
      try {
        const path = await realpath(resolve(base, local));
        const rel = relative(project, path);
        if (rel.startsWith('..') || !mime[extname(path)]) continue;
        if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error(`Asset exceeds 2 MiB: ${local}`);
        return { body: await readFile(path), type: mime[extname(path)] };
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    return null;
  }
  return { html, asset, issues };
}

export async function captureFrontend(input, { onCapture } = {}) {
  const compiled = await compileFrontend(input);
  let browser;
  try { browser = await chromium.launch({ headless: true, ...(process.env.CANVY_BROWSER_CHANNEL ? { channel: process.env.CANVY_BROWSER_CHANNEL } : {}) }); }
  catch (error) { throw new Error(`Frontend import needs a Chromium browser. Run npx playwright install chromium, or set CANVY_BROWSER_CHANNEL=msedge/chrome. ${error.message}`); }
  try {
    const variants = [], issues = [...compiled.issues];
    const pages = input.viewports ?? [{ width: 1440, height: 1000 }];
    let embeddedHtml = compiled.html;
    const capturedAssets = new Map();
    for (const viewport of pages) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        window.__canvyBlocked = [];
        addEventListener('securitypolicyviolation', event => window.__canvyBlocked.push({ code: 'CSP_BLOCKED_RESOURCE', message: `Blocked ${event.violatedDirective}: ${event.blockedURI}` }));
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'http://canvy-import.local' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: compiled.html.replace("img-src data: blob:", "img-src data: blob: http://canvy-import.local").replace("font-src data:", "font-src data: http://canvy-import.local") });
        if (url.origin === 'http://canvy-import.local') {
          const resource = await compiled.asset(url.pathname).catch(e => { issues.push({ code: 'ASSET_ERROR', message: e.message }); return null; });
          if (resource?.type) {
            capturedAssets.set(url.pathname + url.search, `data:${resource.type};base64,${resource.body.toString('base64')}`);
            return route.fulfill({ contentType: resource.type, body: resource.body });
          }
        }
        issues.push({ code: 'BLOCKED_RESOURCE', message: `Resource was not bundled or allowed: ${url.origin}${url.pathname}` });
        return route.abort('blockedbyclient');
      });
      await page.goto('http://canvy-import.local/', { waitUntil: 'load' });
      await page.locator(input.selector ?? '#canvy-root').waitFor({ state: 'visible', timeout: 10000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const snapshot = await page.evaluate(collectFrontend, { selector: input.selector ?? '#canvy-root', maxNodes: 2000 });
      await captureRasterLayers(page, snapshot);
      for (const resource of snapshot.assets) {
        if (resource.url?.startsWith('http://canvy-import.local')) { const url = new URL(resource.url); resource.data = capturedAssets.get(url.pathname + url.search) ?? null; }
      }
      snapshot.issues.push(...errors.map(message => ({ code: 'REACT_ERROR', message })));
      snapshot.issues.push(...await page.evaluate(() => window.__canvyBlocked));
      variants.push({ viewport, ...snapshot });
      await onCapture?.(page, viewport);
      await page.close();
    }
    // Replace root-relative resources in prototype markup/JS/CSS with their
    // original bytes, so the interactive preview does not depend on the service.
    for (const [path, data] of [...capturedAssets].sort(([a], [b]) => b.length - a.length)) {
      // Match complete quoted URLs instead of rewriting arbitrary JS substrings.
      for (const url of [path, 'http://canvy-import.local' + path]) {
        embeddedHtml = embeddedHtml.replaceAll(`"${url}"`, `"${data}"`).replaceAll(`'${url}'`, `'${data}'`).replaceAll(`url(${url})`, `url(${data})`);
      }
    }
    const packet = deduplicateFrontendPacket({ version: 1, name: input.name ?? 'Imported frontend', variants, html: embeddedHtml, issues, assets: [...capturedAssets].map(([url, data]) => ({ url, data })) });
    if (Buffer.byteLength(JSON.stringify(packet)) > 16 * 1024 * 1024) throw new Error('Deduplicated import payload exceeds 16 MiB; inspect original asset sizes');
    return packet;
  } finally { await browser.close(); }
}
