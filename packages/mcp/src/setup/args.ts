/**
 * Arguments of the `setup`, `status` and `doctor` commands. Hand-rolled on
 * purpose: the bridge has no CLI dependency and these are a dozen flags.
 */
export type RouteStyle = 'path' | 'query';

export interface SetupArgs {
  command: 'setup' | 'status' | 'doctor';
  help: boolean;
  json: boolean;
  /** Link code of the /connect page (`--link j3k9qz`). */
  link?: string;
  /** Client ids to configure (`--client claude-code,cursor`); default: every detected client. */
  clients?: string[];
  /** Folders the local tools may read (`--dirs a;b`); default: the working directory. */
  dirs?: string[];
  /** Token name shown in PanelWave; default "<client> · <host>" (set by the approval page). */
  name?: string;
  /** Token lifetime in days (1–365); default 365 (server side). */
  expires?: number;
  /** Scopes to request; default: the server's setup defaults (no publish). */
  scopes?: string[];
  /** Configure the hosted URL with an Authorization header instead of the bridge. */
  remote: boolean;
  /** Write the agent brief into AGENTS.md (and CLAUDE.md when present). */
  instructions: boolean;
  /** Poll until approved (false: print the link, save the pending request and exit). */
  wait: boolean;
  /** Replace an existing `panelwave` entry (also how permissions are widened). */
  renew: boolean;
  /** Create the project skeleton (concept.md, script.fountain, panels/, …). */
  scaffold: boolean;
  /** Hosted MCP endpoint (default https://mcp.panelwave.org/mcp). */
  url?: string;
  /** CMS SPA origin (default https://app.panelwave.org). */
  app?: string;
  /** CMS API base (default `<app>/api`). */
  api?: string;
  /** `query` sends `?endpoint=/route` (APIs served from a sub-path, dev worktrees). */
  routeStyle?: RouteStyle;
  unknown: string[];
}

const LIST_FLAGS = new Set(['client', 'clients', 'dirs', 'scopes']);
const VALUE_FLAGS = new Set(['link', 'client', 'clients', 'dirs', 'name', 'expires', 'scopes', 'url', 'app', 'api', 'route-style']);

export function parseArgs(command: SetupArgs['command'], argv: string[]): SetupArgs {
  const out: SetupArgs = { command, help: false, json: false, remote: false, instructions: true, wait: true, renew: false, scaffold: false, unknown: [] };
  const lists: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      out.unknown.push(raw);
      continue;
    }
    let key = raw.slice(2);
    let value: string | undefined;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (VALUE_FLAGS.has(key)) {
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          out.unknown.push(`--${key} needs a value`);
          continue;
        }
        i++;
      }
      if (LIST_FLAGS.has(key)) {
        const sep = key === 'dirs' ? /[;:]/ : /[,\s]+/;
        // On Windows a folder like C:\comics contains ":"; split folders on ";" only there.
        const parts = key === 'dirs' && /^[A-Za-z]:[\\/]/.test(value) ? value.split(';') : value.split(sep);
        lists[key] = [...(lists[key] ?? []), ...parts.map((p) => p.trim()).filter(Boolean)];
      } else if (key === 'expires') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 365) out.unknown.push('--expires must be a whole number of days between 1 and 365');
        else out.expires = n;
      } else if (key === 'route-style') {
        if (value === 'path' || value === 'query') out.routeStyle = value;
        else out.unknown.push('--route-style must be path or query');
      } else if (key === 'link') out.link = value.trim().toLowerCase();
      else if (key === 'name') out.name = value;
      else if (key === 'url') out.url = value;
      else if (key === 'app') out.app = value;
      else if (key === 'api') out.api = value;
      continue;
    }
    switch (key) {
      case 'help':
        out.help = true;
        break;
      case 'json':
        out.json = true;
        break;
      case 'remote':
        out.remote = true;
        break;
      case 'no-instructions':
        out.instructions = false;
        break;
      case 'no-wait':
        out.wait = false;
        break;
      case 'renew':
        out.renew = true;
        break;
      case 'scaffold':
        out.scaffold = true;
        break;
      default:
        out.unknown.push(raw);
    }
  }
  if (lists.client || lists.clients) out.clients = [...(lists.client ?? []), ...(lists.clients ?? [])];
  if (lists.dirs) out.dirs = lists.dirs;
  if (lists.scopes) out.scopes = lists.scopes;
  return out;
}

export const SETUP_HELP = `panelwave-mcp setup — connect this computer's AI clients to PanelWave

  npx -y @panelwave/mcp setup [--link <code>] [--client <ids>] [--dirs <folders>] [--scopes <list>]
                              [--name <token name>] [--expires <days>] [--remote] [--renew]
                              [--scaffold] [--no-instructions] [--no-wait] [--json]

The command asks PanelWave for an approval link, you approve once in your browser, and the
token is written straight into the configuration of the detected clients (never printed).

  --link <code>        the code from the /connect page's pasted prompt (shows the request there)
  --client <ids>       claude-code, claude-desktop, cursor, codex, vscode, gemini (default: detected)
  --dirs <folders>     folders the local file tools may read (default: this folder)
  --scopes <list>      permissions to request (default: PanelWave's setup defaults, no publish)
  --renew              replace an existing PanelWave entry (also widens permissions with --scopes)
  --remote             use the hosted server with a bearer header instead of the local bridge
  --scaffold           create concept.md, script.fountain, panels/, references/, panelwave-build.md
  --no-instructions    do not write the agent brief into AGENTS.md / CLAUDE.md
  --no-wait            print the approval link and exit; run setup again to continue
  --json               machine-readable result on stdout

  panelwave-mcp status   what is configured and whether the token still works
  panelwave-mcp doctor   checks Node, npx, clients, token, folders and the server
`;
