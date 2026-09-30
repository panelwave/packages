import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { BridgeError, toBridgeError } from './errors';
import { decodeUtf8, imageDimensions, kindOfMime, looksBinary, mimeOf, readHead, scanFolder, type FileKind } from './files';
import { resolveAllowed } from './sandbox';
import { defineLocalTool, formatBytes, mapLimit, type LocalTool } from './tool';
import { uploadFiles } from './upload';

export type { LocalTool, LocalToolContext, LocalToolResult } from './tool';
export { errorResult } from './tool';

// ---------------------------------------------------------------------------
// pw_local_list_files
// ---------------------------------------------------------------------------

export const LIST_LIMIT_DEFAULT = 1000;
export const LIST_LIMIT_MAX = 5000;
const zFileKind = z.enum(['image', 'video', 'audio', 'font', 'text', 'other']);

const zLocalFile = z.object({
  path: z.string().describe('Absolute path — pass it to pw_local_read_text or pw_local_upload_files.'),
  relativePath: z.string().describe('Path relative to the listed folder, with forward slashes.'),
  name: z.string(),
  sizeBytes: z.number().int(),
  mime: z.string(),
  kind: zFileKind,
  width: z.number().int().optional().describe('Display width in px (EXIF orientation applied).'),
  height: z.number().int().optional(),
  orientation: z.number().int().optional().describe('EXIF orientation (1–8) when present.'),
  modifiedAt: z.string(),
});

export type LocalFile = z.infer<typeof zLocalFile>;

const listFilesInput = z.object({
  folder: z.string().min(1).describe('Folder to list — absolute, or relative to the first allowed folder.'),
  glob: z.string().max(500).optional().describe('File-name filter: * ? and {a,b}, several patterns separated by ";" — e.g. "*.{png,jpg,webp}". Case-insensitive.'),
  recursive: z.boolean().default(false).describe('Include subfolders (node_modules/.git are always skipped).'),
  includeHidden: z.boolean().default(false).describe('Include dot files and dot folders.'),
  dimensions: z.boolean().default(true).describe('Read pixel dimensions of images (reads only the file header).'),
  limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
});

const listFilesOutput = z.object({
  folder: z.string(),
  files: z.array(zLocalFile),
  count: z.number().int(),
  truncated: z.boolean().describe('True when more files matched than `limit`.'),
  totalSizeBytes: z.number().int(),
  byKind: z.record(z.string(), z.number().int()),
  skipped: z.array(z.string()).describe('Entries that could not be read or point outside the allowed folders.'),
});

export const listFiles = defineLocalTool({
  name: 'pw_local_list_files',
  title: 'List local files',
  description:
    'List files in a folder on this computer (only inside the folders the PanelWave bridge was allowed to read). Returns absolute paths, size, mime type, kind (image/video/audio/font/text/other) and — for images — pixel dimensions with EXIF orientation applied. Files are sorted naturally (panel-2 before panel-10). Use it to find panel artwork before pw_local_upload_files, or a script before pw_local_read_text.',
  input: listFilesInput,
  output: listFilesOutput,
  async run(args, ctx) {
    const { root, found, skipped, truncated } = await scanFolder(args.folder, ctx.allowedDirs, {
      glob: args.glob,
      recursive: args.recursive,
      includeHidden: args.includeHidden,
      limit: args.limit,
      signal: ctx.signal,
    });

    const files: LocalFile[] = await mapLimit(found, 8, async (f) => {
      const name = path.basename(f.abs);
      const mime = mimeOf(name);
      const kind: FileKind = kindOfMime(mime);
      const row: LocalFile = { path: f.abs, relativePath: f.rel, name, sizeBytes: f.size, mime, kind, modifiedAt: f.mtime.toISOString() };
      if (args.dimensions && kind === 'image') {
        const dim = await imageDimensions(f.abs);
        if (dim) Object.assign(row, dim);
      }
      return row;
    });

    const byKind: Record<string, number> = {};
    let totalSizeBytes = 0;
    for (const f of files) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      totalSizeBytes += f.sizeBytes;
    }
    const kinds = Object.entries(byKind)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    const lines = files.slice(0, 200).map((f) => `- ${f.relativePath} (${formatBytes(f.sizeBytes)}${f.width ? `, ${f.width}×${f.height}` : ''})`);
    const text = [
      files.length ? `${files.length} file${files.length === 1 ? '' : 's'} in ${root} (${kinds}; ${formatBytes(totalSizeBytes)})${truncated ? ` — truncated at ${args.limit}, narrow the glob or raise limit` : ''}:` : `No matching files in ${root}.`,
      ...lines,
      ...(files.length > lines.length ? [`… and ${files.length - lines.length} more (see structured result).`] : []),
      ...(skipped.length ? [`Skipped ${skipped.length} unreadable or out-of-sandbox entr${skipped.length === 1 ? 'y' : 'ies'}.`] : []),
    ].join('\n');

    return { text, data: { folder: root, files, count: files.length, truncated, totalSizeBytes, byKind, skipped } };
  },
});

// ---------------------------------------------------------------------------
// pw_local_read_text
// ---------------------------------------------------------------------------

export const READ_DEFAULT_BYTES = 1024 * 1024;
export const READ_MAX_BYTES = 5 * 1024 * 1024;

const readTextInput = z.object({
  path: z.string().min(1).describe('File to read — absolute, or relative to the first allowed folder.'),
  maxBytes: z.number().int().min(1).max(READ_MAX_BYTES).default(READ_DEFAULT_BYTES).describe('Read at most this many bytes (default 1 MiB, max 5 MiB).'),
});

const readTextOutput = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string(),
  text: z.string(),
  sizeBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
});

export const readText = defineLocalTool({
  name: 'pw_local_read_text',
  title: 'Read a local text file',
  description:
    'Read a UTF-8 text file on this computer — a script, screenplay (.fountain), outline (.md/.json) or subtitle file — from the folders the PanelWave bridge may read. Long files are cut at maxBytes (default 1 MiB) and flagged `truncated`. Binary files are refused.',
  input: readTextInput,
  output: readTextOutput,
  async run(args, ctx) {
    // No dotfiles or dot-folders (.ssh, .env, .git …): scripts never live there, secrets often do.
    const file = resolveAllowed(args.path, ctx.allowedDirs, { allowHidden: false });
    const stat = await fs.stat(file).catch((e) => {
      throw toBridgeError(e);
    });
    if (stat.isDirectory()) throw new BridgeError('INVALID_INPUT', `${args.path} is a folder. Use pw_local_list_files to list it.`);
    const { buf, sizeBytes } = await readHead(file, args.maxBytes).catch((e) => {
      throw toBridgeError(e);
    });
    if (looksBinary(buf)) throw new BridgeError('PRECONDITION_FAILED', `${path.basename(file)} is a binary file (${mimeOf(file)}), not text. Upload media with pw_local_upload_files instead.`);
    const truncated = sizeBytes > buf.length;
    const text = decodeUtf8(buf, truncated);
    const name = path.basename(file);
    const header = truncated
      ? `${name}: first ${formatBytes(buf.length)} of ${formatBytes(sizeBytes)} (truncated — raise maxBytes up to 5 MiB to read more).`
      : `${name} (${formatBytes(sizeBytes)}):`;
    return {
      text: `${header}\n\n${text}`,
      data: { path: file, name, mime: mimeOf(name), text, sizeBytes, returnedBytes: Buffer.byteLength(text, 'utf8'), truncated },
    };
  },
});

export const LOCAL_TOOLS: LocalTool[] = [listFiles, readText, uploadFiles];
