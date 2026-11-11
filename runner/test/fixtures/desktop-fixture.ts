import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
const server = new Server({ name: 'desktop-fixture', version: '1' }, { capabilities: { tools: {} }, instructions: '读取 desktop/platform 指南' });
const name = 'desktop_fixture';
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name, description: '原生工具说明', inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, additionalProperties: false } }] }));
let calls = 0;
server.setRequestHandler(CallToolRequestSchema, async request => {
  calls++;
  const args = request.params.arguments ?? {};
  if (args.mode === 'crash') { await appendFile(process.argv[2]!, 'invoked\n'); process.exit(9); }
  if (args.mode === 'slow') await setTimeout(5000);
  if (args.mode === 'reject') return { isError: true, content: [{ type: 'text', text: '原生错误' }], structuredContent: { disposition: { retry: 'unsafe' } } };
  return { content: [{ type: 'text', text: '原生文本' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], structuredContent: { calls, namespace: process.argv.at(-1) } };
});
await server.connect(new StdioServerTransport());
