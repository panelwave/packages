/** Error codes of the local tools — the same vocabulary the hosted gateway uses. */
export type BridgeErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'PRECONDITION_FAILED' | 'UPSTREAM_UNAVAILABLE' | 'CANCELLED' | 'INTERNAL';

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

export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOENT') return new BridgeError('NOT_FOUND', 'No such file or folder.');
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new BridgeError('PRECONDITION_FAILED', 'The file cannot be read (permission denied).');
  return new BridgeError('INTERNAL', e instanceof Error ? e.message : String(e));
}
