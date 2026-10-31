import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'vscode' | 'gemini';
export const CLIENT_IDS: ClientId[] = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'vscode', 'gemini'];

/** Everything the setup needs to know about the machine; tests inject it. */
export interface Platform {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  exists: (p: string) => boolean;
}

export function currentPlatform(): Platform {
  return {
    platform: process.platform,
    home: os.homedir(),
    cwd: process.cwd(),
    env: process.env,
    isTTY: !!process.stdin.isTTY,
    exists: (p) => {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const CLIENT_LABELS: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex CLI',
  vscode: 'VS Code',
  gemini: 'Gemini CLI',
};

export const RESTART_HINTS: Record<ClientId, string> = {
  'claude-code': 'restart Claude Code, or run /mcp and reconnect',
  'claude-desktop': 'quit and reopen Claude Desktop',
  cursor: 'open Cursor Settings → MCP and enable panelwave (or restart Cursor)',
  codex: 'start a new Codex session',
  vscode: 'run "MCP: List Servers" in VS Code and start panelwave (or reload the window)',
  gemini: 'start a new Gemini CLI session',
};

/** The user-level configuration file of a client; `undefined` for Claude Code (managed through its CLI). */
export function configPathFor(id: ClientId, p: Platform): string | undefined {
  const appData = p.env.APPDATA || path.join(p.home, 'AppData', 'Roaming');
  const mac = (...parts: string[]) => path.join(p.home, 'Library', 'Application Support', ...parts);
  const xdg = p.env.XDG_CONFIG_HOME || path.join(p.home, '.config');
  switch (id) {
    case 'claude-code':
      return undefined;
    case 'claude-desktop':
      return p.platform === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json') : p.platform === 'darwin' ? mac('Claude', 'claude_desktop_config.json') : path.join(xdg, 'Claude', 'claude_desktop_config.json');
    case 'cursor':
      return path.join(p.home, '.cursor', 'mcp.json');
    case 'codex':
      return path.join(p.home, '.codex', 'config.toml');
    case 'vscode':
      return p.platform === 'win32' ? path.join(appData, 'Code', 'User', 'mcp.json') : p.platform === 'darwin' ? mac('Code', 'User', 'mcp.json') : path.join(xdg, 'Code', 'User', 'mcp.json');
    case 'gemini':
      return path.join(p.home, '.gemini', 'settings.json');
  }
}

/** Where the client stores its config at all (installed?): the folder above the file, or the CLI on PATH. */
export function isClientPresent(id: ClientId, p: Platform): boolean {
  if (id === 'claude-code') return !!findOnPath('claude', p);
  const file = configPathFor(id, p);
  return !!file && (p.exists(file) || p.exists(path.dirname(file)));
}

/**
 * Split a PATH-like list: ";" on Windows or when the value holds drive-letter
 * paths (a ":" would cut "C:\comics" in two), ":" otherwise.
 */
export function splitPathList(value: string, platform: NodeJS.Platform): string[] {
  const windowsStyle = platform === 'win32' || /(^|[;:])[A-Za-z]:[\\/]/.test(value);
  return value
    .split(windowsStyle ? ';' : ':')
    .map((d) => d.trim())
    .filter(Boolean);
}

/** An executable on PATH (with the Windows extensions), or undefined. */
export function findOnPath(name: string, p: Platform): string | undefined {
  const dirs = splitPathList(p.env.PATH ?? p.env.Path ?? '', p.platform);
  const exts = p.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (p.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface DetectedClient {
  id: ClientId;
  label: string;
  configPath?: string;
  present: boolean;
}

export function detectClients(p: Platform): DetectedClient[] {
  return CLIENT_IDS.map((id) => ({ id, label: CLIENT_LABELS[id], configPath: configPathFor(id, p), present: isClientPresent(id, p) }));
}

/**
 * True when an AI agent, not a person, is running the command: no TTY on
 * stdin, or one of the markers the agents set in their shells.
 */
export function isAgentMode(p: Platform): boolean {
  if (p.env.PANELWAVE_AGENT === '1') return true;
  if (p.env.PANELWAVE_AGENT === '0') return false;
  return !p.isTTY || !!p.env.CLAUDECODE || !!p.env.CURSOR_TRACE_ID || !!p.env.CODEX_SANDBOX || !!p.env.GEMINI_CLI;
}

/** Host name and OS as shown on the approval page ("Claude Code on JENS-PC"). */
export function hostInfo(p: Platform): { host: string; os: string } {
  let host = '';
  try {
    host = os.hostname();
  } catch {
    host = '';
  }
  return { host: host.slice(0, 80), os: `${p.platform} ${os.release()}`.slice(0, 40) };
}

/** Parse a client list from `--client`; unknown ids are reported, not guessed. */
export function parseClientIds(values: string[] | undefined): { ids: ClientId[]; unknown: string[] } {
  if (!values) return { ids: [], unknown: [] };
  const ids: ClientId[] = [];
  const unknown: string[] = [];
  for (const v of values) {
    const id = v.trim().toLowerCase().replace(/_/g, '-') as ClientId;
    if (CLIENT_IDS.includes(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else unknown.push(v);
  }
  return { ids, unknown };
}
