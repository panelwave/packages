import { Client, InMemoryTransport, type FetchLike } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, ProtocolError, ResourceTemplate, type Server } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BridgeConfig } from '../../src/config';

export const REMOTE_INSTRUCTIONS = 'PanelWave is a CMS for interactive graphic novels (remote instructions).';

/** A stand-in for the hosted gateway with a handful of representative tools and resources. */
export function fakeRemote(): McpServer {
  const s = new McpServer(
    { name: 'panelwave-gateway', version: '9.9.9' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, instructions: REMOTE_INSTRUCTIONS },
  );
  s.registerTool(
    'pw_meta_whoami',
    {
      title: 'Who am I',
      description: 'The caller.',
      inputSchema: z.object({}),
      outputSchema: z.object({ userId: z.string(), scopes: z.array(z.string()) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: 'You are u1.' }], structuredContent: { userId: 'u1', scopes: ['works:read'] } }),
  );
  s.registerTool(
    'pw_works_get',
    { title: 'Get a work', description: 'One work.', inputSchema: z.object({ workId: z.string() }), annotations: { readOnlyHint: true } },
    async ({ workId }) =>
      workId === 'missing'
        ? { isError: true, content: [{ type: 'text', text: 'NOT_FOUND: Work not found or not yours.' }], structuredContent: { code: 'NOT_FOUND', message: 'Work not found or not yours.' } }
        : { content: [{ type: 'text', text: `Work ${workId}` }, { type: 'resource_link', uri: `panelwave://works/${workId}`, name: 'work' }], structuredContent: { id: workId, title: 'Rooftop' } },
  );
  s.registerTool('pw_protocol_fail', { description: 'Throws a JSON-RPC error.', inputSchema: z.object({}) }, async () => {
    throw new ProtocolError(-32602, 'bad params from remote', { field: 'x' });
  });
  s.registerTool('pw_slow', { description: 'Reports progress.', inputSchema: z.object({ steps: z.number().int() }) }, async ({ steps }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    for (let i = 1; i <= steps; i++) {
      if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } });
    }
    return { content: [{ type: 'text', text: `done after ${steps}` }] };
  });
  s.registerResource('outline-schema', 'panelwave://schema/outline', { title: 'Outline schema', mimeType: 'application/schema+json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: '{"type":"object"}' }],
  }));
  s.registerResource(
    'work',
    new ResourceTemplate('panelwave://works/{workId}', { list: undefined }),
    { title: 'Work', mimeType: 'application/json' },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id: vars.workId }) }] }),
  );
  return s;
}

/** Connect `server` to a fresh client over an in-memory pair. */
export async function connectClient(server: { connect(t: InMemoryTransport): Promise<void> } | Server, onToolsChanged?: () => void): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await (server as { connect(t: InMemoryTransport): Promise<void> }).connect(serverSide);
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    onToolsChanged ? { listChanged: { tools: { autoRefresh: false, onChanged: () => onToolsChanged() } } } : {},
  );
  await client.connect(clientSide);
  return client;
}

/** In-memory transport factory whose server side is a fresh fake remote per connection. */
export function inMemoryRemote(make: () => McpServer = fakeRemote): { factory: () => InMemoryTransport; servers: McpServer[] } {
  const servers: McpServer[] = [];
  return {
    servers,
    factory: () => {
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const s = make();
      servers.push(s);
      void s.connect(serverSide);
      return clientSide;
    },
  };
}

/** A fetch that serves the fake remote over Streamable HTTP in-process and records request headers. */
export function httpRemote(): { fetch: FetchLike; headers: Headers[]; close(): Promise<void> } {
  const handler = createMcpHandler(() => fakeRemote(), { legacy: 'stateless', responseMode: 'auto' });
  const headers: Headers[] = [];
  return {
    headers,
    fetch: async (url, init) => {
      const req = new Request(url, init);
      headers.push(req.headers);
      return handler.fetch(req);
    },
    close: () => handler.close(),
  };
}

export function testConfig(allowedDirs: string[] = [process.cwd()]): BridgeConfig {
  return { url: 'https://mcp.test.local/mcp', token: 'pw_pat_test', allowedDirs, version: '0.1.0-test' };
}
