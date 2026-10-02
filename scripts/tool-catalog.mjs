import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'canvy-check', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.CANVY_PORT ?? 4318}/mcp`)));
const { tools } = await client.listTools();
console.log('Tools:', tools.length);
for (const tool of tools) if (['set_fill','set_corner_radius','set_font','move_node','resize_node','export_svg','export_image','create_component','create_instance','render','get_node'].includes(tool.name)) console.log(tool.name, JSON.stringify(tool.inputSchema));
await client.close();
