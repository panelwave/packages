import {
  Client,
  ProtocolError,
  SdkError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type FetchLike,
  type ReadResourceResult,
  type Resource,
  type Tool,
  type Transport,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import { BridgeError } from './errors';

/** A resource template as `resources/templates/list` returns it. */
export type RemoteResourceTemplate = { uriTemplate: string; name: string; [key: string]: unknown };

export interface RemoteProxyOptions {
  url: string;
  token: string;
  version: string;
  /** Transport override (tests: an in-memory pair). Default: Streamable HTTP with the bearer header. */
  transportFactory?: () => Transport;
  /** fetch override for the default Streamable HTTP transport. */
  fetch?: FetchLike;
  versionNegotiation?: VersionNegotiationOptions;
  /** Called after the remote tool list changed (and was re-read). */
  onToolsChanged?: () => void;
  /** Called after the remote resource list changed. */
  onResourcesChanged?: () => void;
  log?: (message: string) => void;
  /** Per-request timeout; reset on every progress notification. Default 5 min. */
  requestTimeoutMs?: number;
  /** Hard cap for one tool call including progress resets. Default 30 min. */
  maxCallMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
}

/**
 * Mirrors the hosted PanelWave MCP server: tools/list (names untouched),
 * tools/call, resources/list, resources/templates/list and resources/read.
 * Connects lazily and reconnects after transport failures, so the bridge
 * starts (and its local tools work) even while the remote is unreachable.
 */
export class RemoteProxy {
  private client?: Client;
  private connecting?: Promise<Client>;
  private toolCache?: Tool[];
  instructions?: string;
  serverVersion?: { name: string; version: string };
  /** Called after the remote tool list changed (the bridge re-announces it downstream). */
  onToolsChanged?: () => void;
  /** Called after the remote resource list changed. */
  onResourcesChanged?: () => void;

  constructor(private readonly opts: RemoteProxyOptions) {
    this.onToolsChanged = opts.onToolsChanged;
    this.onResourcesChanged = opts.onResourcesChanged;
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  get connected(): boolean {
    return !!this.client;
  }

  /** Connect (once); concurrent callers share the attempt, a failure is retried by the next call. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private transport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory();
    return new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.token}`, 'User-Agent': `panelwave-mcp/${this.opts.version}` } },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  private async open(): Promise<Client> {
    const client = new Client(
      { name: 'panelwave-mcp-bridge', version: this.opts.version },
      {
        capabilities: {},
        versionNegotiation: this.opts.versionNegotiation ?? { mode: 'auto' },
        listChanged: {
          tools: {
            onChanged: (error, items) => {
              if (error) {
                this.log(`remote tool list refresh failed: ${error.message}`);
                this.toolCache = undefined;
              } else if (items) {
                this.toolCache = items;
              }
              this.onToolsChanged?.();
            },
          },
          resources: {
            onChanged: () => this.onResourcesChanged?.(),
          },
        },
      },
    );
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.toolCache = undefined;
      }
    };
    client.onerror = (e) => this.log(`remote transport error: ${e.message}`);
    try {
      await client.connect(this.transport());
    } catch (e) {
      await client.close().catch(() => undefined);
      throw this.mapFailure(e, 'connect');
    }
    this.client = client;
    this.instructions = client.getInstructions();
    this.serverVersion = client.getServerVersion();
    return client;
  }

  /**
   * Transport-level failures become BridgeErrors (UNAUTHENTICATED /
   * UPSTREAM_UNAVAILABLE) and drop the connection; JSON-RPC errors from the
   * remote pass through unchanged.
   */
  private mapFailure(e: unknown, what: string): unknown {
    if (e instanceof ProtocolError) return e;
    if (e instanceof BridgeError) return e;
    const status = e instanceof SdkHttpError ? e.status : undefined;
    if (e instanceof UnauthorizedError || status === 401) {
      this.drop();
      return new BridgeError(
        'UNAUTHENTICATED',
        'PanelWave rejected PANELWAVE_TOKEN (expired, revoked or mistyped). Create a new personal access token in PanelWave (Profile → Connected apps & access tokens) and update the MCP client configuration.',
      );
    }
    if (status === 403) {
      return new BridgeError('UNAUTHENTICATED', `PanelWave refused the request (HTTP 403). The token may lack the scopes this tool needs.`);
    }
    if (e instanceof SdkError && e.code === 'REQUEST_TIMEOUT') {
      return new BridgeError('UPSTREAM_UNAVAILABLE', `The PanelWave server did not answer in time (${what}). Check the job with pw_jobs_get or retry.`);
    }
    if (e instanceof SdkError && e.code === 'INVALID_RESULT') {
      return new BridgeError('INTERNAL', `The PanelWave server sent a result the bridge could not validate: ${e.message}`);
    }
    this.drop();
    const reason = e instanceof Error ? e.message : String(e);
    return new BridgeError('UPSTREAM_UNAVAILABLE', `Cannot reach the PanelWave MCP server at ${this.opts.url} (${reason}). Local tools still work; retry in a moment.`);
  }

  private drop(): void {
    const c = this.client;
    this.client = undefined;
    this.toolCache = undefined;
    void c?.close().catch(() => undefined);
  }

  private async withClient<T>(what: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (e) {
      throw this.mapFailure(e, what);
    }
  }

  /** All remote tools (every page), cached until the remote signals list_changed. */
  async listTools(): Promise<Tool[]> {
    if (this.client && this.toolCache) return this.toolCache;
    const tools = await this.withClient('tools/list', async (c) => {
      const all: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listTools(cursor ? { cursor } : undefined);
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    });
    this.toolCache = tools;
    return tools;
  }

  /** Whether `name` is a known remote tool (from the last listing). */
  hasTool(name: string): boolean {
    return !!this.toolCache?.some((t) => t.name === name);
  }

  async callTool(name: string, args: Record<string, unknown> | undefined, opts: CallOptions = {}): Promise<CallToolResult> {
    // The client validates structured results against the listed output schemas — make sure it has them.
    if (!this.toolCache || !this.client) await this.listTools();
    return this.withClient(`tools/call ${name}`, (c) =>
      c.callTool(
        { name, arguments: args ?? {} },
        {
          signal: opts.signal,
          onprogress: opts.onprogress,
          timeout: this.opts.requestTimeoutMs ?? 5 * 60_000,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: this.opts.maxCallMs ?? 30 * 60_000,
        },
      ),
    );
  }

  async listResources(): Promise<Resource[]> {
    return this.withClient('resources/list', async (c) => {
      if (!c.getServerCapabilities()?.resources) return [];
      const all: Resource[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listResources(cursor ? { cursor } : undefined);
        all.push(...page.resources);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    });
  }

  async listResourceTemplates(): Promise<RemoteResourceTemplate[]> {
    return this.withClient('resources/templates/list', async (c) => {
      if (!c.getServerCapabilities()?.resources) return [];
      const all: RemoteResourceTemplate[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listResourceTemplates(cursor ? { cursor } : undefined);
        all.push(...(page.resourceTemplates as RemoteResourceTemplate[]));
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    });
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return this.withClient(`resources/read ${uri}`, (c) => c.readResource({ uri }, { signal }));
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }
}
