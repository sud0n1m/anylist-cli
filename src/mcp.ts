#!/usr/bin/env node
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { AnyListClient } from './client.js';
import { AnyListService } from './service.js';

const listArg = z.string().optional().describe('List name; defaults to the configured default_list');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function respond(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export function createServer(service: AnyListService = new AnyListService(new AnyListClient())): McpServer {
  const server = new McpServer({ name: 'anylist', version: '0.1.0' });

  server.registerTool(
    'lists_list',
    { description: 'List all AnyList shopping lists with item counts' },
    () =>
      respond(async () =>
        (await service.lists()).map((l) => ({
          id: l.id,
          name: l.name,
          items: l.items.length,
          unchecked: l.items.filter((i) => !i.checked).length
        }))
      )
  );

  server.registerTool(
    'lists_show',
    { description: 'Show the items on a shopping list', inputSchema: { list: listArg } },
    ({ list }) => respond(() => service.showList(list))
  );

  server.registerTool(
    'items_add',
    {
      description: 'Add items to a list. Each string is parsed, e.g. "2 cups milk" becomes quantity 2 cups, name milk.',
      inputSchema: { items: z.array(z.string().min(1)).min(1).describe('Item texts'), list: listArg }
    },
    ({ items, list }) =>
      respond(async () => {
        const added = [];
        for (const text of items) added.push(await service.addItem(text, list));
        return added;
      })
  );

  server.registerTool(
    'items_remove',
    { description: 'Remove an item from a list by name', inputSchema: { name: z.string(), list: listArg } },
    ({ name, list }) => respond(() => service.removeItem(name, list))
  );

  server.registerTool(
    'items_check',
    { description: 'Cross off an item on a list', inputSchema: { name: z.string(), list: listArg } },
    ({ name, list }) => respond(() => service.setChecked(name, true, list))
  );

  server.registerTool(
    'items_uncheck',
    { description: 'Restore a crossed-off item on a list', inputSchema: { name: z.string(), list: listArg } },
    ({ name, list }) => respond(() => service.setChecked(name, false, list))
  );

  server.registerTool(
    'recipes_list',
    { description: 'List all recipes' },
    () => respond(async () => (await service.recipes()).map((r) => ({ id: r.id, name: r.name })))
  );

  server.registerTool(
    'recipes_search',
    {
      description: 'Search recipes by name, source or ingredient',
      inputSchema: { query: z.string() }
    },
    ({ query }) => respond(async () => (await service.recipes(query)).map((r) => ({ id: r.id, name: r.name })))
  );

  server.registerTool(
    'recipes_show',
    {
      description: 'Show a recipe. Ingredients flagged isHeading are section headers, not real ingredients.',
      inputSchema: { name: z.string() }
    },
    ({ name }) => respond(() => service.showRecipe(name))
  );

  server.registerTool(
    'recipes_missing',
    {
      description: 'List recipe ingredients that are not already unchecked on the list',
      inputSchema: { name: z.string(), list: listArg }
    },
    ({ name, list }) => respond(() => service.missing(name, list))
  );

  server.registerTool(
    'recipes_add_to_list',
    {
      description: 'Add a recipe\'s missing ingredients to a list, skipping ones already unchecked on it',
      inputSchema: { name: z.string(), list: listArg, dry_run: z.boolean().optional() }
    },
    ({ name, list, dry_run }) => respond(() => service.addRecipeToList(name, list, dry_run === true))
  );

  return server;
}

function parsePort(argv: string[]): number {
  const i = argv.indexOf('--port');
  const raw = i >= 0 ? argv[i + 1] : process.env.PORT;
  const port = raw === undefined ? 3000 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function serveHttp(port: number): Promise<void> {
  const server = http.createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('Method not allowed');
      return;
    }
    try {
      // Stateless: a fresh server and transport per request.
      const mcp = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.error(`anylist-mcp listening on http://127.0.0.1:${actual}/mcp`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--http')) {
    await serveHttp(parsePort(argv));
    return;
  }
  await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
