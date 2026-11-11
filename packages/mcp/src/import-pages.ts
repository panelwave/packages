import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { BridgeError, toBridgeError } from './errors';
import { imageDimensions, readHead } from './files';
import { resolveAllowed } from './sandbox';
import { defineLocalTool, formatBytes } from './tool';
import { putWithRetry, readRange, remoteData, type UploadOptions } from './upload';

/**
 * pw_local_import_pages — local comic pages into a PanelWave page import
 * (docs/improvements/ai-generator-interop.md §8). Images, CBZ/ZIP archives
 * and PDFs are classified by their bytes, uploaded to the presigned targets
 * pw_import_pages_create hands out (multipart parts for big files), confirmed,
 * and — once the server has unpacked the archives/PDFs/strips — panel
 * detection is started. Nothing is unpacked or rendered locally: the server
 * does that (D1), so PDFs work here too.
 */

export const MAX_IMPORT_FILES = 250;
const MAX_PAGE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
/** Height/width above which an image is a webtoon strip the server slices. */
const STRIP_ASPECT = 2.2;

type ImportKind = 'page' | 'cbz' | 'pdf' | 'strip';

interface Classified {
  abs: string;
  name: string;
  size: number;
  kind: ImportKind;
  mimeType?: string;
  width?: number;
  height?: number;
}

function startsWith(b: Buffer, sig: number[], at = 0): boolean {
  return b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
}

/** What a file really is, from its first bytes. */
export function sniffImportKind(head: Buffer): 'png' | 'jpeg' | 'webp' | 'zip' | 'pdf' | 'rar' | 'unknown' {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  return 'unknown';
}

async function classify(requested: string, allowedDirs: string[]): Promise<Classified> {
  const abs = resolveAllowed(requested, allowedDirs, { allowHidden: false });
  const stat = await fs.stat(abs).catch((e) => {
    throw toBridgeError(e);
  });
  const name = path.basename(abs);
  if (stat.isDirectory()) throw new BridgeError('INVALID_INPUT', `${name} is a folder — list its pages with pw_local_list_files and pass the files.`);
  const { buf } = await readHead(abs, 4096).catch((e) => {
    throw toBridgeError(e);
  });
  const kind = sniffImportKind(buf);
  if (kind === 'rar') throw new BridgeError('INVALID_INPUT', `${name} is a CBR (RAR) archive — convert it to CBZ first.`);
  if (kind === 'unknown') throw new BridgeError('INVALID_INPUT', `${name} is not a PNG, JPEG, WebP, CBZ/ZIP or PDF file.`);
  if (kind === 'zip' || kind === 'pdf') {
    if (stat.size > MAX_SOURCE_BYTES) throw new BridgeError('INVALID_INPUT', `${name} is larger than 1 GB.`);
    return { abs, name, size: stat.size, kind: kind === 'zip' ? 'cbz' : 'pdf' };
  }
  const mimeType = kind === 'png' ? 'image/png' : kind === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const dim = await imageDimensions(abs);
  if (dim && dim.width > 0 && dim.height / dim.width > STRIP_ASPECT) {
    if (stat.size > MAX_SOURCE_BYTES) throw new BridgeError('INVALID_INPUT', `${name} is larger than 1 GB.`);
    return { abs, name, size: stat.size, kind: 'strip', mimeType, ...dim };
  }
  if (stat.size > MAX_PAGE_BYTES) throw new BridgeError('INVALID_INPUT', `${name} is larger than 25 MB (page images are limited to 25 MB; export it smaller).`);
  return { abs, name, size: stat.size, kind: 'page', mimeType, ...(dim ? { width: dim.width, height: dim.height } : {}) };
}

const zUploadTarget = z.object({
  fileName: z.string(),
  kind: z.string(),
  pageIndex: z.number().int().optional().nullable(),
  sourceId: z.string().optional().nullable(),
  uploadUrl: z.string().optional().nullable(),
  headers: z.record(z.string(), z.string()).optional().nullable(),
  partSize: z.number().optional().nullable(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })).optional().nullable(),
});

const importInput = z.object({
  paths: z.array(z.string().min(1)).min(1).max(MAX_IMPORT_FILES).describe('Page images, .cbz/.zip archives and .pdf files, in reading order (absolute, or relative to the first allowed folder).'),
  workId: z.string().optional().describe('Append to this work … '),
  chapterId: z.string().optional().describe('… and chapter (both needed to append; otherwise a new work is created).'),
  workTitle: z.string().max(255).optional().describe('Title of the new work.'),
  readingDirection: z.enum(['ltr', 'rtl']).optional(),
  pageFormat: z.string().max(40).optional(),
  lettering: z.enum(['keep', 'editable']).optional().describe('"editable" turns the balloons painted into the pages into editable PanelWave balloons.'),
  sourceLocale: z.string().max(35).optional().describe('BCP-47 language of the lettering, e.g. ja-JP.'),
  detect: z.boolean().default(true).describe('Start panel detection once every file is unpacked.'),
  waitSeconds: z.number().int().min(0).max(900).default(240).describe('How long to wait for the server to unpack archives/PDFs before returning.'),
});

const importOutput = z.object({
  sessionId: z.string(),
  status: z.string(),
  files: z.array(z.object({ path: z.string(), kind: z.string(), sizeBytes: z.number().int() })),
  uploadedBytes: z.number().int(),
  pageCount: z.number().int(),
  sources: z.array(z.record(z.string(), z.unknown())),
  detectionStarted: z.boolean(),
  jobId: z.string().optional(),
  next: z.string(),
});

export const importPages = defineLocalTool({
  name: 'pw_local_import_pages',
  title: 'Import local comic pages',
  description:
    'Import finished comic pages from this computer into PanelWave: page images (PNG/JPEG/WebP), CBZ/ZIP archives and PDFs — e.g. an AI generator\'s chapter export. Files are classified by their bytes (tall images become webtoon strips that are cut into pages), uploaded to a new page import (pw_import_pages_create), unpacked on the server and — unless detect is false — AI panel detection is started (with lettering "editable" the painted balloons are detected too). Then review with pw_import_pages_status / pw_import_pages_update and build the work with pw_import_pages_finalize.',
  input: importInput,
  output: importOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(args, ctx) {
    const call = ctx.callRemote;
    if (!call) throw new BridgeError('UPSTREAM_UNAVAILABLE', 'Importing needs the connection to the PanelWave server.');

    const files: Classified[] = [];
    for (const p of args.paths) files.push(await classify(p, ctx.allowedDirs));
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    await ctx.progress?.(0, totalBytes, `Creating the import for ${files.length} file(s)…`);

    const created = await remoteData(
      call,
      'pw_import_pages_create',
      {
        files: files.map((f) => ({ fileName: f.name, sizeBytes: f.size, kind: f.kind, ...(f.mimeType ? { mimeType: f.mimeType } : {}) })),
        ...(args.workId && args.chapterId ? { target: { workId: args.workId, chapterId: args.chapterId } } : { target: { workTitle: args.workTitle ?? '' } }),
        ...(args.readingDirection ? { readingDirection: args.readingDirection } : {}),
        ...(args.pageFormat ? { pageFormat: args.pageFormat } : {}),
        ...(args.lettering ? { lettering: args.lettering } : {}),
        ...(args.sourceLocale ? { sourceLocale: args.sourceLocale } : {}),
      },
      ctx.signal
    );
    const sessionId = String(created.sessionId ?? '');
    const targets = z.array(zUploadTarget).parse(created.uploads ?? []);
    if (targets.length !== files.length) throw new BridgeError('INTERNAL', 'The server returned a different number of upload targets than files.');

    const putOpts = { workId: '', files: [], callRemote: call, skipDuplicates: true, concurrency: 1, signal: ctx.signal } as UploadOptions;
    let uploaded = 0;
    const pages: Array<{ pageIndex: number; width?: number; height?: number }> = [];
    const sourceIds: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const target = targets[i];
      if (target.parts?.length) {
        const partSize = Number(target.partSize ?? 0);
        for (const part of target.parts) {
          const offset = (part.partNumber - 1) * partSize;
          const length = Math.min(partSize, file.size - offset);
          await putWithRetry(putOpts, `${file.name} part ${part.partNumber}`, async () => ({ url: part.url, headers: {} }), () => readRange(file.abs, offset, length));
          uploaded += length;
          await ctx.progress?.(uploaded, totalBytes, `Uploading ${file.name} (part ${part.partNumber}/${target.parts.length})`);
        }
      } else {
        await putWithRetry(
          putOpts,
          file.name,
          async () => ({ url: String(target.uploadUrl ?? ''), headers: (target.headers ?? {}) as Record<string, string> }),
          () => fs.readFile(file.abs)
        );
        uploaded += file.size;
        await ctx.progress?.(uploaded, totalBytes, `Uploaded ${file.name}`);
      }
      if (target.pageIndex !== undefined && target.pageIndex !== null) {
        pages.push({ pageIndex: target.pageIndex, ...(file.width ? { width: file.width, height: file.height } : {}) });
      } else if (target.sourceId) {
        sourceIds.push(target.sourceId);
      }
    }

    let status = await remoteData(call, 'pw_import_pages_confirm', { sessionId, ...(pages.length ? { pages } : {}), ...(sourceIds.length ? { sourceIds } : {}) }, ctx.signal);

    // Archives, PDFs and strips unpack on the server: wait for them.
    const deadline = Date.now() + args.waitSeconds * 1000;
    while (String(status.status) === 'expanding' && Date.now() < deadline) {
      const sources = (status.sources ?? []) as Array<Record<string, unknown>>;
      const busy = sources.find((s) => s.status === 'expanding' || s.status === 'uploaded');
      await ctx.progress?.(uploaded, totalBytes, busy ? `Unpacking ${busy.name} (${busy.done ?? 0}/${busy.total ?? '?'})…` : 'Unpacking…');
      await new Promise((r) => setTimeout(r, 2000));
      status = await remoteData(call, 'pw_import_pages_status', { sessionId }, ctx.signal);
    }

    const sources = (status.sources ?? []) as Array<Record<string, unknown>>;
    const pageCount = Number(status.pageCount ?? 0);
    let detectionStarted = false;
    let jobId: string | undefined;
    let next = String(status.next ?? '');
    if (String(status.status) === 'expanding') {
      next = `Still unpacking after ${args.waitSeconds}s — check pw_import_pages_status, then call pw_import_pages_detect.`;
    } else if (args.detect && String(status.status) === 'uploading' && pageCount > 0) {
      const detect = await remoteData(call, 'pw_import_pages_detect', { sessionId }, ctx.signal);
      detectionStarted = true;
      jobId = String(detect.jobId ?? '') || undefined;
      next = `Detection started — poll pw_jobs_get (${jobId}), review with pw_import_pages_status, then pw_import_pages_finalize.`;
    }
    const failed = sources.filter((s) => s.status === 'failed');
    const text = [
      `Import ${sessionId}: ${files.length} file(s), ${formatBytes(uploaded)} uploaded, ${pageCount} page(s).`,
      ...sources.map((s) => `- ${s.name}: ${s.status}${s.pageCount ? `, ${s.pageCount} page(s)` : ''}${s.skipped ? `, ${s.skipped} skipped (200-page cap)` : ''}${s.error ? ` — ${s.error}` : ''}`),
      ...(failed.length ? ['Remove or replace the failed files (pw_import_pages_update removeSources) before detection.'] : []),
      next,
    ].join('\n');
    return {
      text,
      data: {
        sessionId,
        status: detectionStarted ? 'detect_queued' : String(status.status ?? ''),
        files: files.map((f) => ({ path: f.abs, kind: f.kind, sizeBytes: f.size })),
        uploadedBytes: uploaded,
        pageCount,
        sources,
        detectionStarted,
        ...(jobId ? { jobId } : {}),
        next,
      },
    };
  },
});
