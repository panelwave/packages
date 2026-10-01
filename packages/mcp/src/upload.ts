import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { BridgeError, isBridgeErrorCode, toBridgeError } from './errors';
import { imageDimensions, kindOfMime, mimeOf, naturalCompare, scanFolder, type FileKind } from './files';
import { resolveAllowed } from './sandbox';
import { defineLocalTool, formatBytes, mapLimit, type LocalToolContext, type RemoteCaller, type RemoteResult } from './tool';

/** Kinds the asset library accepts. */
export const UPLOADABLE_KINDS: ReadonlySet<FileKind> = new Set(['image', 'video', 'audio', 'font']);
export const MAX_FILES = 500;
export const MAX_ATTEMPTS = 3;

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024, signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readRange(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== length) throw new BridgeError('PRECONDITION_FAILED', `${path.basename(file)} changed while uploading (expected ${length} bytes at offset ${offset}, read ${read}).`);
    return buf;
  } finally {
    await handle.close();
  }
}

/** Call a hosted tool and return its structured result; an isError result is re-raised with the remote code. */
export async function remoteData(call: RemoteCaller, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let res: RemoteResult;
  try {
    res = await call(name, args, signal);
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    // the gateway only lists the tools the token's scopes allow — an unknown tool means a missing scope
    if (typeof err?.code === 'number' && /not found/i.test(err.message ?? '')) {
      throw new BridgeError(
        'PERMISSION_DENIED',
        `${name} is not available on this connection — the access token probably lacks the scope (uploads need assets:write, folder lookups assets:read). Create a token with those scopes.`,
      );
    }
    throw toBridgeError(e);
  }
  const body = (res.structuredContent ?? {}) as Record<string, unknown>;
  if (res.isError) {
    const code = isBridgeErrorCode(body.code) ? body.code : 'INTERNAL';
    const text = (res.content as Array<{ type?: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text;
    throw new BridgeError(code, String(body.message ?? text ?? `${name} failed`), body.details);
  }
  return body;
}

export interface UploadFile {
  /** Absolute path (inside the sandbox). */
  abs: string;
  /** How the caller named it (relative path or as given). */
  display: string;
  size: number;
}

export interface UploadRow {
  path: string;
  filename: string;
  ok: boolean;
  status: 'uploaded' | 'exists' | 'failed' | 'cancelled';
  assetId?: string;
  deduplicated: boolean;
  kind?: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  width?: number;
  height?: number;
  mode?: 'single' | 'multipart';
  attempts?: number;
  processing?: boolean;
  warnings: string[];
  error?: { code: string; message: string };
}

export interface UploadOptions {
  workId: string;
  files: UploadFile[];
  callRemote: RemoteCaller;
  folderId?: string;
  tags?: string[];
  skipDuplicates: boolean;
  concurrency: number;
  signal?: AbortSignal;
  /** Monotonic byte progress over the whole batch. */
  onProgress?: (doneBytes: number, totalBytes: number, message: string) => void;
  fetch?: typeof fetch;
  /** Tests only: allow plain-http upload hosts beyond loopback. */
  allowInsecureUploadHosts?: boolean;
  /** Base backoff between attempts (tripled per attempt). Default 500 ms. */
  retryDelayMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new BridgeError('CANCELLED', 'The call was cancelled.'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new BridgeError('CANCELLED', 'The call was cancelled.'));
      },
      { once: true },
    );
  });

/** Storage refusals that retrying will not fix (403 is retried with a fresh URL). */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * PUT one body with up to MAX_ATTEMPTS attempts. `target(attempt, lastStatus)`
 * supplies the URL — callers re-sign after an expired/refused URL (403).
 * Returns the ETag (may be empty) and the number of attempts used.
 */
async function putWithRetry(
  opts: UploadOptions,
  label: string,
  target: (attempt: number, lastStatus?: number) => Promise<{ url: string; headers: Record<string, string> }>,
  body: () => Promise<Buffer>,
): Promise<{ etag: string; attempts: number }> {
  const doFetch = opts.fetch ?? fetch;
  let last: BridgeError | undefined;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new BridgeError('CANCELLED', 'The call was cancelled.');
    // signing (a hosted tool call) and reading the file are not retried here
    const next = await target(attempt, lastStatus);
    const url = assertUploadTarget(next.url, opts);
    const headers = safeUploadHeaders(next.headers);
    const bytes = await body();
    let res: Response | undefined;
    try {
      res = await doFetch(url, { method: 'PUT', headers, body: bytes as unknown as Uint8Array<ArrayBuffer>, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw new BridgeError('CANCELLED', 'The call was cancelled.');
      lastStatus = undefined;
      last = new BridgeError('UPSTREAM_UNAVAILABLE', `Uploading ${label} failed: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}.`);
    }
    if (res?.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { etag: res.headers.get('etag') ?? '', attempts: attempt };
    }
    if (res) {
      lastStatus = res.status;
      const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      last = new BridgeError('UPSTREAM_UNAVAILABLE', `Storage refused ${label} (HTTP ${res.status}${snippet ? `: ${snippet}` : ''}).`);
      if (!RETRYABLE_STATUS.has(res.status)) throw last;
    }
    if (attempt < MAX_ATTEMPTS) await sleep((opts.retryDelayMs ?? 500) * 3 ** (attempt - 1), opts.signal);
  }
  throw new BridgeError('UPSTREAM_UNAVAILABLE', `${last?.message ?? `Uploading ${label} failed.`} Gave up after ${MAX_ATTEMPTS} attempts — run the tool again to resume (finished files are skipped).`);
}

/**
 * Upload URLs come from the hosted server. Accept only https, or plain http to a
 * loopback host (a local MinIO in development) — never another scheme or a
 * plain-http host on the network (security review 2026-09-30).
 */
export function assertUploadTarget(url: string, opts: Pick<UploadOptions, 'allowInsecureUploadHosts'> = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError('UPSTREAM_UNAVAILABLE', 'The server returned an invalid upload URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const ok = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (loopback || opts.allowInsecureUploadHosts === true));
  if (!ok || parsed.username || parsed.password) {
    throw new BridgeError('PRECONDITION_FAILED', `Refusing to upload to ${parsed.protocol}//${parsed.host}: uploads go to https storage only.`);
  }
  return parsed.toString();
}

/** Headers for the storage PUT: never credentials or hop-by-hop headers, whatever the server suggests. */
export function safeUploadHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (/^(authorization|proxy-authorization|cookie|host|connection|transfer-encoding|content-length)$/i.test(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Upload local files into a work's asset library through the hosted tools
 * (pw_assets_begin_upload → PUT / multipart parts → pw_assets_complete_upload).
 * Files run `concurrency` at a time; parts of one file run in order, each read
 * from disk just before its PUT, so memory stays at one part per file.
 */
export async function uploadBatch(opts: UploadOptions): Promise<UploadRow[]> {
  const total = opts.files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const advance = (bytes: number, message: string) => {
    if (bytes <= 0) return;
    done += bytes;
    opts.onProgress?.(done, total, message);
  };

  // Phase 1 — check, hash and measure every file, so duplicates are decided by input order, not timing.
  interface Prepared {
    file: UploadFile;
    row: UploadRow;
    sha256?: string;
    error?: BridgeError;
  }
  const prepared = await mapLimit(opts.files, opts.concurrency, async (file): Promise<Prepared> => {
    const filename = path.basename(file.abs);
    const mimeType = mimeOf(filename);
    const kind = kindOfMime(mimeType);
    const row: UploadRow = { path: file.abs, filename, ok: false, status: 'failed', deduplicated: false, mimeType, sizeBytes: file.size, warnings: [] };
    try {
      if (opts.signal?.aborted) throw new BridgeError('CANCELLED', 'The call was cancelled.');
      if (!UPLOADABLE_KINDS.has(kind)) throw new BridgeError('INVALID_INPUT', `${filename} is not an image, video, audio or font file (${mimeType}).`);
      if (file.size <= 0) throw new BridgeError('INVALID_INPUT', `${filename} is empty.`);
      row.kind = kind;
      const sha256 = await sha256File(file.abs, opts.signal);
      row.sha256 = sha256;
      if (kind === 'image') {
        const dim = await imageDimensions(file.abs);
        if (dim) {
          row.width = dim.width;
          row.height = dim.height;
        } else row.warnings.push('Image dimensions could not be read locally; the server fills them in.');
      }
      return { file, row, sha256 };
    } catch (e) {
      return { file, row, error: opts.signal?.aborted ? new BridgeError('CANCELLED', 'The call was cancelled.') : toBridgeError(e) };
    }
  });

  // The first file per content hash owns the upload; later ones reuse its asset.
  const owners = new Map<string, { index: number; promise: Promise<UploadRow>; settle: (r: UploadRow) => void }>();
  prepared.forEach((p, index) => {
    if (!p.sha256 || owners.has(p.sha256)) return;
    let settle!: (r: UploadRow) => void;
    const promise = new Promise<UploadRow>((r) => (settle = r));
    owners.set(p.sha256, { index, promise, settle });
  });

  const finish = (p: Prepared, e: unknown, accounted: number): UploadRow => {
    const err = toBridgeError(e);
    p.row.ok = false;
    p.row.status = err.code === 'CANCELLED' ? 'cancelled' : 'failed';
    p.row.error = { code: err.code, message: err.message };
    advance(p.file.size - accounted, `${p.row.filename}: ${p.row.status}`);
    return p.row;
  };

  // Phase 2 — transfer one file: begin → PUT (single) or signed parts (multipart) → complete.
  const transfer = async (p: Prepared, account: (bytes: number, message: string) => void): Promise<UploadRow> => {
    const { file, row } = p;
    const sha256 = p.sha256!;
    const { filename, mimeType } = row;
    const kind = row.kind!;
    let multipart: { uploadId: string; s3Key: string } | undefined;
    try {
      const begin = await remoteData(opts.callRemote, 'pw_assets_begin_upload', { workId: opts.workId, filename, mimeType, sizeBytes: file.size, sha256, kind }, opts.signal);
      const beginWarnings = (begin.warnings as string[] | undefined) ?? [];
      row.warnings.push(...beginWarnings);

      if (begin.mode === 'exists') {
        if (!opts.skipDuplicates) throw new BridgeError('CONFLICT', `${filename} is already in the library (asset ${String(begin.assetId)}); skipDuplicates is false.`);
        Object.assign(row, { ok: true, status: 'exists', assetId: String(begin.assetId), deduplicated: true });
        account(file.size, `${filename}: already in the library`);
        return row;
      }

      let s3Key = String(begin.s3Key ?? '');
      let parts: Array<{ partNumber: number; etag?: string }> | undefined;
      if (begin.mode === 'single') {
        row.mode = 'single';
        let current = { url: String(begin.uploadUrl ?? ''), headers: (begin.headers as Record<string, string>) ?? { 'Content-Type': mimeType } };
        const put = await putWithRetry(
          opts,
          filename,
          async (attempt, lastStatus) => {
            if (attempt > 1 && lastStatus === 403) {
              // the presigned URL expired or was refused — ask for a fresh one
              const again = await remoteData(opts.callRemote, 'pw_assets_begin_upload', { workId: opts.workId, filename, mimeType, sizeBytes: file.size, sha256, kind }, opts.signal);
              if (again.mode !== 'single') throw new BridgeError('CONFLICT', `${filename}: the server changed the upload mode to ${String(again.mode)}; run the tool again.`);
              s3Key = String(again.s3Key ?? '');
              current = { url: String(again.uploadUrl ?? ''), headers: (again.headers as Record<string, string>) ?? { 'Content-Type': mimeType } };
            }
            return current;
          },
          () => fs.readFile(file.abs),
        );
        row.attempts = put.attempts;
        account(file.size, `${filename}: uploaded`);
      } else if (begin.mode === 'multipart') {
        row.mode = 'multipart';
        const uploadId = String(begin.uploadId ?? '');
        multipart = { uploadId, s3Key };
        const partSize = Number(begin.partSize) || 5 * 1024 * 1024;
        const partCount = Math.ceil(file.size / partSize);
        parts = [];
        let attempts = 0;
        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
          const offset = (partNumber - 1) * partSize;
          const length = Math.min(partSize, file.size - offset);
          const put = await putWithRetry(
            opts,
            `${filename} part ${partNumber}/${partCount}`,
            async () => {
              const signed = await remoteData(opts.callRemote, 'pw_assets_sign_part', { workId: opts.workId, uploadId, s3Key, partNumber }, opts.signal);
              return { url: String(signed.url ?? ''), headers: {} };
            },
            () => readRange(file.abs, offset, length),
          );
          attempts = Math.max(attempts, put.attempts);
          parts.push({ partNumber, ...(put.etag ? { etag: put.etag } : {}) });
          account(length, `${filename}: part ${partNumber}/${partCount}`);
        }
        row.attempts = attempts;
      } else {
        throw new BridgeError('INTERNAL', `Unknown upload mode ${String(begin.mode)} for ${filename}.`);
      }

      const complete = await remoteData(
        opts.callRemote,
        'pw_assets_complete_upload',
        {
          workId: opts.workId,
          s3Key,
          sha256,
          kind,
          mimeType,
          sizeBytes: file.size,
          filename,
          ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
          ...(opts.folderId ? { folderId: opts.folderId } : {}),
          ...(opts.tags?.length ? { tags: opts.tags } : {}),
          ...(multipart && parts ? { multipart: { uploadId: multipart.uploadId, parts } } : {}),
        },
        opts.signal,
      );
      multipart = undefined;
      row.assetId = String(complete.id ?? '');
      row.deduplicated = complete.deduplicated === true;
      row.status = row.deduplicated ? 'exists' : 'uploaded';
      row.processing = complete.processing === true;
      row.ok = true;
      // the asset's own warnings replace the provisional ones from begin (same facts, final state)
      const finalWarnings = (complete.warnings as string[] | undefined) ?? [];
      if (finalWarnings.length) row.warnings = row.warnings.filter((w) => !beginWarnings.includes(w));
      for (const w of finalWarnings) if (!row.warnings.includes(w)) row.warnings.push(w);
      return row;
    } catch (e) {
      if (multipart) {
        // best effort: let storage discard the parts of the unfinished upload
        await remoteData(opts.callRemote, 'pw_assets_abort_upload', { workId: opts.workId, uploadId: multipart.uploadId, s3Key: multipart.s3Key }).catch(() => undefined);
      }
      throw e;
    }
  };

  return mapLimit(prepared, opts.concurrency, async (p, index): Promise<UploadRow> => {
    let accounted = 0;
    const account = (bytes: number, message: string) => {
      accounted += bytes;
      advance(bytes, message);
    };
    if (p.error) return finish(p, p.error, 0);
    const owner = owners.get(p.sha256!)!;
    if (owner.index !== index) {
      // same bytes as an earlier file of this batch: wait for it and reuse its asset
      const prior = await owner.promise;
      try {
        if (!prior.ok || !prior.assetId) throw new BridgeError('PRECONDITION_FAILED', `Same content as ${prior.filename}, which was not uploaded.`);
        if (!opts.skipDuplicates) throw new BridgeError('CONFLICT', `${p.row.filename} has the same content as ${prior.filename} in this batch (skipDuplicates is false).`);
      } catch (e) {
        return finish(p, e, 0);
      }
      Object.assign(p.row, { ok: true, status: 'exists', assetId: prior.assetId, deduplicated: true });
      p.row.warnings.push(`Same content as ${prior.filename} — reused its asset.`);
      account(p.file.size, `${p.row.filename}: duplicate of ${prior.filename}`);
      return p.row;
    }
    try {
      if (opts.signal?.aborted) throw new BridgeError('CANCELLED', 'The call was cancelled.');
      return await transfer(p, account);
    } catch (e) {
      return finish(p, e, accounted);
    } finally {
      owner.settle(p.row);
    }
  });
}

/** Resolve (and create when missing) a folder path like "Chapter 1/Panels". */
export async function ensureFolder(call: RemoteCaller, workId: string, folderPath: string, signal?: AbortSignal): Promise<{ folderId: string; created: boolean }> {
  const segments = folderPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) throw new BridgeError('INVALID_INPUT', 'folderName is empty.');
  let items: Array<{ id: string; name: string; path: string; parentId?: string }> = [];
  try {
    items = ((await remoteData(call, 'pw_folders_list', { workId }, signal)).items as typeof items) ?? [];
  } catch (e) {
    const err = toBridgeError(e);
    if (err.code !== 'PERMISSION_DENIED') throw err; // without assets:read, fall back to creating
  }
  let parentId: string | undefined;
  let created = false;
  for (let i = 0; i < segments.length; i++) {
    const wanted = segments.slice(0, i + 1).join('/').toLowerCase();
    const hit = items.find((f) => f.path.toLowerCase() === wanted);
    if (hit) {
      parentId = hit.id;
      continue;
    }
    const res = await remoteData(call, 'pw_folders_manage', { action: 'create', workId, name: segments[i], ...(parentId ? { parentId } : {}) }, signal);
    parentId = String(res.folderId ?? '');
    if (!parentId) throw new BridgeError('INTERNAL', `Creating folder ${segments[i]} returned no id.`);
    items = (res.items as typeof items) ?? items;
    created = true;
  }
  return { folderId: parentId!, created };
}

// ---------------------------------------------------------------------------
// pw_local_upload_files
// ---------------------------------------------------------------------------

const MEDIA_GLOB_HINT = 'images, videos, audio and fonts';

const uploadInput = z
  .object({
    workId: z.string().min(1).describe('Work whose asset library receives the files.'),
    folder: z.string().optional().describe('Upload the media files of this local folder (absolute, or relative to the first allowed folder).'),
    glob: z.string().max(500).optional().describe(`File-name filter for folder, e.g. "*.{png,jpg}" — default: all ${MEDIA_GLOB_HINT}.`),
    recursive: z.boolean().default(false).describe('Include subfolders of folder.'),
    paths: z.array(z.string().min(1)).max(MAX_FILES).optional().describe('Explicit files to upload (instead of or in addition to folder).'),
    folderName: z.string().min(1).max(250).optional().describe('Asset-library folder to file the uploads into; created when missing. "A/B" = nested.'),
    folderId: z.string().optional().describe('Existing asset-library folder id (instead of folderName).'),
    tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    skipDuplicates: z
      .boolean()
      .default(true)
      .describe('Files whose bytes are already in the library (or twice in this batch) are not uploaded again; their row reports the existing assetId. false = report them as CONFLICT instead.'),
    concurrency: z.number().int().min(1).max(6).default(3).describe('Files uploaded in parallel.'),
  })
  .refine((a) => a.folder || a.paths?.length, { message: 'Pass folder or paths.', path: ['folder'] })
  .refine((a) => !(a.folderName && a.folderId), { message: 'Pass folderName or folderId, not both.', path: ['folderId'] });

const zRow = z.object({
  path: z.string(),
  filename: z.string(),
  ok: z.boolean(),
  status: z.enum(['uploaded', 'exists', 'failed', 'cancelled']),
  assetId: z.string().optional(),
  deduplicated: z.boolean(),
  kind: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  mode: z.enum(['single', 'multipart']).optional(),
  attempts: z.number().int().optional(),
  processing: z.boolean().optional(),
  warnings: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const uploadOutput = z.object({
  workId: z.string(),
  folderId: z.string().optional(),
  folderCreated: z.boolean().optional(),
  files: z.array(zRow),
  uploaded: z.number().int(),
  existing: z.number().int(),
  failed: z.number().int(),
  totalBytes: z.number().int(),
  durationMs: z.number().int(),
  skipped: z.array(z.string()).describe('Folder entries left out (not media, unreadable or outside the allowed folders).'),
});

export const uploadFiles = defineLocalTool({
  name: 'pw_local_upload_files',
  title: 'Upload local files to PanelWave',
  description:
    'Upload images, videos, audio or fonts from this computer into a work’s asset library — a whole folder (optionally filtered by glob) or a list of paths. Each file is hashed (sha-256) so content already in the library is reused instead of uploaded again; image dimensions are read locally (EXIF orientation applied). Files ≥ 10 MB go up in 5 MiB parts with retries. Optionally files everything into an asset folder (folderName is created when missing). Re-running after a failure resumes: finished files are recognised and skipped. Afterwards attach artwork with pw_panels_attach_artwork (by file name).',
  input: uploadInput,
  output: uploadOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(args, ctx: LocalToolContext) {
    if (!ctx.callRemote) throw new BridgeError('UPSTREAM_UNAVAILABLE', 'Uploading needs the connection to the PanelWave server.');
    const started = Date.now();
    const files: UploadFile[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    const add = (abs: string, display: string, size: number) => {
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) return;
      seen.add(key);
      files.push({ abs, display, size });
    };

    if (args.folder) {
      const scan = await scanFolder(args.folder, ctx.allowedDirs, {
        glob: args.glob,
        accept: args.glob ? undefined : (name) => UPLOADABLE_KINDS.has(kindOfMime(mimeOf(name))),
        recursive: args.recursive,
        limit: MAX_FILES,
        signal: ctx.signal,
      });
      if (scan.truncated) throw new BridgeError('INVALID_INPUT', `More than ${MAX_FILES} files match in ${scan.root}; narrow the glob or upload subfolders one at a time.`);
      skipped.push(...scan.skipped);
      for (const f of scan.found) add(f.abs, f.rel, f.size);
    }
    for (const p of args.paths ?? []) {
      const abs = resolveAllowed(p, ctx.allowedDirs);
      const stat = await fs.stat(abs).catch((e) => {
        throw new BridgeError(toBridgeError(e).code, `${p}: ${toBridgeError(e).message}`);
      });
      if (!stat.isFile()) throw new BridgeError('INVALID_INPUT', `${p} is not a file.`);
      add(abs, p, stat.size);
    }
    if (files.length > MAX_FILES) throw new BridgeError('INVALID_INPUT', `At most ${MAX_FILES} files per call.`);
    if (!files.length) throw new BridgeError('NOT_FOUND', `No ${args.glob ? `files matching ${args.glob}` : MEDIA_GLOB_HINT} to upload.`);
    if (!args.paths?.length) files.sort((a, b) => naturalCompare(a.display, b.display));

    let folderId = args.folderId;
    let folderCreated: boolean | undefined;
    if (args.folderName) {
      const f = await ensureFolder(ctx.callRemote, args.workId, args.folderName, ctx.signal);
      folderId = f.folderId;
      folderCreated = f.created;
    }

    let lastSent = 0;
    const rows = await uploadBatch({
      workId: args.workId,
      files,
      callRemote: ctx.callRemote,
      folderId,
      tags: args.tags,
      skipDuplicates: args.skipDuplicates,
      concurrency: args.concurrency,
      signal: ctx.signal,
      onProgress: (doneBytes, totalBytes, message) => {
        // throttle: every 2 % (and always the last one)
        if (doneBytes < totalBytes && doneBytes - lastSent < totalBytes / 50) return;
        lastSent = doneBytes;
        void ctx.progress?.(doneBytes, totalBytes, message);
      },
    });

    // existing assets were not uploaded with the folder — file them too
    const warnings: string[] = [];
    const reused = rows.filter((r) => r.ok && r.status === 'exists' && r.assetId).map((r) => r.assetId!);
    if (folderId && reused.length) {
      try {
        await remoteData(ctx.callRemote, 'pw_folders_manage', { action: 'assign', workId: args.workId, assetIds: [...new Set(reused)], folderIds: [folderId], mode: 'add' }, ctx.signal);
      } catch (e) {
        warnings.push(`Existing assets could not be filed into the folder (${toBridgeError(e).message}).`);
      }
    }

    const uploaded = rows.filter((r) => r.status === 'uploaded').length;
    const existing = rows.filter((r) => r.status === 'exists').length;
    const failed = rows.filter((r) => !r.ok).length;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    const durationMs = Date.now() - started;
    const lines = rows.slice(0, 200).map((r) =>
      r.ok
        ? `- ${r.filename} → ${r.assetId}${r.status === 'exists' ? ' (already in the library)' : ''}${r.width ? ` ${r.width}×${r.height}` : ''}`
        : `- ${r.filename}: ${r.status === 'cancelled' ? 'cancelled' : `${r.error?.code}: ${r.error?.message}`}`,
    );
    const text = [
      `${uploaded} uploaded, ${existing} already in the library, ${failed} failed — ${rows.length} file${rows.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)} in ${(durationMs / 1000).toFixed(1)} s${folderId ? `, filed into folder ${args.folderName ?? folderId}` : ''}.`,
      ...lines,
      ...(rows.length > lines.length ? [`… and ${rows.length - lines.length} more.`] : []),
      ...warnings,
      ...(failed ? ['Run the tool again to retry the failed files — finished ones are skipped.'] : []),
      ...(uploaded || existing ? ['Next: pw_panels_attach_artwork attaches the images to panels by file name.'] : []),
    ].join('\n');

    return {
      text,
      data: { workId: args.workId, ...(folderId ? { folderId } : {}), ...(folderCreated !== undefined ? { folderCreated } : {}), files: rows, uploaded, existing, failed, totalBytes, durationMs, skipped },
    };
  },
});
