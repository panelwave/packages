import type { FetchLike } from '@modelcontextprotocol/client';
import type { RouteStyle } from './args';

/** What POST /oauth/device returns (RFC 8628 §3.2 shape). */
export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** What POST /oauth/device/token returns once after approval. */
export interface DeviceToken {
  token: string;
  tokenId: string;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  user?: { id?: string; name?: string; email?: string };
}

export type PollResult =
  | { kind: 'token'; data: DeviceToken }
  | { kind: 'pending' }
  | { kind: 'slow_down'; intervalMs: number }
  | { kind: 'denied'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; status: number; error: string; message: string };

/** Exit codes of `setup` (documented in the concept §6.1). */
export const EXIT = { ok: 0, denied: 1, expired: 2, refused: 3, notStored: 4 } as const;

export class SetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = EXIT.refused,
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface DeviceApiOptions {
  /** CMS API base, e.g. https://app.panelwave.org/api or http://host/index.cfm */
  apiBase: string;
  routeStyle: RouteStyle;
  userAgent: string;
  fetch?: FetchLike;
}

/** The three device routes of the CMS API, with the error vocabulary mapped for the command. */
export class DeviceApi {
  constructor(private readonly opts: DeviceApiOptions) {}

  url(route: string): string {
    const base = this.opts.apiBase.replace(/\/+$/, '');
    return this.opts.routeStyle === 'query' ? `${base}?endpoint=${encodeURIComponent(route)}` : `${base}${route}`;
  }

  private async post(route: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.url(route), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': this.opts.userAgent },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SetupError('UPSTREAM_UNAVAILABLE', `PanelWave is not reachable at ${this.url(route)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let json: Record<string, unknown> = {};
    const text = await res.text();
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { error: 'server_error', error_description: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  async start(body: Record<string, unknown>): Promise<DeviceStart> {
    const { status, json } = await this.post('/oauth/device', body);
    if (status === 200 && typeof json.device_code === 'string' && typeof json.user_code === 'string') {
      return json as unknown as DeviceStart;
    }
    const description = String(json.error_description ?? json.error ?? `HTTP ${status}`);
    if (status === 503) throw new SetupError('FEATURE_DISABLED', description, EXIT.refused);
    if (status === 429) throw new SetupError('RATE_LIMITED', description, EXIT.refused);
    throw new SetupError(String(json.error ?? 'invalid_request'), description, EXIT.denied);
  }

  async poll(deviceCode: string): Promise<PollResult> {
    const { status, json } = await this.post('/oauth/device/token', { device_code: deviceCode });
    if (status === 200 && typeof json.token === 'string') return { kind: 'token', data: json as unknown as DeviceToken };
    const error = String(json.error ?? '');
    const message = String(json.error_description ?? error ?? `HTTP ${status}`);
    switch (error) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down': {
        const m = /(\d+)\s*seconds?/.exec(message);
        return { kind: 'slow_down', intervalMs: (m ? Number(m[1]) : 10) * 1000 };
      }
      case 'access_denied':
        return { kind: 'denied', message };
      case 'expired_token':
        return { kind: 'expired', message };
      case 'invalid_grant':
        return { kind: 'invalid', message };
      case 'temporarily_unavailable':
        return { kind: 'unavailable', message };
      default:
        return { kind: 'error', status, error: error || 'server_error', message };
    }
  }

  async discard(deviceCode: string): Promise<boolean> {
    try {
      const { status } = await this.post('/oauth/device/discard', { device_code: deviceCode });
      return status === 200;
    } catch {
      return false;
    }
  }
}
