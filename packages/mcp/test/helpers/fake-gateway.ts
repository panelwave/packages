import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RemoteCaller, RemoteResult } from '../../src/tool';

const MULTIPART_THRESHOLD = 10 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;

export interface S3Request {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
}

/** A presigned-URL storage stand-in: stores PUT bodies, can fail on demand, tracks parallelism. */
export class MockS3 {
  server!: Server;
  base = '';
  objects = new Map<string, Buffer>();
  requests: S3Request[] = [];
  /** path prefix → statuses to answer before accepting (consumed in order). */
  failures = new Map<string, number[]>();
  /** path prefix → number of times to drop the connection before accepting. */
  drops = new Map<string, number>();
  delayMs = 0;
  /** Keep only sizes, not bodies (memory measurements); the fake gateway then skips its byte check. */
  discard = false;
  sizes = new Map<string, number>();
  inFlight = 0;
  maxInFlight = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          const body = Buffer.concat(chunks);
          const url = req.url ?? '/';
          this.requests.push({ method: req.method ?? '', path: url, headers: req.headers, bytes: body.length });
          if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
          for (const [prefix, left] of this.drops) {
            if (url.startsWith(prefix) && left > 0) {
              this.drops.set(prefix, left - 1);
              req.socket.destroy();
              return;
            }
          }
          for (const [prefix, statuses] of this.failures) {
            if (url.startsWith(prefix) && statuses.length) {
              const status = statuses.shift()!;
              res.writeHead(status, { 'Content-Type': 'application/xml' }).end(`<Error><Code>Injected${status}</Code></Error>`);
              return;
            }
          }
          if (req.method !== 'PUT') {
            res.writeHead(405).end();
            return;
          }
          this.sizes.set(url, body.length);
          if (!this.discard) this.objects.set(url, body);
          res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
        } finally {
          this.inFlight--;
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  puts(prefix = ''): S3Request[] {
    return this.requests.filter((r) => r.method === 'PUT' && r.path.startsWith(prefix));
  }
}

interface Asset {
  id: string;
  filename: string;
  hash: string;
  folderIds: string[];
}

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Simulates the hosted upload tools (pw_assets_begin/sign_part/complete/abort,
 * pw_folders_list/manage) the way the gateway answers them, backed by MockS3.
 */
export class FakeGateway {
  calls: Call[] = [];
  assets: Asset[] = [];
  folders: Array<{ id: string; name: string; path: string; parentId?: string }> = [];
  pending = new Map<string, { uploadId?: string; filename: string }>();
  /** tool name → error body to answer once. */
  failOnce = new Map<string, { code: string; message: string }>();
  aborted: string[] = [];

  constructor(private readonly s3: MockS3) {}

  called(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  seedAsset(sha256: string, filename: string): string {
    const id = randomUUID();
    this.assets.push({ id, filename, hash: `sha256-${sha256}`, folderIds: [] });
    return id;
  }

  private ok(data: Record<string, unknown>): RemoteResult {
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }

  private err(code: string, message: string): RemoteResult {
    return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { code, message } };
  }

  call: RemoteCaller = async (name, args) => {
    this.calls.push({ name, args });
    const injected = this.failOnce.get(name);
    if (injected) {
      this.failOnce.delete(name);
      return this.err(injected.code, injected.message);
    }
    switch (name) {
      case 'pw_assets_begin_upload': {
        const hash = `sha256-${String(args.sha256).toLowerCase()}`;
        const hit = this.assets.find((a) => a.hash === hash);
        if (hit) return this.ok({ mode: 'exists', assetId: hit.id, kind: args.kind, hash, warnings: [] });
        const s3Key = `works/${String(args.workId)}/assets/${randomUUID()}/${String(args.filename)}`;
        if (Number(args.sizeBytes) >= MULTIPART_THRESHOLD) {
          const uploadId = randomUUID();
          this.pending.set(s3Key, { uploadId, filename: String(args.filename) });
          return this.ok({ mode: 'multipart', uploadId, s3Key, partSize: PART_SIZE, partCount: Math.ceil(Number(args.sizeBytes) / PART_SIZE), kind: args.kind, hash, warnings: [] });
        }
        this.pending.set(s3Key, { filename: String(args.filename) });
        return this.ok({
          mode: 'single',
          uploadUrl: `${this.s3.base}/single/${s3Key}`,
          method: 'PUT',
          headers: { 'Content-Type': String(args.mimeType), 'x-amz-meta-origin': 'panelwave' },
          s3Key,
          kind: args.kind,
          hash,
          warnings: Number(args.sizeBytes) > 5 * 1024 * 1024 && args.kind === 'image' ? ['Images over 5 MB block publishing until an optimized variant exists.'] : [],
        });
      }
      case 'pw_assets_sign_part':
        return this.ok({ url: `${this.s3.base}/part/${String(args.s3Key)}?uploadId=${String(args.uploadId)}&partNumber=${String(args.partNumber)}`, method: 'PUT', partNumber: args.partNumber });
      case 'pw_assets_complete_upload': {
        const key = String(args.s3Key);
        const pend = this.pending.get(key);
        if (!pend) return this.err('NOT_FOUND', `No pending upload ${key}`);
        let bytes: Buffer;
        if (args.multipart) {
          const mp = args.multipart as { uploadId: string; parts: Array<{ partNumber: number }> };
          bytes = Buffer.concat(mp.parts.map((p) => this.s3.objects.get(`/part/${key}?uploadId=${mp.uploadId}&partNumber=${p.partNumber}`) ?? Buffer.alloc(0)));
        } else {
          bytes = this.s3.objects.get(`/single/${key}`) ?? Buffer.alloc(0);
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (!this.s3.discard && (sha !== String(args.sha256) || bytes.length !== Number(args.sizeBytes))) return this.err('PRECONDITION_FAILED', `Stored bytes do not match (${bytes.length} B, ${sha}).`);
        this.pending.delete(key);
        const hash = `sha256-${sha}`;
        const dup = this.assets.find((a) => a.hash === hash);
        const asset = dup ?? { id: randomUUID(), filename: String(args.filename), hash, folderIds: args.folderId ? [String(args.folderId)] : [] };
        if (!dup) this.assets.push(asset);
        return this.ok({ id: asset.id, type: args.kind, filename: asset.filename, mime: args.mimeType, sizeBytes: args.sizeBytes, status: 'processing', variants: [], folderIds: asset.folderIds, warnings: args.kind === 'image' && Number(args.sizeBytes) > 5 * 1024 * 1024 ? ['Larger than 5 MB without an optimized variant — blocks publishing until the OVERSIZED_ASSET fix runs.'] : [], deduplicated: !!dup, processing: true });
      }
      case 'pw_assets_abort_upload':
        this.aborted.push(String(args.uploadId));
        return this.ok({ aborted: true });
      case 'pw_folders_list':
        return this.ok({ items: this.folders });
      case 'pw_folders_manage': {
        if (args.action === 'create') {
          const parent = this.folders.find((f) => f.id === args.parentId);
          const folder = { id: randomUUID(), name: String(args.name), path: parent ? `${parent.path}/${String(args.name)}` : String(args.name), ...(parent ? { parentId: parent.id } : {}) };
          this.folders.push(folder);
          return this.ok({ action: 'create', folderId: folder.id, items: this.folders });
        }
        if (args.action === 'assign') {
          for (const id of args.assetIds as string[]) {
            const a = this.assets.find((x) => x.id === id);
            if (a) a.folderIds = [...new Set([...a.folderIds, ...(args.folderIds as string[])])];
          }
          return this.ok({ action: 'assign', results: (args.assetIds as string[]).map((id) => ({ ref: id, ok: true })) });
        }
        return this.err('INVALID_INPUT', 'unsupported in fake');
      }
      default:
        return this.err('NOT_FOUND', `Unknown tool ${name}`);
    }
  };
}
