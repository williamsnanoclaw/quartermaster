import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { client } from './bus.ts';
import type { Listed } from './tools.ts';

/**
 * Codex spawns this and gets the agent's tools. It is deliberately a pipe and
 * nothing else — every decision happens in the supervisor, so this process
 * holds no credentials and enforces no rules that a shell could edit out.
 *
 * stdout belongs to the MCP protocol. Never print to it.
 */
const bus = client();
const server = new Server({ name: 'temper', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await bus.call<Listed[]>('tools.list'),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await bus.call<{ text: string; failed: boolean }>('tools.call', {
    name: request.params.name,
    args: request.params.arguments ?? {},
  });
  return { content: [{ type: 'text' as const, text: result.text }], isError: result.failed };
});

await server.connect(new StdioServerTransport());
