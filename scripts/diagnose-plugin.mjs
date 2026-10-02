import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { CORE_TOOLS } from '../server/tool-compatibility.mjs';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { codexCommand } from './codex-command.mjs';
const command = codexCommand(['app-server', '--stdio']);
await mkdir('artifacts', { recursive: true });
const process = spawn(command.command, command.args, { stdio: ['pipe','pipe','pipe'], windowsHide: true, env: { ...globalThis.process.env, CANVY_TOOL_PROFILE: 'core' } });
const pending = new Map(); let id = 0;
process.stderr.on('data', data => { for (const line of data.toString().split('\n')) if (/freecanvas|mcp\.json/i.test(line)) console.error(line.slice(0,500)); });
createInterface({ input: process.stdout }).on('line', (line) => {
  try { const data = JSON.parse(line); const item = pending.get(data.id); if(item) { pending.delete(data.id); data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result); } } catch {}
});
async function request(method, params) {
  const current = ++id;
  const answer = new Promise((resolve,reject) => pending.set(current,{resolve,reject}));
  process.stdin.write(JSON.stringify({id:current,method,params})+'\n');
  return Promise.race([answer,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Diagnostic timeout')),15000).unref())]);
}
try {
  await request('initialize',{clientInfo:{name:'freecanvas-diagnostics',title:'FreeCanvas diagnostics',version:'1'},capabilities:{experimentalApi:true,requestAttestation:false}});
  process.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const plugin = await request('plugin/read',{marketplacePath:resolve('.local/.agents/plugins/marketplace.json'),pluginName:'canvy'});
  console.log(JSON.stringify({name:plugin.plugin.summary.name,mcpServers:plugin.plugin.mcpServers},null,2));
  const servers = await request('mcpServerStatus/list',{detail:'toolsAndAuthOnly'});
  const own = servers.data.find(s=>s.pluginId === 'canvy@canvy-local');
  assert.ok(plugin.plugin.mcpServers.includes('canvy'), 'Codex must recognize the portable MCP declaration');
  assert.ok(own && Object.keys(own.tools).length === CORE_TOOLS.size + 5, 'Codex must load the compact MCP catalog');
  for (const name of CORE_TOOLS) assert.ok(own.tools[name], `Codex must discover ${name}`);
  assert.ok(own.tools.open_canvas?._meta?.['openai/ui'], 'Codex must receive the native entrypoint');
  const result = {status:'PASS',host:'ACTUAL CODEX APP-SERVER, NO DESKTOP RENDER CLAIM',name:own.name,pluginId:own.pluginId,tools:Object.keys(own.tools).length,nativeEntrypoint:true};
  await writeFile('artifacts/loader-test.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { process.kill(); }
