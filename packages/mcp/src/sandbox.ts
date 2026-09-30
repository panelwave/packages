import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeError } from './errors';

/**
 * Path sandbox of the local tools: every path must resolve — symlinks
 * followed — inside one of the allowed directories (PANELWAVE_ALLOWED_DIRS).
 * Relative paths are taken relative to the first allowed directory.
 */
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

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

function inside(child: string, parent: string): boolean {
  const c = caseInsensitive ? child.toLowerCase() : child;
  const p = caseInsensitive ? parent.toLowerCase() : parent;
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveAllowed(requested: string, allowedDirs: string[]): string {
  if (!requested || typeof requested !== 'string') throw new BridgeError('INVALID_INPUT', 'Pass a path.');
  if (requested.includes('\0')) throw new BridgeError('INVALID_INPUT', 'Invalid path.');
  const absolute = path.resolve(allowedDirs[0], requested);
  const resolved = real(absolute);
  if (allowedDirs.some((d) => inside(resolved, real(d)))) return resolved;
  throw new BridgeError('INVALID_INPUT', `${requested} is outside the folders this bridge may read (${allowedDirs.join(', ')}). Add the folder to PANELWAVE_ALLOWED_DIRS in the MCP client configuration.`);
}
