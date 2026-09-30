#!/usr/bin/env node
/**
 * panelwave-mcp — local stdio bridge to the hosted PanelWave MCP server.
 *
 *   npx -y @panelwave/mcp
 *
 * Environment:
 *   PANELWAVE_TOKEN         personal access token (required)
 *   PANELWAVE_MCP_URL       hosted endpoint (default https://mcp.panelwave.org/mcp)
 *   PANELWAVE_ALLOWED_DIRS  folders the local file tools may read, separated by
 *                           ";" on Windows and ":" elsewhere (default: the working directory)
 *
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startBridge } from './bridge';
import { ConfigError, DEFAULT_URL, loadConfig, version } from './config';

export { startBridge, createBridgeServer, LOCAL_INSTRUCTIONS } from './bridge';
export { loadConfig, ConfigError, DEFAULT_URL } from './config';
export { RemoteProxy } from './remote';
export { LOCAL_TOOLS } from './local-tools';

const HELP = `panelwave-mcp ${version} — PanelWave MCP bridge (stdio)

Add it to your MCP client, e.g. Claude Code:
  claude mcp add panelwave --env PANELWAVE_TOKEN=pw_pat_… -- npx -y @panelwave/mcp

Environment:
  PANELWAVE_TOKEN         personal access token (required)
  PANELWAVE_MCP_URL       hosted endpoint (default ${DEFAULT_URL})
  PANELWAVE_ALLOWED_DIRS  folders the local file tools may read (default: working directory)
`;

function log(message: string): void {
  process.stderr.write(`[panelwave-mcp] ${message}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const config = loadConfig();
  log(`v${version} → ${config.url}; local folders: ${config.allowedDirs.join(', ')}`);
  const bridge = await startBridge(config, { log });

  let closing = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    await bridge.close().catch(() => undefined);
    process.exit(code);
  };
  bridge.server.onclose = () => void shutdown(0);
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.stdin.on('end', () => void shutdown(0));

  await bridge.server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((e) => {
    log(e instanceof ConfigError ? e.message : `failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  });
}
