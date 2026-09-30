# @panelwave/mcp

Local [MCP](https://modelcontextprotocol.io) bridge for [PanelWave](https://panelwave.org). It connects Claude Desktop, Claude Code, Cowork, Cursor and other MCP clients to the hosted PanelWave MCP server. It also adds tools that work on files of your computer: find panel artwork in a folder, read a script, and upload a whole folder of artwork into a work.

```
MCP client ──stdio──▶ @panelwave/mcp ──HTTPS + token──▶ mcp.panelwave.org ──▶ your PanelWave works
                          │
                          └── pw_local_* tools (only inside PANELWAVE_ALLOWED_DIRS)
```

The bridge mirrors the hosted server. Tool names, schemas, results and errors pass through unchanged, and its resources are forwarded too. When PanelWave adds or changes a tool, your client picks it up without a bridge update. If you only need the hosted tools and your client supports remote MCP servers, you can connect to `https://mcp.panelwave.org/mcp` directly instead. Uploading local files needs the bridge.

## Quick start

1. Create a personal access token in PanelWave: **Profile → Connected apps & access tokens**. Tokens start with `pw_pat_`. For the script-to-work flow below, tick `works:read`, `works:write`, `assets:read` and `assets:write`.
2. Install Node.js 20 or newer.
3. Add the bridge to your client as shown below. Set `PANELWAVE_ALLOWED_DIRS` to the folder that holds your scripts and artwork.

### Claude Code

```bash
claude mcp add panelwave \
  --env PANELWAVE_TOKEN=pw_pat_… \
  --env PANELWAVE_ALLOWED_DIRS="$HOME/comics" \
  -- npx -y @panelwave/mcp
```

Run `/mcp` inside Claude Code to check that `panelwave` is connected.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

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

### Cowork

Cowork runs inside the Claude Desktop app. Configure the bridge as for Claude Desktop above. Point `PANELWAVE_ALLOWED_DIRS` at the same folder you give Cowork to work in, so both see the same files.

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "panelwave": {
      "command": "npx",
      "args": ["-y", "@panelwave/mcp"],
      "env": { "PANELWAVE_TOKEN": "pw_pat_…", "PANELWAVE_ALLOWED_DIRS": "/Users/me/comics" }
    }
  }
}
```

### Other clients

Any client that starts stdio servers works the same way. The command is `npx -y @panelwave/mcp`, and the environment variables below are the configuration.

## Walkthrough: from a script and a folder of panels to a work

Say `~/comics/rooftop` holds a script and the finished panels:

```
rooftop/
  script.md          (or .fountain / .txt)
  panels/
    panel-01.png
    panel-02.png
    …
    panel-12.jpg
```

Then ask the assistant, one step at a time or all at once:

1. **"Read rooftop/script.md and turn it into a PanelWave work: one panel per shot, speech balloons from the dialogue, mobile and A4 formats."** The assistant reads the script with `pw_local_read_text` and drafts an outline. It shows you a dry run of `pw_works_create_from_outline`, then creates the work.
2. **"Upload the images in rooftop/panels into that work, into a folder called Panels."** `pw_local_upload_files` hashes each file, reads its dimensions and uploads it. Large videos go up in parts. Files already in the library are reused, so running this again after an interruption only uploads what is missing.
3. **"Attach panel-01 to the first panel, panel-02 to the second, and so on."** `pw_panels_attach_artwork` sets each image as the panel's background. It fits the panel to the image's aspect ratio on every page format.
4. **"Check the work."** `pw_validation_run` lists what is still missing, such as panels without artwork or untranslated balloons. Open the editor link from step 1 to review and publish.

The assistant asks before destructive steps such as deleting pages or panels.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PANELWAVE_TOKEN` | *(required)* | Personal access token. The bridge refuses to start without it. |
| `PANELWAVE_MCP_URL` | `https://mcp.panelwave.org/mcp` | Hosted endpoint. Plain `http` is accepted only for `localhost`. |
| `PANELWAVE_ALLOWED_DIRS` | *(none — local tools off)* | Folders the local tools may read, separated by `;` on Windows and `:` on macOS/Linux. Without it the bridge only mirrors the hosted tools. A drive root or your whole home folder is refused. |

`panelwave-mcp --version` prints the version and `--help` a short usage. The bridge writes diagnostics to stderr, and your client shows them in its MCP log.

## Local tools

| Tool | What it does |
|------|--------------|
| `pw_local_list_files` | Lists a folder: absolute path, size, mime type, kind, and for images the pixel dimensions with EXIF orientation applied. Supports a name glob such as `*.{png,jpg}`, subfolders and a limit. Files sort naturally, so `panel-2` comes before `panel-10`. |
| `pw_local_read_text` | Reads a UTF-8 text file such as a script, `.fountain` screenplay or outline. Files over 1 MiB are cut and flagged `truncated`; `maxBytes` goes up to 5 MiB. Binary files are refused. |
| `pw_local_upload_files` | Uploads images, videos, audio and fonts into a work's asset library, from a folder with an optional glob or from a list of paths. See below. |

Every path is resolved, with symlinks followed, and must stay inside `PANELWAVE_ALLOWED_DIRS`. Anything else fails with `INVALID_INPUT`. The check runs on the path text before the filesystem is touched, and network paths (`\\server\share`) are refused, so a path can never make Windows connect to another machine. Relative paths are taken from the first allowed folder. Hidden files and `node_modules` are skipped in listings unless you ask for them, and `pw_local_read_text` never reads hidden files or folders such as `.ssh` or `.env`. The list and read tools never change anything.

Uploads go only to the https storage URLs the hosted server signs (plain http only on localhost, for development), and the bridge never sends its token or cookies there.

### How uploads work

- **Deduplicated.** Each file's SHA-256 is compared with the library first. Content that is already there, or appears twice in one batch, is not uploaded again; its row reports the existing asset id. Pass `skipDuplicates: false` to get a `CONFLICT` row instead.
- **Resumable.** Because finished files are recognised by their hash, running the same upload again after a failure only sends the files that are missing.
- **Large files in parts.** Files of 10 MB or more are uploaded in 5 MiB parts. Each part is read from disk just before it is sent, so a 2 GB video does not need 2 GB of memory.
- **Retries.** Each transfer is tried up to 3 times with backoff. An expired upload URL is renewed automatically. An unfinished multipart upload is aborted so storage discards its parts.
- **Parallel.** Three files are uploaded at a time by default, configurable up to 6 with `concurrency`.
- **Metadata.** Image width and height are read locally with EXIF orientation applied. Video duration and dimensions are filled in by PanelWave after transcoding.
- **Folders and tags.** `folderName` files every upload into an asset-library folder and creates it when missing. Use `"Chapter 1/Panels"` for a nested folder. Files that were already in the library are added to the folder too. `tags` are stored on new assets.
- **Progress.** The tool reports byte progress to clients that show it.

The result has one row per file with the status `uploaded`, `exists`, `failed` or `cancelled`, the asset id, and any warnings. An example warning is an image over 5 MB that needs an optimized variant before publishing.

## Errors

Tool errors come back as results with `isError: true` and a structured body `{ code, message }`. The codes are the same as on the hosted server:

- **`UNAUTHENTICATED`** means PanelWave rejected the token because it expired, was revoked or was mistyped. Create a new token and update the client configuration.
- **`UPSTREAM_UNAVAILABLE`** means the hosted server or the upload storage is unreachable. The list and read tools keep working. The bridge retries in the background and announces the PanelWave tools once it reaches the server.
- **`INVALID_INPUT`**, **`NOT_FOUND`** and **`PRECONDITION_FAILED`** come from the local tools, for example for a path outside the allowed folders, a missing file or a binary file.
- **`QUOTA_EXCEEDED`**, **`PERMISSION_DENIED`** and other hosted codes are passed through unchanged, also inside upload rows.

## Development

From the repository root:

```bash
npm install
npm run build:mcp
npm test --workspace=packages/mcp
MCP_BIG_UPLOAD=1 npm test --workspace=packages/mcp   # adds the 100 MB streaming upload test
```

The tests run the bridge against an in-process stand-in for the hosted server, over both in-memory and Streamable HTTP transports. Uploads are tested against a simulated gateway and a mock S3 endpoint that can fail on demand.

## License

MIT
