import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { imageSize } from 'image-size';
import { BridgeError, toBridgeError } from './errors';
import { resolveAllowed } from './sandbox';

export type FileKind = 'image' | 'video' | 'audio' | 'font' | 'text' | 'other';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.fountain': 'text/x-fountain',
  '.fdx': 'application/xml',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

export function mimeOf(filename: string): string {
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Asset kind as the gateway understands it (image/video/audio/font), plus text and other. */
export function kindOfMime(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('font/')) return 'font';
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/x-subrip'].includes(mime)) return 'text';
  return 'other';
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/**
 * Compile a file-name glob: `*` (any run), `?` (one char), `{a,b}` (alternatives),
 * matched case-insensitively against the file name. Several patterns may be
 * given separated by `;`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (const ch of glob) {
    if (ch === '*') re += '[^/\\\\]*';
    else if (ch === '?') re += '[^/\\\\]';
    else if (ch === '{') {
      depth++;
      re += '(?:';
    } else if (ch === '}' && depth > 0) {
      depth--;
      re += ')';
    } else if (ch === ',' && depth > 0) re += '|';
    else re += escapeRe(ch);
  }
  if (depth > 0) throw new BridgeError('INVALID_INPUT', `Unbalanced "{" in glob ${glob}.`);
  return new RegExp(`^${re}$`, 'i');
}

export function matchesGlob(name: string, glob: string | undefined): boolean {
  if (!glob) return true;
  return glob
    .split(';')
    .map((g) => g.trim())
    .filter(Boolean)
    .some((g) => globToRegExp(g).test(name));
}

export interface ImageDimensions {
  width: number;
  height: number;
  /** EXIF orientation when present (1–8). */
  orientation?: number;
}

/**
 * Display dimensions of an image file. EXIF orientations 5–8 rotate the image
 * by 90°, so width and height are swapped to match what viewers show.
 * Returns undefined for files image-size cannot read (and for SVGs without size).
 */
export async function imageDimensions(filePath: string): Promise<ImageDimensions | undefined> {
  // Headers normally fit in 512 KB; JPEGs with a large EXIF/XMP block before
  // the frame header get a second, bigger read.
  for (const bytes of HEADER_READS) {
    let head: { buf: Buffer; sizeBytes: number };
    try {
      head = await readHead(filePath, bytes);
    } catch {
      return undefined;
    }
    try {
      const r = imageSize(head.buf);
      if (!r.width || !r.height) return undefined;
      const rotated = r.orientation !== undefined && r.orientation >= 5 && r.orientation <= 8;
      return { width: rotated ? r.height : r.width, height: rotated ? r.width : r.height, ...(r.orientation ? { orientation: r.orientation } : {}) };
    } catch {
      if (head.sizeBytes <= head.buf.length) return undefined; // whole file read — not an image we understand
    }
  }
  return undefined;
}

const HEADER_READS = [512 * 1024, 8 * 1024 * 1024];

/** Natural sort (panel-2 before panel-10), case-insensitive. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Decode UTF-8 text, dropping a BOM and — when the buffer was cut — a partial
 * multi-byte sequence at the end.
 */
export function decodeUtf8(buf: Uint8Array, cut: boolean): string {
  let end = buf.length;
  if (cut) {
    // Step back over continuation bytes to the lead byte of the last sequence.
    let i = end - 1;
    while (i >= 0 && i > end - 4 && (buf[i] & 0xc0) === 0x80) i--;
    if (i >= 0) {
      const lead = buf[i];
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (end - i < need) end = i;
    }
  }
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  return new TextDecoder('utf-8').decode(buf.subarray(start, Math.max(start, end)));
}

export async function readHead(filePath: string, maxBytes: number): Promise<{ buf: Buffer; sizeBytes: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await handle.read(buf, read, len - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { buf: buf.subarray(0, read), sizeBytes: stat.size };
  } finally {
    await handle.close();
  }
}

export const MAX_DEPTH = 12;
export const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__MACOSX', '$RECYCLE.BIN', 'System Volume Information']);

export interface ScanOptions {
  /** File-name glob (see globToRegExp). */
  glob?: string;
  /** Extra filter applied after the glob (e.g. "media files only"). */
  accept?: (name: string) => boolean;
  recursive?: boolean;
  includeHidden?: boolean;
  limit: number;
  signal?: AbortSignal;
}

export interface ScannedFile {
  abs: string;
  /** Relative to the scanned folder, forward slashes. */
  rel: string;
  size: number;
  mtime: Date;
}

/**
 * Walk a folder inside the sandbox: natural order, subfolders after the files
 * of a folder, symlinks followed only when their target is allowed too,
 * node_modules/.git and (unless asked) dot entries skipped.
 */
export async function scanFolder(
  folder: string,
  allowedDirs: string[],
  opts: ScanOptions,
): Promise<{ root: string; found: ScannedFile[]; skipped: string[]; truncated: boolean }> {
  const root = resolveAllowed(folder, allowedDirs);
  const stat = await fs.stat(root).catch((e) => {
    throw toBridgeError(e);
  });
  if (!stat.isDirectory()) throw new BridgeError('INVALID_INPUT', `${folder} is a file, not a folder (pw_local_read_text reads a text file).`);

  const found: ScannedFile[] = [];
  const skipped: string[] = [];
  let truncated = false;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (truncated) return;
    opts.signal?.throwIfAborted();
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push(rel || '.');
      return;
    }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const entry of entries) {
      if (!opts.includeHidden && entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let target = abs;
      if (entry.isSymbolicLink()) {
        try {
          target = resolveAllowed(abs, allowedDirs);
          const s = await fs.stat(target);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          skipped.push(relPath);
          continue;
        }
      }
      if (isDir) {
        if (opts.recursive && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) subdirs.push({ abs: target, rel: relPath });
        continue;
      }
      if (!isFile || !matchesGlob(entry.name, opts.glob) || (opts.accept && !opts.accept(entry.name))) continue;
      if (found.length >= opts.limit) {
        truncated = true;
        return;
      }
      try {
        const s = await fs.stat(target);
        found.push({ abs, rel: relPath, size: s.size, mtime: s.mtime });
      } catch {
        skipped.push(relPath);
      }
    }
    for (const sub of subdirs) await walk(sub.abs, sub.rel, depth + 1);
  };
  await walk(root, '', 0);
  return { root, found, skipped, truncated };
}
