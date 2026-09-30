import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { LOCAL_INSTRUCTIONS, startBridge, type RunningBridge } from '../src/bridge';
import { RemoteProxy } from '../src/remote';
import { connectClient, fakeRemote, httpRemote, inMemoryRemote, REMOTE_INSTRUCTIONS, testConfig } from './helpers/remote';

const quiet = () => undefined;

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: { code?: number; message: string; data?: unknown } }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    const err = e as { code?: number; message: string; data?: unknown };
    return { ok: false, error: { code: err.code, message: err.message, data: err.data } };
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('bridge over an in-memory remote', () => {
  let bridge: RunningBridge;
  let remote: ReturnType<typeof inMemoryRemote>;
  let client: Client;
  let direct: Client;
  let toolsChanged = 0;

  beforeEach(async () => {
    toolsChanged = 0;
    remote = inMemoryRemote();
    const proxy = new RemoteProxy({ url: 'https://mcp.test.local/mcp', token: 't', version: 'test', transportFactory: remote.factory, log: quiet });
    bridge = await startBridge(testConfig(), { remote: proxy, log: quiet });
    client = await connectClient(bridge.server, () => toolsChanged++);
    direct = await connectClient(fakeRemote());
  });
  afterEach(async () => {
    await client.close();
    await direct.close();
    await bridge.close();
  });

  it('lists local tools first, then every remote tool with name and schemas untouched', async () => {
    const { tools } = await client.listTools();
    const remoteTools = (await direct.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['pw_local_list_files', 'pw_local_read_text', ...remoteTools.map((t) => t.name)]);
    expect(tools.slice(2)).toEqual(remoteTools);
    const local = tools[0];
    expect(local.inputSchema).toMatchObject({ type: 'object', required: ['folder'] });
    expect(local.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('passes the remote instructions through and appends the local note', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions.startsWith(REMOTE_INSTRUCTIONS)).toBe(true);
    expect(instructions).toContain(LOCAL_INSTRUCTIONS);
  });

  it('forwards a call and returns the remote result unchanged', async () => {
    for (const [name, args] of [
      ['pw_meta_whoami', {}],
      ['pw_works_get', { workId: 'w1' }],
    ] as const) {
      const via = await client.callTool({ name, arguments: args });
      const straight = await direct.callTool({ name, arguments: args });
      expect(via).toEqual(straight);
    }
  });

  it('returns a remote tool error (isError result) unchanged', async () => {
    const via = await client.callTool({ name: 'pw_works_get', arguments: { workId: 'missing' } });
    const straight = await direct.callTool({ name: 'pw_works_get', arguments: { workId: 'missing' } });
    expect(via.isError).toBe(true);
    expect(via).toEqual(straight);
    expect(via.structuredContent).toEqual({ code: 'NOT_FOUND', message: 'Work not found or not yours.' });
  });

  it('returns remote protocol-level outcomes unchanged (JSON-RPC error for an unknown tool, handler throw, bad arguments)', async () => {
    const outcomes = [];
    for (const [name, args] of [
      ['pw_does_not_exist', {}],
      ['pw_protocol_fail', {}],
      ['pw_works_get', { workId: 42 }],
    ] as const) {
      const via = await settle(client.callTool({ name, arguments: args as Record<string, unknown> }));
      const straight = await settle(direct.callTool({ name, arguments: args as Record<string, unknown> }));
      expect(via).toEqual(straight);
      outcomes.push(via);
    }
    // the unknown tool is a real JSON-RPC error — its code survives the hop
    expect(outcomes[0]).toEqual({ ok: false, error: { code: -32602, message: expect.stringContaining('pw_does_not_exist'), data: undefined } });
    // McpServer turns handler throws and schema failures into isError results
    expect(outcomes[1]).toMatchObject({ ok: true, value: { isError: true, content: [{ type: 'text', text: 'bad params from remote' }] } });
    expect(outcomes[2]).toMatchObject({ ok: true, value: { isError: true } });
  });

  it('relays progress notifications of a remote call', async () => {
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await client.callTool({ name: 'pw_slow', arguments: { steps: 3 } }, { onprogress: (p) => seen.push(p) });
    expect(r.content).toEqual([{ type: 'text', text: 'done after 3' }]);
    expect(seen.map((p) => [p.progress, p.total, p.message])).toEqual([
      [1, 3, 'step 1'],
      [2, 3, 'step 2'],
      [3, 3, 'step 3'],
    ]);
  });

  it('mirrors resources, resource templates and resource reads', async () => {
    expect((await client.listResources()).resources).toEqual((await direct.listResources()).resources);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual((await direct.listResourceTemplates()).resourceTemplates);
    expect(await client.readResource({ uri: 'panelwave://schema/outline' })).toEqual(await direct.readResource({ uri: 'panelwave://schema/outline' }));
    expect(await client.readResource({ uri: 'panelwave://works/w7' })).toEqual(await direct.readResource({ uri: 'panelwave://works/w7' }));
    const missing = await settle(client.readResource({ uri: 'panelwave://nope' }));
    expect(missing).toEqual(await settle(direct.readResource({ uri: 'panelwave://nope' })));
  });

  it('runs local tools without touching the remote', async () => {
    const r = await client.callTool({ name: 'pw_local_read_text', arguments: { path: 'package.json', maxBytes: 64 } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ name: 'package.json', truncated: true });
    const outside = await client.callTool({ name: 'pw_local_list_files', arguments: { folder: '/' } });
    expect(outside.isError).toBe(true);
    expect(outside.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('re-announces the tool list when the remote signals list_changed', async () => {
    await client.listTools();
    const live = remote.servers[remote.servers.length - 1];
    live.registerTool('pw_new_tool', { description: 'Appeared later.', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'new' }] }));
    await waitFor(() => toolsChanged > 0);
    await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'pw_new_tool'));
    expect(await client.callTool({ name: 'pw_new_tool', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'new' }] });
  });
});

describe('bridge over Streamable HTTP', () => {
  it('sends the bearer token and user agent on every request and proxies calls', async () => {
    const http = httpRemote();
    const bridge = await startBridge(testConfig(), {
      remote: new RemoteProxy({ url: 'https://mcp.test.local/mcp', token: 'pw_pat_secret', version: '0.1.0', fetch: http.fetch, log: quiet }),
      log: quiet,
    });
    const client = await connectClient(bridge.server);
    try {
      const r = await client.callTool({ name: 'pw_meta_whoami', arguments: {} });
      expect(r.structuredContent).toEqual({ userId: 'u1', scopes: ['works:read'] });
      expect(http.headers.length).toBeGreaterThan(0);
      for (const h of http.headers) {
        expect(h.get('authorization')).toBe('Bearer pw_pat_secret');
        expect(h.get('user-agent')).toBe('panelwave-mcp/0.1.0');
      }
    } finally {
      await client.close();
      await bridge.close();
      await http.close();
    }
  });
});

describe('bridge when the remote is unavailable', () => {
  it('starts with the local tools, reports UPSTREAM_UNAVAILABLE and picks the remote tools up once reachable', async () => {
    const http = httpRemote();
    let up = false;
    const fetch: typeof http.fetch = async (url, init) => {
      if (!up) throw new TypeError('fetch failed');
      return http.fetch(url, init);
    };
    let changed = 0;
    const bridge = await startBridge(testConfig(), {
      remote: new RemoteProxy({ url: 'https://mcp.test.local/mcp', token: 't', version: 'v', fetch, log: quiet }),
      log: quiet,
      retryMs: 50,
    });
    const client = await connectClient(bridge.server, () => changed++);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['pw_local_list_files', 'pw_local_read_text']);
      const r = await client.callTool({ name: 'pw_meta_whoami', arguments: {} });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect((r.content as Array<{ text: string }>)[0].text).toMatch(/Local tools still work/);

      up = true;
      await waitFor(() => changed > 0);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('pw_meta_whoami');
      expect((await client.callTool({ name: 'pw_meta_whoami', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
      await bridge.close();
      await http.close();
    }
  });

  it('maps a rejected token (HTTP 401) to UNAUTHENTICATED with the fix', async () => {
    const fetch = async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
    const bridge = await startBridge(testConfig(), {
      remote: new RemoteProxy({ url: 'https://mcp.test.local/mcp', token: 'bad', version: 'v', fetch, log: quiet }),
      log: quiet,
    });
    const client = await connectClient(bridge.server);
    try {
      const r = await client.callTool({ name: 'pw_meta_whoami', arguments: {} });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect((r.content as Array<{ text: string }>)[0].text).toMatch(/PANELWAVE_TOKEN/);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
