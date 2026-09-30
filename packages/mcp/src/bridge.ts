import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { BridgeConfig } from './config';
import { BridgeError } from './errors';
import { errorResult, LOCAL_TOOLS, type LocalTool } from './local-tools';
import { RemoteProxy } from './remote';

export const LOCAL_INSTRUCTIONS = [
  'This PanelWave connection runs through the local bridge (@panelwave/mcp).',
  'Besides the hosted pw_* tools it offers pw_local_* tools that work on files of this computer:',
  'pw_local_list_files finds panel artwork or scripts in a folder, pw_local_read_text reads a script or outline.',
  'Only folders listed in PANELWAVE_ALLOWED_DIRS are readable; paths may be absolute or relative to the first allowed folder.',
].join(' ');

export interface BridgeOptions {
  config: BridgeConfig;
  remote: RemoteProxy;
  localTools?: LocalTool[];
  log?: (message: string) => void;
}

function toTool(t: LocalTool): Tool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema'],
    ...(t.outputSchema ? { outputSchema: t.outputSchema as Tool['outputSchema'] } : {}),
    annotations: t.annotations,
  };
}

/** Rethrow a remote JSON-RPC error unchanged; anything else becomes an internal protocol error. */
function asProtocolError(e: unknown): ProtocolError {
  if (e instanceof ProtocolError) return e;
  if (e instanceof BridgeError) return new ProtocolError(ProtocolErrorCode.InternalError, `${e.code}: ${e.message}`, { code: e.code });
  return new ProtocolError(ProtocolErrorCode.InternalError, e instanceof Error ? e.message : String(e));
}

/**
 * The stdio-facing MCP server: local file tools plus a transparent mirror of
 * the hosted PanelWave server (tool names, schemas, results and errors are
 * passed through untouched).
 */
export function createBridgeServer(opts: BridgeOptions): Server {
  const { config, remote } = opts;
  const log = opts.log ?? (() => undefined);
  const localTools = opts.localTools ?? LOCAL_TOOLS;
  const localByName = new Map(localTools.map((t) => [t.name, t]));
  const instructions = [remote.instructions, LOCAL_INSTRUCTIONS].filter(Boolean).join('\n\n');

  const server = new Server(
    { name: 'panelwave', title: 'PanelWave', version: config.version },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions,
    },
  );

  remote.onToolsChanged = () => void server.sendToolListChanged().catch(() => undefined);
  remote.onResourcesChanged = () => void server.sendResourceListChanged().catch(() => undefined);

  server.setRequestHandler('tools/list', async () => {
    let remoteTools: Tool[] = [];
    try {
      remoteTools = await remote.listTools();
    } catch (e) {
      log(`remote tools unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { tools: [...localTools.map(toTool), ...remoteTools.filter((t) => !localByName.has(t.name))] };
  });

  server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const meta = (request.params as { _meta?: { progressToken?: string | number } })._meta;
    const progressToken = ctx.mcpReq._meta?.progressToken ?? meta?.progressToken;
    const notify =
      progressToken === undefined
        ? undefined
        : (p: { progress: number; total?: number; message?: string }) =>
            ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, ...p } }).catch(() => undefined);

    const local = localByName.get(name);
    if (local) {
      return (await local.call(args, {
        allowedDirs: config.allowedDirs,
        signal: ctx.mcpReq.signal,
        progress: async (progress, total, message) => {
          await notify?.({ progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) });
        },
      })) as CallToolResult;
    }
    try {
      return await remote.callTool(name, args, {
        signal: ctx.mcpReq.signal,
        onprogress: notify ? (p) => void notify(p) : undefined,
      });
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      if (ctx.mcpReq.signal.aborted) return errorResult(new BridgeError('CANCELLED', 'The call was cancelled.')) as CallToolResult;
      return errorResult(e) as CallToolResult;
    }
  });

  server.setRequestHandler('resources/list', async () => {
    try {
      return { resources: await remote.listResources() };
    } catch (e) {
      log(`remote resources unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return { resources: [] };
    }
  });

  server.setRequestHandler('resources/templates/list', async () => {
    try {
      return { resourceTemplates: await remote.listResourceTemplates() };
    } catch (e) {
      log(`remote resource templates unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return { resourceTemplates: [] };
    }
  });

  server.setRequestHandler('resources/read', async (request, ctx) => {
    try {
      return await remote.readResource(request.params.uri, ctx.mcpReq.signal);
    } catch (e) {
      throw asProtocolError(e);
    }
  });

  return server;
}

export interface RunningBridge {
  server: Server;
  remote: RemoteProxy;
  close(): Promise<void>;
}

/**
 * Build the proxy + server. The remote is contacted once up front (for its
 * instructions and tool list); when that fails the bridge still starts and
 * retries in the background, announcing the remote tools via list_changed
 * once they are reachable.
 */
export async function startBridge(
  config: BridgeConfig,
  opts: { log?: (message: string) => void; remote?: RemoteProxy; connectTimeoutMs?: number; retryMs?: number } = {},
): Promise<RunningBridge> {
  const log = opts.log ?? (() => undefined);
  const remote = opts.remote ?? new RemoteProxy({ url: config.url, token: config.token, version: config.version, log });

  /** 'connected', 'fatal' (bad token — retrying cannot help) or 'retry'. */
  const tryConnect = async (): Promise<'connected' | 'fatal' | 'retry'> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeError('UPSTREAM_UNAVAILABLE', 'connect timed out')), opts.connectTimeoutMs ?? 15_000);
    });
    try {
      await Promise.race([remote.connect().then(() => remote.listTools()), timeout]);
      return 'connected';
    } catch (e) {
      const err = e instanceof BridgeError ? e : new BridgeError('UPSTREAM_UNAVAILABLE', e instanceof Error ? e.message : String(e));
      log(`PanelWave MCP server not reachable: ${err.message}`);
      return err.code === 'UNAUTHENTICATED' ? 'fatal' : 'retry';
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await tryConnect();
  const server = createBridgeServer({ config, remote, log });
  let retry: NodeJS.Timeout | undefined;
  if (first === 'retry') {
    retry = setInterval(() => {
      void tryConnect().then((state) => {
        if (state === 'retry' || !retry) return;
        clearInterval(retry);
        retry = undefined;
        if (state === 'connected') {
          log('connected to the PanelWave MCP server');
          void server.sendToolListChanged().catch(() => undefined);
          void server.sendResourceListChanged().catch(() => undefined);
        }
      });
    }, opts.retryMs ?? 30_000);
    retry.unref();
  }

  return {
    server,
    remote,
    async close() {
      if (retry) clearInterval(retry);
      await remote.close();
      await server.close().catch(() => undefined);
    },
  };
}
