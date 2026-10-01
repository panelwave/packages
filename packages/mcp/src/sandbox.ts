import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeError } from './errors';

/**
 * Path sandbox of the local tools: every path must resolve — symlinks
 * followed — inside one of the allowed directories (PANELWAVE_ALLOWED_DIRS).
 * Relative paths are taken relative to the first allowed directory.
 *
 * The containment check runs on the resolved TEXT first, before any
 * filesystem call: on Windows even a realpath of `\\host\share\x` opens an SMB
 * connection and sends the user's NTLM hash to that host (security review
 * 2026-09-30). UNC and device paths (`\\?\`, `\\.\`) are refused unless an
 * allowed directory is itself on that share. Only then are symlinks resolved
 * and the check repeated on the real path.
 */
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

export interface ResolveOptions {
  /** Allow path segments starting with "." (dotfiles, .ssh, .git …). Default true; pw_local_read_text passes false. */
  allowHidden?: boolean;
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // Not there (yet): resolve the nearest existing parent so a symlinked
    // parent cannot smuggle the path out of the sandbox.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(real(parent), path.basename(p));
  }
}

function norm(p: string): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

function relativeInside(child: string, parent: string): string | undefined {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : undefined;
}

/** `\\server\share`, `\\?\…`, `\\.\…` (and the forward-slash spellings Windows accepts). */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function outside(requested: string, allowedDirs: string[]): BridgeError {
  return new BridgeError(
    'INVALID_INPUT',
    `${requested} is outside the folders this bridge may read (${allowedDirs.join(', ')}). Add the folder to PANELWAVE_ALLOWED_DIRS in the MCP client configuration.`,
  );
}

export function resolveAllowed(requested: string, allowedDirs: string[], opts: ResolveOptions = {}): string {
  if (!requested || typeof requested !== 'string') throw new BridgeError('INVALID_INPUT', 'Pass a path.');
  if (requested.includes('\0')) throw new BridgeError('INVALID_INPUT', 'Invalid path.');
  if (!allowedDirs.length) {
    throw new BridgeError('PRECONDITION_FAILED', 'No local folders are allowed. Set PANELWAVE_ALLOWED_DIRS in the MCP client configuration to use the local tools.');
  }
  const absolute = path.resolve(allowedDirs[0], requested);

  // 1. Text-only containment, before touching the filesystem.
  const unc = process.platform === 'win32' && isUncOrDevicePath(absolute);
  const textual = allowedDirs.find((d) => relativeInside(absolute, path.resolve(d)) !== undefined);
  if (!textual || (unc && !isUncOrDevicePath(path.resolve(textual)))) throw outside(requested, allowedDirs);

  // 2. Symlinks and junctions resolved; the real path must still be inside a real allowed directory.
  const resolved = real(absolute);
  for (const d of allowedDirs) {
    const rel = relativeInside(resolved, real(d));
    if (rel === undefined) continue;
    if (opts.allowHidden === false && rel.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
      throw new BridgeError('INVALID_INPUT', `${requested} is a hidden file or inside a hidden folder; the bridge does not read those.`);
    }
    return resolved;
  }
  throw outside(requested, allowedDirs);
}
