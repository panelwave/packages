import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Package version — package.json sits one level above both src/ and dist/. */
export const version: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Bridge configuration from the environment the MCP client starts it with. */
export interface BridgeConfig {
  /** The hosted PanelWave MCP endpoint. */
  url: string;
  /** Personal access token (or MCP access token) sent as the bearer credential. */
  token: string;
  /** Absolute directories the local file tools may read. */
  allowedDirs: string[];
  version: string;
}

export const DEFAULT_URL = 'https://mcp.panelwave.org/mcp';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeConfig {
  const token = (env.PANELWAVE_TOKEN ?? '').trim();
  if (!token) {
    throw new ConfigError(
      'PANELWAVE_TOKEN is not set. Run `npx -y @panelwave/mcp setup` to connect this computer, or create a personal access token in PanelWave (Profile → Connected apps & access tokens) and add it to the "env" of this MCP server in your client configuration.',
    );
  }
  const url = (env.PANELWAVE_MCP_URL ?? '').trim() || DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`PANELWAVE_MCP_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new ConfigError('PANELWAVE_MCP_URL must use https (plain http only for localhost).');
  }
  const dirs = (env.PANELWAVE_ALLOWED_DIRS ?? '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  // No default folder: without PANELWAVE_ALLOWED_DIRS the local tools are off. Clients often start stdio
  // servers in the home folder or "/", which would expose everything (security review 2026-09-30).
  const allowedDirs = validateAllowedDirs(dirs, cwd);
  return { url: parsed.toString(), token, allowedDirs, version };
}

/**
 * Resolve the folders the local tools may read and refuse a drive root or the
 * whole home folder. Shared by the bridge start-up and `setup`, which writes
 * the folders into the client configuration.
 */
export function validateAllowedDirs(dirs: string[], cwd: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const allowedDirs = dirs.map((d) => path.resolve(cwd, d));
  const homeDir = path.resolve(home);
  const same = (a: string, b: string) => (platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const d of allowedDirs) {
    if (path.parse(d).root === d || same(d.replace(/[\\/]+$/, ''), homeDir)) {
      throw new ConfigError(`PANELWAVE_ALLOWED_DIRS must name the folders with your comics, not a drive root or your whole home folder (${d}).`);
    }
  }
  return allowedDirs;
}
