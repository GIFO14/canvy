import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CORE_TOOLS } from '../server/tool-compatibility.mjs';
const { version } = JSON.parse(await readFile('package.json'));
await mkdir('artifacts', { recursive: true });
const installed = resolve(homedir(), `.codex/plugins/cache/canvy-local/canvy/${version}`);
const config = JSON.parse(await readFile(resolve(installed, 'mcp.json'))).mcpServers.canvy;
const client = new Client({ name: 'installed-plugin-test', version });
try {
  const transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe', env: { ...process.env, ...config.env, CANVY_TOOL_PROFILE: 'core' } });
  transport.stderr?.on('data', (data) => console.error(data.toString().slice(0,1800)));
  await client.connect(transport);
  const tools = await client.listTools();
  const open = tools.tools.find((t) => t.name === 'open_canvas');
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'thread' }, { type: 'global' }]);
  assert.equal(open._meta.ui.resourceUri, 'ui://canvy/canvas/v5');
  const result = await client.callTool({ name: 'open_canvas', arguments: {} });
  assert.equal(result.structuredContent.presentation, 'native-plugin-canvas');
  assert.ok(!('url' in result.structuredContent));
  const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
  assert.equal(resource.contents[0]._meta['openai/ui'].preferredDisplayMode, 'fullscreen');
  assert.ok(resource.contents[0].text.includes('Canvy'));
  assert.ok(!resource.contents[0].text.includes('<iframe'));
  const diagnostics = await client.callTool({ name: 'canvas_diagnostics', arguments: {} });
  assert.ok(!diagnostics.isError); assert.equal(diagnostics.structuredContent.tools.length, CORE_TOOLS.size);
  assert.equal(diagnostics.structuredContent.registered_public_tools, 161);
  assert.equal(tools.tools.length, CORE_TOOLS.size + 5);
  for (const name of CORE_TOOLS) assert.ok(tools.tools.some(t => t.name === name), `Missing core tool ${name}`);
  const closed = await client.callTool({ name: 'canvas_status', arguments: { document_id: 'unopened-installed-qa' } });
  assert.ok(!closed.isError); assert.equal(closed.structuredContent.connected, false); assert.equal(closed.structuredContent.ready, false);
  const health = await (await fetch(`http://127.0.0.1:${config.env?.CANVY_PORT ?? 4318}/health`)).json();
  assert.ok(['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.4.0', '0.4.1', '0.5.0', '0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5', '0.5.6', '0.5.7', version].includes(health.version), 'Reuse the compatible running service without interrupting its panels');
  if (health.release === version) {
    assert.equal(health.version, '0.5.4', 'Health must expose the stable service identity');
    assert.equal(diagnostics.structuredContent.version, version, 'Diagnostics reports the actual backend release');
    const library = await client.callTool({ name: 'list_documents', arguments: {} });
    assert.equal(library.structuredContent.capabilities.trash, true, 'The updated backend advertises recoverable deletion');
  }
  // Actual retained backend resource routing is separate from fresh stdio
  // discovery: the desktop can use this older provider for an existing chat.
  const retained = new Client({ name: 'retained-resource-read-only-test', version });
  try {
    const origin = `http://127.0.0.1:${config.env?.CANVY_PORT ?? 4318}`;
    await retained.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
    const routed = await retained.readResource({ uri: open._meta.ui.resourceUri });
    assert.equal(routed.contents[0].text, resource.contents[0].text, 'The new entrypoint must load through the retained provider');
    assert.equal((await (await fetch(origin + '/health')).json()).pid, health.pid, 'Resource reads must not restart the live backend');
  } finally { await retained.close(); }
  for (const name of ['canvas_render', 'canvas_set_text', 'canvas_set_fill', 'canvas_set_font', 'canvas_undo', 'canvas_diagnostics']) assert.ok(tools.tools.some(t => t.name === name), `Missing essential compatibility tool ${name}`);
  await writeFile('artifacts/installed-test.json', JSON.stringify({ status: 'PASS', version, installed, tools: tools.tools.length, aliases: 33, publicTools: diagnostics.structuredContent.tools.length, registeredPublicTools: 161, toolProfile: 'core', diagnosticsWithoutPanel: true, resourceUri: open._meta.ui.resourceUri, nativeHost: 'Launcher and resource verified; no desktop pointer test claim' }, null, 2));
  console.log('PASS installed stdio launcher, on-demand service, native entrypoints and UI resource');
} finally { await client.close(); }
