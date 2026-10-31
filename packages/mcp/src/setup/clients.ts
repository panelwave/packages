import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLIENT_LABELS, RESTART_HINTS, configPathFor, findOnPath, splitPathList, type ClientId, type Platform } from './detect';

/** The bridge as a stdio server entry. */
export interface BridgeEntry {
  kind: 'bridge';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The hosted server with a bearer header (no local file tools). */
export interface RemoteEntry {
  kind: 'remote';
  url: string;
  headers: Record<string, string>;
}

export type ServerEntry = BridgeEntry | RemoteEntry;

export interface WriteResult {
  id: ClientId;
  label: string;
  status: 'written' | 'exists' | 'failed' | 'unsupported';
  path?: string;
  message?: string;
  restartHint: string;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface WriteDeps {
  platform: Platform;
  /** Runs the Claude Code CLI; tests inject a fake. */
  spawn?: (command: string, args: string[]) => SpawnResult;
}

export const SERVER_KEY = 'panelwave';

function defaultSpawn(command: string, args: string[]): SpawnResult {
  const win = process.platform === 'win32';
  // .cmd shims need a shell on Windows; quote every argument so folders with spaces survive.
  const r = win
    ? spawnSync(`"${command}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync(command, args, { encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

// ---------------------------------------------------------------- JSON files

interface JsonFile {
  data: Record<string, unknown>;
  indent: string;
  newline: string;
  existed: boolean;
}

export function readJsonFile(file: string): JsonFile {
  if (!fs.existsSync(file)) return { data: {}, indent: '  ', newline: '\n', existed: false };
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trim();
  const data = trimmed ? (JSON.parse(trimmed) as unknown) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('top level is not an object');
  const indentMatch = /\n([ \t]+)"/.exec(text);
  return { data: data as Record<string, unknown>, indent: indentMatch ? indentMatch[1] : '  ', newline: text.includes('\r\n') ? '\r\n' : '\n', existed: true };
}

/** Atomic write (temp + rename) with a one-time `.panelwave.bak` of the original. */
export function writeFileSafely(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.panelwave.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonFile(file: string, json: JsonFile): void {
  const text = JSON.stringify(json.data, null, json.indent).replace(/\n/g, json.newline) + json.newline;
  writeFileSafely(file, text);
}

function section(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = data[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  data[key] = fresh;
  return fresh;
}

/** The entry as the JSON-configured clients expect it. */
export function jsonEntryFor(id: ClientId, entry: ServerEntry): Record<string, unknown> | undefined {
  if (entry.kind === 'bridge') {
    const base = { command: entry.command, args: entry.args, env: entry.env };
    return id === 'vscode' ? { type: 'stdio', ...base } : base;
  }
  switch (id) {
    case 'cursor':
      return { url: entry.url, headers: entry.headers };
    case 'vscode':
      return { type: 'http', url: entry.url, headers: entry.headers };
    case 'gemini':
      return { httpUrl: entry.url, headers: entry.headers };
    default:
      return undefined; // Claude Desktop connects to remote servers through Settings → Connectors
  }
}

function sectionKeyFor(id: ClientId): string {
  return id === 'vscode' ? 'servers' : 'mcpServers';
}

// ---------------------------------------------------------------- TOML (Codex)

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function codexBlock(entry: BridgeEntry): string {
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(', ');
  return [`[mcp_servers.${SERVER_KEY}]`, `command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(', ')}]`, `env = { ${env} }`, ''].join('\n');
}

const CODEX_HEADER = new RegExp(`^\\[mcp_servers\\.${SERVER_KEY}\\]\\s*$`, 'm');

/** Replace or append the `[mcp_servers.panelwave]` table; everything else in the file is kept byte for byte. */
export function upsertCodexBlock(text: string, block: string): { text: string; existed: boolean } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => CODEX_HEADER.test(l));
  if (start < 0) {
    const sep = text.length && !text.endsWith('\n') ? '\n\n' : text.length ? '\n' : '';
    return { text: `${text}${sep}${block}`, existed: false };
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  return { text: `${before}${before.length ? '\n' : ''}${block}${after.trim().length ? `\n${after}` : ''}`, existed: true };
}

// ---------------------------------------------------------------- the writers

/** True when the client already has a `panelwave` entry (undefined: cannot tell, e.g. unparsable file). */
export function hasEntry(id: ClientId, deps: WriteDeps): boolean | undefined {
  const p = deps.platform;
  if (id === 'claude-code') {
    const exe = findOnPath('claude', p);
    if (!exe) return undefined;
    const r = (deps.spawn ?? defaultSpawn)(exe, ['mcp', 'get', SERVER_KEY]);
    return r.status === 0;
  }
  const file = configPathFor(id, p);
  if (!file || !p.exists(file)) return false;
  try {
    if (id === 'codex') return CODEX_HEADER.test(fs.readFileSync(file, 'utf8'));
    const json = readJsonFile(file);
    const servers = json.data[sectionKeyFor(id)];
    return !!servers && typeof servers === 'object' && SERVER_KEY in (servers as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

export function writeClientConfig(id: ClientId, entry: ServerEntry, opts: { renew: boolean }, deps: WriteDeps): WriteResult {
  const base = { id, label: CLIENT_LABELS[id], restartHint: RESTART_HINTS[id] };
  const p = deps.platform;
  try {
    if (id === 'claude-code') return writeClaudeCode(entry, opts, deps, base);
    const file = configPathFor(id, p);
    if (!file) return { ...base, status: 'unsupported', message: 'no configuration file known for this client' };

    if (id === 'codex') {
      if (entry.kind !== 'bridge') return { ...base, status: 'unsupported', path: file, message: 'Codex is configured with the local bridge only' };
      const text = p.exists(file) ? fs.readFileSync(file, 'utf8') : '';
      const { text: next, existed } = upsertCodexBlock(text, codexBlock(entry));
      if (existed && !opts.renew) return { ...base, status: 'exists', path: file, message: 'already configured; run setup --renew to replace it' };
      writeFileSafely(file, next);
      return { ...base, status: 'written', path: file };
    }

    const value = jsonEntryFor(id, entry);
    if (!value) return { ...base, status: 'unsupported', path: file, message: `${CLIENT_LABELS[id]} connects to the hosted server through its own Connectors settings; use the bridge (without --remote)` };
    const json = readJsonFile(file);
    const servers = section(json.data, sectionKeyFor(id));
    if (SERVER_KEY in servers && !opts.renew) return { ...base, status: 'exists', path: file, message: 'already configured; run setup --renew to replace it' };
    servers[SERVER_KEY] = value;
    writeJsonFile(file, json);
    return { ...base, status: 'written', path: file };
  } catch (e) {
    return { ...base, status: 'failed', path: configPathFor(id, p), message: e instanceof Error ? e.message : String(e) };
  }
}

function writeClaudeCode(entry: ServerEntry, opts: { renew: boolean }, deps: WriteDeps, base: Omit<WriteResult, 'status'>): WriteResult {
  const exe = findOnPath('claude', deps.platform);
  if (!exe) return { ...base, status: 'unsupported', message: 'the claude CLI is not on PATH' };
  const run = deps.spawn ?? defaultSpawn;
  const existing = run(exe, ['mcp', 'get', SERVER_KEY]).status === 0;
  if (existing && !opts.renew) return { ...base, status: 'exists', message: 'already configured; run setup --renew to replace it' };
  if (existing) run(exe, ['mcp', 'remove', SERVER_KEY, '--scope', 'user']);
  const args =
    entry.kind === 'bridge'
      ? ['mcp', 'add', '--scope', 'user', ...Object.entries(entry.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), SERVER_KEY, '--', entry.command, ...entry.args]
      : ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_KEY, entry.url, ...Object.entries(entry.headers).flatMap(([k, v]) => ['--header', `${k}: ${v}`])];
  const r = run(exe, args);
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';
    return { ...base, status: 'failed', message: `claude mcp add failed${err ? `: ${err}` : ''}` };
  }
  return { ...base, status: 'written', message: 'user scope (~/.claude.json)' };
}

export interface StoredEntry {
  token?: string;
  allowedDirs?: string[];
  url?: string;
}

/** Split a PANELWAVE_ALLOWED_DIRS value (";" on Windows or for drive-letter paths, ":" otherwise). */
export function splitDirs(value: string, platform: NodeJS.Platform): string[] {
  return splitPathList(value, platform);
}

/** What a client's configuration holds for PanelWave (token, folders, URL); undefined when unreadable. Not for Claude Code (CLI-managed). */
export function readStoredEntry(id: ClientId, deps: WriteDeps): StoredEntry | undefined {
  const p = deps.platform;
  if (id === 'claude-code') return undefined;
  const file = configPathFor(id, p);
  if (!file || !p.exists(file)) return undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (id === 'codex') {
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((l) => CODEX_HEADER.test(l));
      if (start < 0) return undefined;
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      const block = lines.slice(start, end).join('\n');
      const token = /PANELWAVE_TOKEN\s*=\s*"([^"]+)"/.exec(block)?.[1];
      const dirs = /PANELWAVE_ALLOWED_DIRS\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1]?.replace(/\\\\/g, '\\');
      const url = /PANELWAVE_MCP_URL\s*=\s*"([^"]+)"/.exec(block)?.[1];
      return { token, allowedDirs: dirs ? splitDirs(dirs, p.platform) : undefined, url };
    }
    const json = readJsonFile(file);
    const servers = json.data[sectionKeyFor(id)] as Record<string, unknown> | undefined;
    const entry = servers?.[SERVER_KEY] as Record<string, unknown> | undefined;
    if (!entry) return undefined;
    const env = (entry.env ?? {}) as Record<string, string>;
    const headers = (entry.headers ?? {}) as Record<string, string>;
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.Authorization ?? headers.authorization ?? '')?.[1];
    const dirs = env.PANELWAVE_ALLOWED_DIRS;
    return {
      token: env.PANELWAVE_TOKEN ?? bearer,
      allowedDirs: dirs ? splitDirs(dirs, p.platform) : undefined,
      url: env.PANELWAVE_MCP_URL ?? (typeof entry.url === 'string' ? entry.url : typeof entry.httpUrl === 'string' ? entry.httpUrl : undefined),
    };
  } catch {
    return undefined;
  }
}

/** The entry as JSON for clients the command does not know ("add this to your client's MCP configuration"). */
export function genericSnippet(entry: ServerEntry): string {
  const value = entry.kind === 'bridge' ? { command: entry.command, args: entry.args, env: entry.env } : { url: entry.url, headers: entry.headers };
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: value } }, null, 2);
}

/** Same snippet with the token masked, for logs and the JSON result. */
export function maskedSnippet(entry: ServerEntry, prefix: string): string {
  return genericSnippet(entry).replace(/pw_pat_[A-Za-z0-9_-]+/g, `${prefix}…`);
}
