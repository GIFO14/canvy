import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const html = await readFile('dist-native/native.html', 'utf8');
if (/<iframe\b/i.test(html) || /<(?:script|link)[^>]+(?:src|href)=["'](?!data:)[^"']+/i.test(html)) throw new Error('Native canvas must have no external frame or assets');
const packed = gzipSync(html, { level: 9 }).toString('base64');
const loader = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Canvy</title></head><body style="margin:0;background:#2b2b2b;color:#aaa"><script>
(async()=>{const nonce=document.currentScript?.nonce;const bytes=Uint8Array.from(atob('${packed}'),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));let html=await new Response(stream).text();if(nonce)html=html.replaceAll('<script','<script nonce="'+nonce+'"');document.open();document.write(html);document.close();})().catch(e=>{document.body.textContent='Could not load Canvy: '+e.message});
</script></body></html>`;
if (Buffer.byteLength(loader) >= 10 * 1024 * 1024 - 65536) throw new Error('Native resource exceeds the default MCP stdio buffer');
await writeFile('dist/mcp-app.html', loader);
console.log(`Native MCP App: ${Math.round(Buffer.byteLength(loader) / 1024)} KiB, self-contained, within MCP stdio limit`);
