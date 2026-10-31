import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A pending device request survives the command being stopped (agents run
 * shell commands with timeouts): the next `setup` resumes it instead of
 * asking for a new code. Lives in ~/.panelwave/pending.json, mode 0600.
 */
export interface PendingState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  apiBase: string;
  routeStyle: 'path' | 'query';
  intervalMs: number;
  expiresAt: string;
  createdAt: string;
}

export function pendingPath(home: string): string {
  return path.join(home, '.panelwave', 'pending.json');
}

export function loadPending(home: string, now = Date.now()): PendingState | undefined {
  const file = pendingPath(home);
  try {
    if (!fs.existsSync(file)) return undefined;
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingState;
    if (!state?.deviceCode || !state.expiresAt || new Date(state.expiresAt).getTime() <= now) {
      clearPending(home);
      return undefined;
    }
    return state;
  } catch {
    clearPending(home);
    return undefined;
  }
}

export function savePending(home: string, state: PendingState): void {
  const file = pendingPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function clearPending(home: string): void {
  try {
    fs.rmSync(pendingPath(home), { force: true });
  } catch {
    /* nothing to clear */
  }
}
