import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMcp } from './tools.mjs';
import { createServiceLifecycle } from './service-lifecycle.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = `http://127.0.0.1:${Number(process.env.CANVY_PORT ?? process.env.FREECANVAS_PORT ?? 4318)}`;
const ensureService = createServiceLifecycle(root, origin, { dataDirectory: resolve(process.env.CANVY_DATA_DIR ?? process.env.FREECANVAS_DATA_DIR ?? resolve(root, '.runtime')) });
await ensureService();
const sendRPC = async (body) => {
  await ensureService();
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const res = await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bootstrap.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};
await createMcp(sendRPC, origin, resolve(root, 'exports'), { ensureService }).connect(new StdioServerTransport());
