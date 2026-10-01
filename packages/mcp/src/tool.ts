import { z } from 'zod';
import { BridgeError, toBridgeError } from './errors';

/** A CallToolResult as the bridge produces it (text summary + structured data). */
export interface LocalToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The subset of a remote CallToolResult the local tools read. */
export interface RemoteResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Calls a tool of the hosted PanelWave server (the bridge wires this to the RemoteProxy). */
export type RemoteCaller = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<RemoteResult>;

export interface LocalToolContext {
  allowedDirs: string[];
  signal?: AbortSignal;
  /** Progress reporter — a no-op when the client did not ask for progress. */
  progress?: (progress: number, total?: number, message?: string) => Promise<void>;
  /** Hosted tools, for local tools that combine local files with PanelWave (uploads). */
  callRemote?: RemoteCaller;
}

export interface LocalTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, unknown>;
  call(args: unknown, ctx: LocalToolContext): Promise<LocalToolResult>;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export function errorResult(e: unknown): LocalToolResult {
  const err = toBridgeError(e);
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.details !== undefined) body.details = err.details;
  return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }], structuredContent: body };
}

function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new BridgeError('INVALID_INPUT', `Invalid arguments — ${issues.join('; ')}`, { issues });
}

/** Define a local tool: zod input/output, JSON Schemas derived, errors mapped to isError results. */
export function defineLocalTool<I extends z.ZodType, O extends z.ZodType>(def: {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations?: Record<string, unknown>;
  run(args: z.output<I>, ctx: LocalToolContext): Promise<{ text: string; data: z.input<O> }>;
}): LocalTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: jsonSchema(def.input, 'input'),
    outputSchema: jsonSchema(def.output, 'output'),
    annotations: { title: def.title, ...(def.annotations ?? READ_ONLY) },
    async call(args, ctx) {
      try {
        const out = await def.run(parseArgs(def.input, args), ctx);
        return { content: [{ type: 'text', text: out.text }], structuredContent: out.data as Record<string, unknown> };
      } catch (e) {
        return errorResult(e);
      }
    },
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
