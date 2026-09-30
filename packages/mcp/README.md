# @panelwave/mcp

Local [MCP](https://modelcontextprotocol.io) bridge for [PanelWave](https://panelwave.org). It connects Claude Desktop, Claude Code, Cursor and other MCP clients to the hosted PanelWave MCP server and adds tools that work on files of your computer. Use it to find panel artwork in a folder or read a script.

```
MCP client ──stdio──▶ @panelwave/mcp ──HTTPS + token──▶ mcp.panelwave.org ──▶ your PanelWave works
                          │
                          └── pw_local_* tools (read-only, only inside PANELWAVE_ALLOWED_DIRS)
```

The bridge mirrors the hosted server. Tool names, schemas, results and errors pass through unchanged, and its resources are forwarded too. When PanelWave adds or changes a tool, your client picks it up without a bridge update. If you only need the hosted tools and your client supports remote MCP servers, you can connect to `https://mcp.panelwave.org/mcp` directly instead.

## Setup

1. Create a personal access token in PanelWave: **Profile → Connected apps & access tokens**. Tokens start with `pw_pat_`. Pick the scopes the assistant may use.
2. Add the bridge to your MCP client. It needs Node.js 20 or newer.

### Claude Code

```bash
claude mcp add panelwave \
  --env PANELWAVE_TOKEN=pw_pat_… \
  --env PANELWAVE_ALLOWED_DIRS="$HOME/comics" \
  -- npx -y @panelwave/mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "panelwave": {
      "command": "npx",
      "args": ["-y", "@panelwave/mcp"],
      "env": {
        "PANELWAVE_TOKEN": "pw_pat_…",
        "PANELWAVE_ALLOWED_DIRS": "/Users/me/comics"
      }
    }
  }
}
```

On Windows, write the folder as `"C:\\Users\\me\\comics"`. If Claude Desktop cannot find `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@panelwave/mcp"]`.

### Cursor and other clients

Any client that starts stdio servers works the same way. The command is `npx -y @panelwave/mcp`, and the environment variables below are the configuration.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PANELWAVE_TOKEN` | *(required)* | Personal access token. The bridge refuses to start without it. |
| `PANELWAVE_MCP_URL` | `https://mcp.panelwave.org/mcp` | Hosted endpoint. Plain `http` is accepted only for `localhost`. |
| `PANELWAVE_ALLOWED_DIRS` | the working directory | Folders the local tools may read, separated by `;` on Windows and `:` on macOS/Linux. |

`panelwave-mcp --version` prints the version and `--help` a short usage. The bridge writes diagnostics to stderr, and your client shows them in its MCP log.

## Local tools

| Tool | What it does |
|------|--------------|
| `pw_local_list_files` | Lists a folder: absolute path, size, mime type, kind, and for images the pixel dimensions with EXIF orientation applied. Supports a name glob such as `*.{png,jpg}`, subfolders and a limit. Files sort naturally, so `panel-2` comes before `panel-10`. |
| `pw_local_read_text` | Reads a UTF-8 text file such as a script, `.fountain` screenplay or outline. Files over 1 MiB are cut and flagged `truncated`; `maxBytes` goes up to 5 MiB. Binary files are refused. |

Both tools are read-only. Every path is resolved, with symlinks followed, and must stay inside `PANELWAVE_ALLOWED_DIRS`. Anything else fails with `INVALID_INPUT`. Relative paths are taken from the first allowed folder. Hidden files and `node_modules` are skipped unless you ask for them.

## Errors

Local tools return errors as tool results with `isError: true` and a structured body `{ code, message }`, using the same codes as the hosted server:

- **`UNAUTHENTICATED`** means PanelWave rejected the token because it expired, was revoked or was mistyped. Create a new token and update the client configuration.
- **`UPSTREAM_UNAVAILABLE`** means the hosted server is unreachable. The local tools keep working. The bridge retries in the background and announces the PanelWave tools once it reaches the server.
- **`INVALID_INPUT`**, **`NOT_FOUND`** and **`PRECONDITION_FAILED`** come from the local tools, for example for a path outside the allowed folders, a missing file or a binary file.

## Development

From the repository root:

```bash
npm install
npm run build:mcp
npm test --workspace=packages/mcp
```

The tests run the bridge against an in-process stand-in for the hosted server over both in-memory and Streamable HTTP transports.

## License

MIT
