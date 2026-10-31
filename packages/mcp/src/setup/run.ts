import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FetchLike } from '@modelcontextprotocol/client';
import { ConfigError, DEFAULT_URL, validateAllowedDirs, version as packageVersion } from '../config';
import { parseArgs, SETUP_HELP, type RouteStyle, type SetupArgs } from './args';
import { DeviceApi, EXIT, SetupError, type DeviceToken } from './api';
import { CLIENT_IDS, CLIENT_LABELS, currentPlatform, detectClients, findOnPath, hostInfo, isAgentMode, parseClientIds, type ClientId, type Platform } from './detect';
import { hasEntry, readStoredEntry, writeClientConfig, type ServerEntry, type SpawnResult, type WriteResult } from './clients';
import { handOver, writeBriefFiles } from './instructions';
import { scaffoldProject } from './scaffold';
import { clearPending, loadPending, savePending } from './pending';
import { verifyConnection } from './verify';

export const DEFAULT_APP_URL = 'https://app.panelwave.org';

/** Everything the commands touch outside their own logic; tests inject it. */
export interface SetupIO {
  out: (line: string) => void;
  err: (line: string) => void;
  platform: Platform;
  fetch?: FetchLike;
  spawn?: (command: string, args: string[]) => SpawnResult;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  version: string;
}

export function defaultIO(): SetupIO {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    platform: currentPlatform(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    version: packageVersion,
  };
}

export interface Endpoints {
  appUrl: string;
  apiBase: string;
  routeStyle: RouteStyle;
  mcpUrl: string;
}

/** Flags win over environment variables, which win over the production defaults. */
export function endpoints(args: Pick<SetupArgs, 'app' | 'api' | 'url' | 'routeStyle'>, env: NodeJS.ProcessEnv): Endpoints {
  const strip = (s: string) => s.trim().replace(/\/+$/, '');
  const appUrl = strip(args.app ?? env.PANELWAVE_APP_URL ?? DEFAULT_APP_URL);
  const apiBase = strip(args.api ?? env.PANELWAVE_API_URL ?? `${appUrl}/api`);
  const styleRaw = args.routeStyle ?? env.PANELWAVE_API_ROUTE_STYLE ?? 'path';
  const routeStyle: RouteStyle = styleRaw === 'query' ? 'query' : 'path';
  const mcpUrl = (args.url ?? env.PANELWAVE_MCP_URL ?? DEFAULT_URL).trim();
  return { appUrl, apiBase, routeStyle, mcpUrl };
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length === 0;
  } catch {
    return false;
  }
}

/** ";" on Windows or for drive-letter paths (a ":" would split "C:\comics"), ":" otherwise. */
function dirDelimiter(platform: NodeJS.Platform, dirs: string[]): string {
  return platform === 'win32' || dirs.some((d) => /^[A-Za-z]:[\\/]/.test(d)) ? ';' : ':';
}

function fmtDate(value: string | number): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function runCommand(command: 'setup' | 'status' | 'doctor', argv: string[], io: SetupIO = defaultIO()): Promise<number> {
  const args = parseArgs(command, argv);
  if (command === 'setup') return runSetup(args, io);
  if (command === 'status') return runStatus(args, io);
  return runDoctor(args, io);
}

// ---------------------------------------------------------------- setup

export async function runSetup(args: SetupArgs, io: SetupIO): Promise<number> {
  const p = io.platform;
  const agent = isAgentMode(p);
  const result: Record<string, unknown> = { command: 'setup', status: 'pending' };
  // With --json the JSON object is the only thing on stdout; progress goes to stderr.
  const say = (line: string) => (args.json ? io.err(line) : io.out(line));
  const finish = (code: number, extra: Record<string, unknown>): number => {
    if (args.json) io.out(JSON.stringify({ ...result, ...extra, exitCode: code }));
    return code;
  };

  if (args.help) {
    io.out(SETUP_HELP);
    return EXIT.ok;
  }
  if (args.unknown.length) {
    io.err(`Unknown or invalid: ${args.unknown.join(', ')}. Run setup --help.`);
    return finish(EXIT.denied, { status: 'invalid_arguments' });
  }

  const ep = endpoints(args, p.env);
  let allowedDirs: string[] = [];
  if (!args.remote) {
    try {
      allowedDirs = validateAllowedDirs(args.dirs ?? [p.cwd], p.cwd, p.home, p.platform);
    } catch (e) {
      io.err(e instanceof ConfigError ? e.message : String(e));
      io.err('Run the setup inside the folder with your scripts and artwork, or pass --dirs <folder>.');
      return finish(EXIT.denied, { status: 'invalid_dirs' });
    }
  }

  const parsedClients = parseClientIds(args.clients);
  if (parsedClients.unknown.length) {
    io.err(`Unknown client(s): ${parsedClients.unknown.join(', ')}. Known: ${CLIENT_IDS.join(', ')}.`);
    return finish(EXIT.denied, { status: 'invalid_arguments' });
  }
  const detected = detectClients(p);
  const targets: ClientId[] = parsedClients.ids.length ? parsedClients.ids : detected.filter((c) => c.present).map((c) => c.id);
  const deps = { platform: p, spawn: io.spawn };
  result.detectedClients = detected.filter((c) => c.present).map((c) => c.id);
  result.agentMode = agent;

  // Already configured everywhere? Then do not mint another token.
  if (!args.renew && targets.length) {
    const states = targets.map((id) => hasEntry(id, deps));
    if (states.every((s) => s === true)) {
      say(`PanelWave is already configured for ${targets.map((id) => CLIENT_LABELS[id]).join(', ')}.`);
      say('Run setup --renew to replace the token (or to widen permissions with --scopes).');
      if (args.scaffold) reportScaffold(p.cwd, say, result);
      if (args.instructions) reportBrief(p.cwd, allowedDirs, say, result);
      return finish(EXIT.ok, { status: 'already_configured', clients: targets });
    }
  }

  const api = new DeviceApi({ apiBase: ep.apiBase, routeStyle: ep.routeStyle, userAgent: `panelwave-mcp-setup/${io.version}`, fetch: io.fetch });

  // A pending request from a stopped run is resumed instead of asking for a new code.
  let pending = loadPending(p.home, io.now());
  if (pending && pending.apiBase !== ep.apiBase) {
    clearPending(p.home);
    pending = undefined;
  }
  let request: { deviceCode: string; userCode: string; verificationUri: string; intervalMs: number; expiresAtMs: number };
  if (pending) {
    request = { deviceCode: pending.deviceCode, userCode: pending.userCode, verificationUri: pending.verificationUri, intervalMs: pending.intervalMs, expiresAtMs: new Date(pending.expiresAt).getTime() };
    say(`Resuming the pending request ${pending.userCode}.`);
  } else {
    const { host, os } = hostInfo(p);
    const clientName = targets.length ? CLIENT_LABELS[targets[0]] : 'MCP client';
    const body: Record<string, unknown> = { client_name: clientName, host, os, bridge_version: io.version, folder: path.basename(p.cwd) };
    if (args.scopes) body.scopes = args.scopes;
    if (args.link) body.link_code = args.link;
    try {
      const started = await api.start(body);
      const expiresAtMs = io.now() + started.expires_in * 1000;
      request = { deviceCode: started.device_code, userCode: started.user_code, verificationUri: started.verification_uri_complete, intervalMs: Math.max(1, started.interval) * 1000, expiresAtMs };
      savePending(p.home, { deviceCode: request.deviceCode, userCode: request.userCode, verificationUri: request.verificationUri, apiBase: ep.apiBase, routeStyle: ep.routeStyle, intervalMs: request.intervalMs, expiresAt: new Date(expiresAtMs).toISOString(), createdAt: new Date(io.now()).toISOString() });
    } catch (e) {
      const err = e instanceof SetupError ? e : new SetupError('INTERNAL', e instanceof Error ? e.message : String(e));
      io.err(`PanelWave refused the setup request (${err.code}): ${err.message}`);
      return finish(err.exitCode, { status: 'refused', error: err.code, message: err.message });
    }
  }
  result.userCode = request.userCode;
  result.verificationUri = request.verificationUri;

  say('');
  say(`Approve this connection in PanelWave: ${request.verificationUri}`);
  say(`Code ${request.userCode} · valid until ${fmtTime(request.expiresAtMs)}`);
  if (agent) say('AGENT: show the link above to the user and wait for them to approve it; do not open it yourself.');
  if (!args.wait) {
    say('Run `npx -y @panelwave/mcp setup` again after approving to finish the setup.');
    return finish(EXIT.ok, { status: 'pending' });
  }
  say('Waiting for approval…');

  let token: DeviceToken | undefined;
  let intervalMs = request.intervalMs;
  while (!token) {
    if (io.now() >= request.expiresAtMs) {
      clearPending(p.home);
      io.err('The approval window of 10 minutes has closed. Run the setup again.');
      return finish(EXIT.expired, { status: 'expired' });
    }
    await io.sleep(intervalMs);
    let polled;
    try {
      polled = await api.poll(request.deviceCode);
    } catch (e) {
      const err = e instanceof SetupError ? e : new SetupError('INTERNAL', e instanceof Error ? e.message : String(e));
      io.err(`${err.message} (the request stays pending; run the setup again to continue)`);
      return finish(err.exitCode, { status: 'unreachable', error: err.code });
    }
    switch (polled.kind) {
      case 'token':
        token = polled.data;
        break;
      case 'pending':
        break;
      case 'slow_down':
        intervalMs = Math.max(intervalMs, polled.intervalMs);
        break;
      default: {
        clearPending(p.home);
        const code = polled.kind === 'denied' ? EXIT.denied : polled.kind === 'expired' || polled.kind === 'invalid' ? EXIT.expired : EXIT.refused;
        io.err(polled.message);
        return finish(code, { status: polled.kind, message: polled.message });
      }
    }
  }
  clearPending(p.home);
  result.tokenPrefix = token.prefix;
  result.tokenName = token.name;
  result.scopes = token.scopes;
  result.expiresAt = token.expiresAt;
  result.user = token.user;
  say(`✓ Approved: token ${token.prefix}… (${token.name}), expires ${fmtDate(token.expiresAt)}.`);

  const entry: ServerEntry = args.remote
    ? { kind: 'remote', url: ep.mcpUrl, headers: { Authorization: `Bearer ${token.token}` } }
    : {
        kind: 'bridge',
        command: 'npx',
        args: ['-y', '@panelwave/mcp'],
        env: {
          PANELWAVE_TOKEN: token.token,
          PANELWAVE_ALLOWED_DIRS: allowedDirs.join(dirDelimiter(p.platform, allowedDirs)),
          ...(ep.mcpUrl !== DEFAULT_URL ? { PANELWAVE_MCP_URL: ep.mcpUrl } : {}),
        },
      };
  result.allowedDirs = allowedDirs;
  result.mode = entry.kind;

  const writes: WriteResult[] = targets.map((id) => writeClientConfig(id, entry, { renew: args.renew }, deps));
  for (const w of writes) {
    const where = w.path ? ` (${w.path})` : w.message && w.status === 'written' ? ` (${w.message})` : '';
    if (w.status === 'written') say(`✓ ${w.label} configured${where}`);
    else if (w.status === 'exists') say(`· ${w.label} was already configured${where}; run setup --renew to replace it`);
    else say(`! ${w.label} not configured: ${w.message ?? w.status}`);
  }
  result.clients = writes.map((w) => ({ id: w.id, label: w.label, status: w.status, path: w.path, message: w.message }));
  const stored = writes.filter((w) => w.status === 'written' || w.status === 'exists');
  if (!stored.length) {
    const discarded = await api.discard(request.deviceCode);
    if (!targets.length) io.err('No MCP client was detected on this computer.');
    io.err(`The token was not stored anywhere and has ${discarded ? 'been revoked' : 'to be revoked under Profile → Connected apps & access tokens'}.`);
    io.err(`Run setup --client <id> for one of: ${CLIENT_IDS.join(', ')}; or create a token in PanelWave under Profile → Connected apps & access tokens and add it to your client by hand.`);
    return finish(EXIT.notStored, { status: 'not_stored', tokenRevoked: discarded });
  }

  if (args.instructions) reportBrief(p.cwd, allowedDirs, say, result);
  if (args.scaffold) reportScaffold(p.cwd, say, result);

  const verified = await verifyConnection({ url: ep.mcpUrl, token: token.token, version: io.version, fetch: io.fetch });
  if (verified.ok) {
    say(`✓ Connected: ${verified.text}`);
    result.verified = true;
    result.whoami = { user: verified.user, teams: verified.teams };
  } else if (verified.code === 'FEATURE_DISABLED') {
    io.err(`PanelWave: ${verified.message}`);
    result.verified = false;
    return finish(EXIT.refused, { status: 'disabled', message: verified.message });
  } else {
    say(`! The check call did not succeed (${verified.code}: ${verified.message}). The configuration is written; check later with npx -y @panelwave/mcp status.`);
    result.verified = false;
  }

  say('');
  say(handOver(stored.map((w) => `${w.label}: ${w.restartHint}`)));
  if (!args.scaffold && isEmptyDir(p.cwd)) {
    say('This folder is empty. If the user wants the project skeleton (concept.md, script.fountain, panels/, references/, panelwave-build.md), run `npx -y @panelwave/mcp setup --scaffold` — only if they say yes.');
  }
  return finish(EXIT.ok, { status: 'configured' });
}

function reportBrief(cwd: string, allowedDirs: string[], say: (l: string) => void, result: Record<string, unknown>): void {
  try {
    const briefs = writeBriefFiles(cwd, allowedDirs);
    for (const b of briefs) say(`✓ Agent brief ${b.action} in ${path.basename(b.file)}`);
    result.instructionsFiles = briefs.map((b) => b.file);
  } catch (e) {
    say(`! Could not write the agent brief: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function reportScaffold(cwd: string, say: (l: string) => void, result: Record<string, unknown>): void {
  try {
    const s = scaffoldProject(cwd);
    if (s.created.length) say(`✓ Project skeleton: created ${s.created.join(', ')}`);
    if (s.skipped.length) say(`· Project skeleton: kept ${s.skipped.join(', ')}`);
    result.scaffold = s;
  } catch (e) {
    say(`! Could not create the project skeleton: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- status

interface ConfiguredClient {
  id: ClientId;
  label: string;
  present: boolean;
  configured: boolean | undefined;
  path?: string;
  tokenPrefix?: string;
  allowedDirs?: string[];
  url?: string;
}

function inspectClients(io: SetupIO): ConfiguredClient[] {
  const deps = { platform: io.platform, spawn: io.spawn };
  return detectClients(io.platform).map((c) => {
    const configured = c.present ? hasEntry(c.id, deps) : false;
    const stored = configured ? readStoredEntry(c.id, deps) : undefined;
    return {
      id: c.id,
      label: c.label,
      present: c.present,
      configured,
      path: c.configPath,
      tokenPrefix: stored?.token ? `${stored.token.slice(0, 12)}…` : undefined,
      allowedDirs: stored?.allowedDirs,
      url: stored?.url,
    };
  });
}

async function gatewayHealth(mcpUrl: string, doFetch: FetchLike | undefined): Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }> {
  try {
    const url = new URL(mcpUrl);
    url.pathname = '/health';
    url.search = '';
    const res = await (doFetch ?? fetch)(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}`, data };
    const kill = data.killSwitch === true || data.disabled === true;
    return { ok: !kill, message: kill ? 'the operator paused the MCP gateway (kill switch)' : `reachable${data.version ? `, version ${String(data.version)}` : ''}`, data };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function runStatus(args: SetupArgs, io: SetupIO): Promise<number> {
  if (args.help) {
    io.out('panelwave-mcp status [--json] [--url <mcp url>] — what is configured on this computer and whether the token still works.');
    return EXIT.ok;
  }
  const ep = endpoints(args, io.platform.env);
  const clients = inspectClients(io);
  const withToken = clients.find((c) => c.configured && c.tokenPrefix);
  const stored = withToken ? readStoredEntry(withToken.id, { platform: io.platform, spawn: io.spawn }) : undefined;
  const health = await gatewayHealth(stored?.url ?? ep.mcpUrl, io.fetch);
  const check = stored?.token ? await verifyConnection({ url: stored.url ?? ep.mcpUrl, token: stored.token, version: io.version, fetch: io.fetch }) : undefined;

  const data = {
    command: 'status',
    clients: clients.map(({ id, label, present, configured, path: file, tokenPrefix, allowedDirs, url }) => ({ id, label, present, configured, path: file, tokenPrefix, allowedDirs, url })),
    server: { url: stored?.url ?? ep.mcpUrl, ...health },
    token: check ? (check.ok ? { ok: true, whoami: check.text } : { ok: false, code: check.code, message: check.message }) : { ok: false, code: 'NOT_CONFIGURED', message: 'no token found in a client configuration' },
  };
  if (args.json) {
    io.out(JSON.stringify(data));
  } else {
    io.out(`PanelWave MCP status (bridge ${io.version})`);
    for (const c of clients) {
      const mark = c.configured ? '✓' : c.present ? '·' : ' ';
      const detail = c.configured ? `configured${c.tokenPrefix ? ` (${c.tokenPrefix})` : ''}${c.allowedDirs?.length ? `, folders: ${c.allowedDirs.join(', ')}` : ''}` : c.present ? 'installed, not configured' : 'not found';
      io.out(`  ${mark} ${c.label.padEnd(15)} ${detail}`);
    }
    io.out(`  ${health.ok ? '✓' : '✗'} Server          ${data.server.url}: ${health.message}`);
    io.out(`  ${data.token.ok ? '✓' : '✗'} Token           ${data.token.ok ? (data.token as { whoami: string }).whoami : `${(data.token as { code: string }).code}: ${(data.token as { message: string }).message}`}`);
    if (!data.token.ok) io.out('  → run `npx -y @panelwave/mcp setup` to connect (or `setup --renew` to replace the token).');
  }
  return data.token.ok && health.ok ? EXIT.ok : EXIT.denied;
}

// ---------------------------------------------------------------- doctor

export async function runDoctor(args: SetupArgs, io: SetupIO): Promise<number> {
  if (args.help) {
    io.out('panelwave-mcp doctor [--json] [--url <mcp url>] — checks Node, npx, clients, token, folders and the server, with a fix for each failure.');
    return EXIT.ok;
  }
  const p = io.platform;
  const ep = endpoints(args, p.env);
  const checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js', ok: major >= 20, detail: `v${process.versions.node}`, fix: major >= 20 ? undefined : 'install Node.js 20 or newer from https://nodejs.org' });

  const npx = findOnPath('npx', p);
  checks.push({ name: 'npx', ok: !!npx, detail: npx ?? 'not on PATH', fix: npx ? undefined : 'Node.js installs npx; reopen the terminal after installing' });

  const clients = inspectClients(io);
  const present = clients.filter((c) => c.present);
  checks.push({ name: 'MCP clients', ok: present.length > 0, detail: present.length ? present.map((c) => c.label).join(', ') : 'none detected', fix: present.length ? undefined : `install one of ${CLIENT_IDS.join(', ')}, or run setup --client <id>` });

  const configured = clients.filter((c) => c.configured);
  checks.push({ name: 'PanelWave entry', ok: configured.length > 0, detail: configured.length ? configured.map((c) => c.label).join(', ') : 'no client has a panelwave entry', fix: configured.length ? undefined : 'run `npx -y @panelwave/mcp setup`' });

  const stored = configured.map((c) => readStoredEntry(c.id, { platform: p, spawn: io.spawn })).find((s) => s?.token);
  if (stored?.allowedDirs?.length) {
    const missing = stored.allowedDirs.filter((d) => !p.exists(d));
    let rule = '';
    try {
      validateAllowedDirs(stored.allowedDirs, p.cwd, p.home, p.platform);
    } catch (e) {
      rule = e instanceof Error ? e.message : String(e);
    }
    checks.push({ name: 'Folders', ok: !missing.length && !rule, detail: rule || (missing.length ? `missing: ${missing.join(', ')}` : stored.allowedDirs.join(', ')), fix: rule || missing.length ? 'run setup --renew --dirs <folder with your scripts and artwork>' : undefined });
  }

  const health = await gatewayHealth(stored?.url ?? ep.mcpUrl, io.fetch);
  checks.push({ name: 'Server', ok: health.ok, detail: `${stored?.url ?? ep.mcpUrl}: ${health.message}`, fix: health.ok ? undefined : 'check your network, or wait until PanelWave is back (status.panelwave.org)' });

  if (stored?.token) {
    const check = await verifyConnection({ url: stored.url ?? ep.mcpUrl, token: stored.token, version: io.version, fetch: io.fetch });
    checks.push({
      name: 'Token',
      ok: check.ok,
      detail: check.ok ? check.text : `${check.code}: ${check.message}`,
      fix: check.ok ? undefined : check.code === 'UNAUTHENTICATED' ? 'the token expired or was revoked: run `npx -y @panelwave/mcp setup --renew`' : check.code === 'FEATURE_DISABLED' ? 'the operator paused the gateway; try again later' : 'try again in a minute; if it persists run setup --renew',
    });
  }

  if (args.json) {
    io.out(JSON.stringify({ command: 'doctor', ok: checks.every((c) => c.ok), checks }));
  } else {
    io.out(`PanelWave MCP doctor (bridge ${io.version})`);
    for (const c of checks) {
      io.out(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(16)} ${c.detail}`);
      if (!c.ok && c.fix) io.out(`    → ${c.fix}`);
    }
  }
  return checks.every((c) => c.ok) ? EXIT.ok : EXIT.denied;
}
