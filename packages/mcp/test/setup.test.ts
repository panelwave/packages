import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FetchLike } from '@modelcontextprotocol/client';
import { parseArgs } from '../src/setup/args';
import { codexBlock, upsertCodexBlock } from '../src/setup/clients';
import { BRIEF_END, BRIEF_START, upsertBrief } from '../src/setup/instructions';
import { loadPending, pendingPath } from '../src/setup/pending';
import { endpoints, runCommand, type SetupIO } from '../src/setup/run';
import type { Platform } from '../src/setup/detect';
import { httpRemote } from './helpers/remote';

const TOKEN = 'pw_pat_' + 'S'.repeat(43);

/** A stand-in for the CMS API's device routes plus the hosted gateway, behind one fetch. */
function fakeServer(opts: { approveAfterPolls?: number; deny?: boolean; expire?: boolean; slowDownOnce?: boolean; disabled?: boolean } = {}) {
  const gateway = httpRemote();
  const state = { requests: 0, polls: 0, discards: 0, lastStartBody: {} as Record<string, unknown>, tokenCounter: 0, slowed: false };
  const approveAfter = opts.approveAfterPolls ?? 1;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.pathname.endsWith('/mcp')) return gateway.fetch(url, init);
    if (u.pathname.endsWith('/health')) return json(200, { ok: true, version: '9.9.9', killSwitch: false });
    if (u.pathname === '/api/oauth/device') {
      if (opts.disabled) return json(503, { error: 'temporarily_unavailable', error_description: 'paused' });
      state.requests++;
      state.lastStartBody = body;
      return json(200, { device_code: `pwd_dev${state.requests}`, user_code: 'ABCD-EFGH', verification_uri: 'https://app.test/connect/approve', verification_uri_complete: 'https://app.test/connect/approve?code=ABCD-EFGH', expires_in: 600, interval: 5 });
    }
    if (u.pathname === '/api/oauth/device/token') {
      state.polls++;
      if (!String(body.device_code ?? '').startsWith('pwd_dev')) return json(400, { error: 'invalid_grant', error_description: 'Unknown device code.' });
      if (opts.deny) return json(400, { error: 'access_denied', error_description: 'The request was denied in PanelWave.' });
      if (opts.expire) return json(400, { error: 'expired_token', error_description: 'The approval window has closed.' });
      if (opts.slowDownOnce && !state.slowed) {
        state.slowed = true;
        return json(400, { error: 'slow_down', error_description: 'Polling too fast. Wait 10 seconds between polls.' });
      }
      if (state.polls <= approveAfter) return json(400, { error: 'authorization_pending', error_description: 'Waiting for approval in PanelWave.' });
      state.tokenCounter++;
      const token = state.tokenCounter === 1 ? TOKEN : `pw_pat_${'R'.repeat(42)}${state.tokenCounter}`;
      return json(200, { token, tokenId: `tok-${state.tokenCounter}`, prefix: token.slice(0, 12), name: 'Cursor · TB', scopes: ['works:read'], expiresAt: '2027-10-31T00:00:00Z', user: { name: 'TB', email: 'tb@example.test' } });
    }
    if (u.pathname === '/api/oauth/device/discard') {
      state.discards++;
      return json(200, { revoked: true });
    }
    return json(404, { error: 'not_found' });
  };
  return { fetch, state, close: () => gateway.close() };
}

interface World {
  root: string;
  home: string;
  cwd: string;
  bin: string;
  platform: Platform;
  out: string[];
  err: string[];
  spawnCalls: string[][];
  io: SetupIO;
  close: () => Promise<void>;
}

function world(server: ReturnType<typeof fakeServer>, extra: { claudeOnPath?: boolean; env?: NodeJS.ProcessEnv; isTTY?: boolean } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-setup-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'home', 'comics', 'rooftop');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (extra.claudeOnPath) fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  const platform: Platform = {
    platform: 'linux',
    home,
    cwd,
    env: { PATH: bin, ...extra.env },
    isTTY: extra.isTTY ?? false,
    exists: (p) => fs.existsSync(p),
  };
  const out: string[] = [];
  const err: string[] = [];
  const spawnCalls: string[][] = [];
  const claudeHas = { configured: false };
  const io: SetupIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    platform,
    fetch: server.fetch,
    spawn: (cmd, args) => {
      spawnCalls.push([cmd, ...args]);
      if (args[0] === 'mcp' && args[1] === 'get') return { status: claudeHas.configured ? 0 : 1, stdout: '', stderr: claudeHas.configured ? '' : 'No MCP server found with name: panelwave' };
      if (args[0] === 'mcp' && args[1] === 'add') claudeHas.configured = true;
      if (args[0] === 'mcp' && args[1] === 'remove') claudeHas.configured = false;
      return { status: 0, stdout: '', stderr: '' };
    },
    sleep: async () => undefined,
    now: () => Date.now(),
    version: '0.3.0-test',
  };
  return { root, home, cwd, bin, platform, out, err, spawnCalls, io, close: async () => fs.rmSync(root, { recursive: true, force: true }) };
}

const read = (file: string) => fs.readFileSync(file, 'utf8');
const readJson = (file: string) => JSON.parse(read(file)) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

describe('setup: argument parsing', () => {
  it('reads flags, lists and negations', () => {
    const a = parseArgs('setup', ['--link', 'J3K9QZ', '--client', 'cursor,vscode', '--dirs', '/a:/b', '--expires=30', '--scopes', 'works:read publish', '--no-wait', '--renew', '--json', '--route-style', 'query']);
    expect(a).toMatchObject({ link: 'j3k9qz', clients: ['cursor', 'vscode'], dirs: ['/a', '/b'], expires: 30, scopes: ['works:read', 'publish'], wait: false, renew: true, json: true, routeStyle: 'query', unknown: [] });
    expect(parseArgs('setup', ['--dirs', 'C:\\comics;D:\\art']).dirs).toEqual(['C:\\comics', 'D:\\art']);
    expect(parseArgs('setup', ['--expires', '400']).unknown[0]).toContain('--expires');
    expect(parseArgs('setup', ['--bogus']).unknown).toEqual(['--bogus']);
  });

  it('resolves endpoints from flags, then environment, then defaults', () => {
    expect(endpoints({}, {})).toEqual({ appUrl: 'https://app.panelwave.org', apiBase: 'https://app.panelwave.org/api', routeStyle: 'path', mcpUrl: 'https://mcp.panelwave.org/mcp' });
    expect(endpoints({ app: 'http://localhost:4200/' }, {}).apiBase).toBe('http://localhost:4200/api');
    expect(endpoints({ api: 'http://host/index.cfm', routeStyle: 'query' }, { PANELWAVE_APP_URL: 'http://x' })).toMatchObject({ appUrl: 'http://x', apiBase: 'http://host/index.cfm', routeStyle: 'query' });
    expect(endpoints({}, { PANELWAVE_API_ROUTE_STYLE: 'query', PANELWAVE_MCP_URL: 'http://localhost:3005/mcp' })).toMatchObject({ routeStyle: 'query', mcpUrl: 'http://localhost:3005/mcp' });
  });
});

describe('setup: the whole flow against a fake PanelWave', () => {
  let server: ReturnType<typeof fakeServer>;
  let w: World;
  afterEach(async () => {
    await w.close();
    await server.close();
  });

  it('approves, writes every configured client, the brief, verifies, and never prints the token', async () => {
    server = fakeServer({ approveAfterPolls: 2 });
    w = world(server, { claudeOnPath: true, env: { CLAUDECODE: '1' } });
    // a pre-existing Cursor config with 4-space indentation and another server
    const cursorFile = path.join(w.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.writeFileSync(cursorFile, '{\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}\n');
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "y"\n');
    fs.mkdirSync(path.join(w.home, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.config', 'Claude'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.config', 'Code', 'User'), { recursive: true });
    fs.writeFileSync(path.join(w.cwd, 'CLAUDE.md'), '# Project\n');

    const code = await runCommand('setup', ['--link', 'j3k9qz', '--json'], w.io);
    expect(code).toBe(0);
    const result = JSON.parse(w.out[w.out.length - 1]) as Record<string, unknown>;
    expect(result.status).toBe('configured');
    expect(result.tokenPrefix).toBe(TOKEN.slice(0, 12));
    expect(result.verified).toBe(true);
    expect(server.state.lastStartBody).toMatchObject({ client_name: 'Claude Code', link_code: 'j3k9qz', bridge_version: '0.3.0-test', folder: 'rooftop' });
    expect(server.state.polls).toBe(3);

    const everything = [...w.out, ...w.err].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain('https://app.test/connect/approve?code=ABCD-EFGH');
    expect(everything).toContain('AGENT: show the link above');

    // Cursor: entry added, indentation and the other server kept, backup written
    const cursor = readJson(cursorFile);
    expect(cursor.mcpServers.panelwave).toEqual({ command: 'npx', args: ['-y', '@panelwave/mcp'], env: { PANELWAVE_TOKEN: TOKEN, PANELWAVE_ALLOWED_DIRS: w.cwd } });
    expect(cursor.mcpServers.other).toEqual({ command: 'x' });
    expect(read(cursorFile)).toContain('\n    "mcpServers"');
    expect(fs.existsSync(`${cursorFile}.panelwave.bak`)).toBe(true);
    // VS Code uses `servers` with a type; Gemini and Claude Desktop use mcpServers
    expect(readJson(path.join(w.home, '.config', 'Code', 'User', 'mcp.json')).servers.panelwave.type).toBe('stdio');
    expect(readJson(path.join(w.home, '.gemini', 'settings.json')).mcpServers.panelwave.env.PANELWAVE_TOKEN).toBe(TOKEN);
    expect(readJson(path.join(w.home, '.config', 'Claude', 'claude_desktop_config.json')).mcpServers.panelwave.command).toBe('npx');
    // Codex: table appended, the rest untouched
    const toml = read(path.join(w.home, '.codex', 'config.toml'));
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain(`[mcp_servers.panelwave]\ncommand = "npx"\nargs = ["-y", "@panelwave/mcp"]\nenv = { PANELWAVE_TOKEN = "${TOKEN}"`);
    // Claude Code through its CLI, user scope, token in --env
    const add = w.spawnCalls.find((c) => c[1] === 'mcp' && c[2] === 'add');
    expect(add).toEqual([path.join(w.bin, 'claude'), 'mcp', 'add', '--scope', 'user', '--env', `PANELWAVE_TOKEN=${TOKEN}`, '--env', `PANELWAVE_ALLOWED_DIRS=${w.cwd}`, 'panelwave', '--', 'npx', '-y', '@panelwave/mcp']);

    // the brief: AGENTS.md created, CLAUDE.md (existing) appended, folders named
    const agents = read(path.join(w.cwd, 'AGENTS.md'));
    expect(agents.startsWith(BRIEF_START)).toBe(true);
    expect(agents).toContain(`Local file tools only read inside: ${w.cwd}.`);
    expect(agents).not.toContain(TOKEN);
    expect(read(path.join(w.cwd, 'CLAUDE.md'))).toContain('# Project\n\n' + BRIEF_START);
    // no pending state left behind
    expect(fs.existsSync(pendingPath(w.home))).toBe(false);
  });

  it('does not mint a second token when every target is configured, unless --renew', async () => {
    server = fakeServer();
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor', '--no-instructions'], w.io)).toBe(0);
    expect(server.state.requests).toBe(1);
    const first = readJson(path.join(w.home, '.cursor', 'mcp.json')).mcpServers.panelwave.env.PANELWAVE_TOKEN;

    expect(await runCommand('setup', ['--client', 'cursor', '--no-instructions'], w.io)).toBe(0);
    expect(server.state.requests).toBe(1);
    expect(w.out.join('\n')).toContain('already configured');

    expect(await runCommand('setup', ['--client', 'cursor', '--no-instructions', '--renew'], w.io)).toBe(0);
    expect(server.state.requests).toBe(2);
    const second = String(readJson(path.join(w.home, '.cursor', 'mcp.json')).mcpServers.panelwave.env.PANELWAVE_TOKEN);
    expect(second).not.toBe(first);
    expect(second.startsWith('pw_pat_')).toBe(true);
    expect([...w.out, ...w.err].join('\n')).not.toContain(second);
  });

  it('maps denial, expiry and a paused server to their exit codes and keeps nothing pending', async () => {
    server = fakeServer({ deny: true });
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor'], w.io)).toBe(1);
    expect(w.err.join('\n')).toContain('denied');
    expect(fs.existsSync(pendingPath(w.home))).toBe(false);
    await w.close();
    await server.close();

    server = fakeServer({ expire: true });
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor'], w.io)).toBe(2);
    await w.close();
    await server.close();

    server = fakeServer({ disabled: true });
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor'], w.io)).toBe(3);
    expect(w.err.join('\n')).toContain('paused');
  });

  it('honours slow_down and --no-wait with a resumable pending request', async () => {
    server = fakeServer({ approveAfterPolls: 1, slowDownOnce: true });
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor', '--no-wait', '--no-instructions'], w.io)).toBe(0);
    expect(server.state.polls).toBe(0);
    const pending = loadPending(w.home);
    expect(pending?.deviceCode).toBe('pwd_dev1');
    expect(w.out.join('\n')).toContain('Run `npx -y @panelwave/mcp setup` again');

    const sleeps: number[] = [];
    w.io.sleep = async (ms) => {
      sleeps.push(ms);
    };
    expect(await runCommand('setup', ['--client', 'cursor', '--no-instructions'], w.io)).toBe(0);
    expect(server.state.requests).toBe(1); // resumed, no new code
    expect(w.out.join('\n')).toContain('Resuming the pending request ABCD-EFGH');
    expect(sleeps).toEqual([5000, 10000]); // slow_down raised the interval before the approving poll
    expect(fs.existsSync(pendingPath(w.home))).toBe(false);
  });

  it('revokes the token when no client could store it', async () => {
    server = fakeServer();
    w = world(server); // nothing installed, no --client
    expect(await runCommand('setup', [], w.io)).toBe(4);
    expect(server.state.discards).toBe(1);
    expect(w.err.join('\n')).toContain('No MCP client was detected');
    expect([...w.out, ...w.err].join('\n')).not.toContain(TOKEN);
  });

  it('refuses a drive root or the home folder, and unknown client ids, before talking to PanelWave', async () => {
    server = fakeServer();
    w = world(server);
    expect(await runCommand('setup', ['--dirs', '/'], w.io)).toBe(1);
    expect(await runCommand('setup', ['--dirs', w.home], w.io)).toBe(1);
    expect(await runCommand('setup', ['--client', 'nope'], w.io)).toBe(1);
    expect(server.state.requests).toBe(0);
    expect(w.err.join('\n')).toContain('Unknown client(s): nope');
  });

  it('--scaffold creates the skeleton once and --remote writes a header entry', async () => {
    server = fakeServer();
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    expect(await runCommand('setup', ['--client', 'cursor', '--scaffold', '--remote', '--url', 'https://mcp.test/mcp'], w.io)).toBe(0);
    for (const f of ['concept.md', 'script.fountain', 'panelwave-build.md', 'panels', 'references', '.gitignore', 'AGENTS.md']) {
      expect(fs.existsSync(path.join(w.cwd, f))).toBe(true);
    }
    expect(read(path.join(w.cwd, 'script.fountain'))).toContain('(P001)');
    const entry = readJson(path.join(w.home, '.cursor', 'mcp.json')).mcpServers.panelwave;
    expect(entry).toEqual({ url: 'https://mcp.test/mcp', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(read(path.join(w.cwd, 'AGENTS.md'))).toContain('Local file tools only read inside: none');

    fs.writeFileSync(path.join(w.cwd, 'concept.md'), 'mine');
    expect(await runCommand('setup', ['--client', 'cursor', '--scaffold'], w.io)).toBe(0); // already configured path
    expect(read(path.join(w.cwd, 'concept.md'))).toBe('mine');
    expect(w.out.join('\n')).toMatch(/kept .*concept\.md/);
  });

  it('status and doctor read the stored entry and check the token against the server', async () => {
    server = fakeServer();
    w = world(server);
    fs.mkdirSync(path.join(w.home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(w.bin, 'npx'), '');
    expect(await runCommand('setup', ['--client', 'cursor', '--no-instructions'], w.io)).toBe(0);

    w.out.length = 0;
    expect(await runCommand('status', ['--json'], w.io)).toBe(0);
    const status = JSON.parse(w.out[0]) as { clients: Array<{ id: string; configured: boolean; tokenPrefix?: string; allowedDirs?: string[] }>; token: { ok: boolean }; server: { ok: boolean } };
    const cursor = status.clients.find((c) => c.id === 'cursor');
    expect(cursor).toMatchObject({ configured: true, tokenPrefix: `${TOKEN.slice(0, 12)}…`, allowedDirs: [w.cwd] });
    expect(status.token.ok).toBe(true);
    expect(status.server.ok).toBe(true);
    expect(w.out.join('\n')).not.toContain(TOKEN);

    w.out.length = 0;
    expect(await runCommand('doctor', [], w.io)).toBe(0);
    const text = w.out.join('\n');
    expect(text).toContain('✓ Node.js');
    expect(text).toContain('✓ Token');
    expect(text).not.toContain(TOKEN);
  });
});

describe('setup: file helpers', () => {
  it('replaces an existing Codex table and keeps the others', () => {
    const block = codexBlock({ kind: 'bridge', command: 'npx', args: ['-y', '@panelwave/mcp'], env: { PANELWAVE_TOKEN: 'pw_pat_x', PANELWAVE_ALLOWED_DIRS: 'C:\\comics' } });
    expect(block).toContain('PANELWAVE_ALLOWED_DIRS = "C:\\\\comics"');
    const text = 'a = 1\n\n[mcp_servers.panelwave]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "y"\n';
    const { text: next, existed } = upsertCodexBlock(text, block);
    expect(existed).toBe(true);
    expect(next).not.toContain('"old"');
    expect(next).toContain('[mcp_servers.other]\ncommand = "y"');
    expect(next.indexOf('[mcp_servers.panelwave]')).toBeLessThan(next.indexOf('[mcp_servers.other]'));
  });

  it('upserts the brief between its markers without duplicating it', () => {
    const once = upsertBrief('# Notes\n', 'BRIEF v1');
    expect(once.replaced).toBe(false);
    const twice = upsertBrief(once.text + '\nmore\n', 'BRIEF v2');
    expect(twice.replaced).toBe(true);
    expect(twice.text.split(BRIEF_START).length).toBe(2);
    expect(twice.text).toContain('BRIEF v2');
    expect(twice.text).not.toContain('BRIEF v1');
    expect(twice.text.endsWith(`${BRIEF_END}\n\nmore\n`)).toBe(true);
  });
});
