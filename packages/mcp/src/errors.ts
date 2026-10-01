/**
 * Error codes of the local tools — the same vocabulary the hosted gateway
 * uses, so a remote tool error re-raised by a local tool keeps its code.
 */
export const BRIDGE_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'QUOTA_EXCEEDED',
  'CONFLICT',
  'RATE_LIMITED',
  'CONFIRMATION_REQUIRED',
  'CANCELLED',
  'PRECONDITION_FAILED',
  'UPSTREAM_UNAVAILABLE',
  'FEATURE_DISABLED',
  'INTERNAL',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function isBridgeErrorCode(code: unknown): code is BridgeErrorCode {
  return typeof code === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(code);
}

export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err?.name === 'AbortError') return new BridgeError('CANCELLED', 'The call was cancelled.');
  if (err?.code === 'ENOENT') return new BridgeError('NOT_FOUND', 'No such file or folder.');
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new BridgeError('PRECONDITION_FAILED', 'The file cannot be read (permission denied).');
  return new BridgeError('INTERNAL', e instanceof Error ? e.message : String(e));
}
