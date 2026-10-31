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
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startBridge } from './bridge';
import { ConfigError, DEFAULT_URL, loadConfig, version } from './config';
import { runCommand } from './setup/run';

export { startBridge, createBridgeServer, LOCAL_INSTRUCTIONS } from './bridge';
export { loadConfig, validateAllowedDirs, ConfigError, DEFAULT_URL } from './config';
export { runCommand, runSetup, runStatus, runDoctor, endpoints, type SetupIO } from './setup/run';
export { parseArgs, SETUP_HELP, type SetupArgs } from './setup/args';
export { RemoteProxy } from './remote';
export { LOCAL_TOOLS } from './local-tools';

const HELP = `panelwave-mcp ${version} — PanelWave MCP bridge (stdio)

Set it up in one go (signs you in through your browser, configures your clients):
  npx -y @panelwave/mcp setup            (see: setup --help)
  npx -y @panelwave/mcp status           what is configured, does the token work
  npx -y @panelwave/mcp doctor           checks with a fix for each failure

Or add it to your MCP client by hand, e.g. Claude Code:
  claude mcp add panelwave --env PANELWAVE_TOKEN=pw_pat_… -- npx -y @panelwave/mcp

Environment:
  PANELWAVE_TOKEN         personal access token (required)
  PANELWAVE_MCP_URL       hosted endpoint (default ${DEFAULT_URL})
  PANELWAVE_ALLOWED_DIRS  folders the local file tools may read (default: off)
`;

const COMMANDS = ['setup', 'status', 'doctor'] as const;

function log(message: string): void {
  process.stderr.write(`[panelwave-mcp] ${message}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] as (typeof COMMANDS)[number] | undefined;
  if (command && (COMMANDS as readonly string[]).includes(command)) {
    process.exitCode = await runCommand(command, argv.slice(1));
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  // Positional arguments are extra allowed folders: the Claude Desktop bundle passes the
  // directories the person picked as one argument each (`${user_config.folders}`).
  const positional = argv.filter((a) => !a.startsWith('--'));
  const env = positional.length
    ? { ...process.env, PANELWAVE_ALLOWED_DIRS: [process.env.PANELWAVE_ALLOWED_DIRS ?? '', ...positional].filter(Boolean).join(path.delimiter) }
    : process.env;
  const config = loadConfig(env);
  log(
    config.allowedDirs.length
      ? `v${version} → ${config.url}; local folders: ${config.allowedDirs.join(', ')}`
      : `v${version} → ${config.url}; local file tools are OFF — set PANELWAVE_ALLOWED_DIRS to the folder with your scripts and artwork to use them`,
  );
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
