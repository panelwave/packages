import type { FetchLike } from '@modelcontextprotocol/client';
import { BridgeError } from '../errors';
import { RemoteProxy } from '../remote';

export interface WhoamiTeam {
  teamId?: string;
  name?: string;
  role?: string;
  plan?: string;
}

export type VerifyResult =
  | { ok: true; text: string; user?: { name?: string; email?: string }; teams: WhoamiTeam[]; worksHint?: string }
  | { ok: false; code: string; message: string };

/**
 * The setup's check call: `pw_meta_whoami` through the hosted server with the
 * new token and the `panelwave-mcp-setup/<version>` User-Agent, which the
 * gateway records as `setup:<tokenId>` so the /connect page can show
 * "Set up on <host>" before the assistant's first real call.
 */
export async function verifyConnection(opts: { url: string; token: string; version: string; fetch?: FetchLike; timeoutMs?: number }): Promise<VerifyResult> {
  const remote = new RemoteProxy({
    url: opts.url,
    token: opts.token,
    version: opts.version,
    userAgent: `panelwave-mcp-setup/${opts.version}`,
    requestTimeoutMs: opts.timeoutMs ?? 20_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  try {
    await remote.connect();
    const result = await remote.callTool('pw_meta_whoami', {});
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join(' ');
    if (result.isError) {
      const data = (result.structuredContent ?? {}) as { code?: string; message?: string };
      return { ok: false, code: data.code ?? 'TOOL_ERROR', message: data.message ?? text };
    }
    const data = (result.structuredContent ?? {}) as { user?: { name?: string; email?: string }; teams?: WhoamiTeam[]; onboarding?: { works?: number } };
    return {
      ok: true,
      text,
      user: data.user,
      teams: Array.isArray(data.teams) ? data.teams : [],
      worksHint: data.onboarding && typeof data.onboarding.works === 'number' ? `${data.onboarding.works} work(s)` : undefined,
    };
  } catch (e) {
    const err = e instanceof BridgeError ? e : new BridgeError('UPSTREAM_UNAVAILABLE', e instanceof Error ? e.message : String(e));
    return { ok: false, code: err.code, message: err.message };
  } finally {
    await remote.close().catch(() => undefined);
  }
}
