# PanelWave Packages

The official SDK for the open [PanelWave](https://panelwave.org) format for interactive graphic novels: TypeScript types, a command-line tool for `panelwave.json` manifests, and the MCP bridge that connects AI assistants to PanelWave.

[![ci](https://github.com/panelwave/packages/actions/workflows/ci.yml/badge.svg)](https://github.com/panelwave/packages/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Format](https://img.shields.io/badge/format-1.13-blue)](https://github.com/panelwave/schema)

| Package | npm | Description |
|---------|-----|-------------|
| [`@panelwave/types`](./packages/types) | [![npm](https://img.shields.io/npm/v/@panelwave/types.svg)](https://www.npmjs.com/package/@panelwave/types) | TypeScript interfaces for every definition in the PanelWave manifest schema |
| [`@panelwave/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@panelwave/cli.svg)](https://www.npmjs.com/package/@panelwave/cli) | Validate, bundle, diff and upgrade manifests from the command line, with the schema bundled for offline use |
| [`@panelwave/mcp`](./packages/mcp) | [![npm](https://img.shields.io/npm/v/@panelwave/mcp.svg)](https://www.npmjs.com/package/@panelwave/mcp) | MCP bridge: connects Claude and other MCP clients to PanelWave, adds tools for local files and uploads, and sets up clients with one command |

Related: the format itself lives in [panelwave/schema](https://github.com/panelwave/schema) (CC BY 4.0), and the open-source Angular player in [panelwave/player](https://github.com/panelwave/player) ([`@panelwave/player`](https://www.npmjs.com/package/@panelwave/player)). Documentation: [docs.panelwave.org](https://docs.panelwave.org).

## Format versions

The format and the packages have separate version numbers. The format version is the schema's `title` and a manifest's `panelwave.version`; the current format is **1.13.0**. This table lists the first release of each package that covers a format version completely (format 1.6 and 1.8 gained fields after their first releases):

| Format | `@panelwave/types` | `@panelwave/cli` | What the format added |
|--------|-------------------|------------------|-----------------------|
| 1.13 | 1.10.0 | 1.9.0 | Framed page placements: the image box may extend past the page behind its frame |
| 1.12 | 1.9.0 | 1.8.0 | Spoken lines: `settings.ui.voicesDefault`, `settings.ui.controls.showVoicesToggle` |
| 1.11 | 1.8.0 | 1.7.0 | Per-language artwork (`ImageVariant.locale`) |
| 1.10 | 1.7.0 | 1.6.0 | Content widget layers, `file` assets, `ui.theme`, timed balloons (`showAtMs`) |
| 1.9 | 1.6.0 | 1.5.0 | `paywallAction` tracking event |
| 1.8 | 1.5.0 | 1.4.1 | Balloons grow with their text (`BalloonConfig.textFit`, since 1.4.0), work-wide timeline audio (`SequenceAudioTrack.span`) |
| 1.7 | 1.2.0 | 1.2.0 | Chapters without edges, `x-` properties on panels and extras, `Edge.label`, `Hotspot.display` |
| 1.6 | 1.2.0 | 1.2.0 | Paywall products (since 1.1.0), layer keyframe animations, several alternative covers, ensemble character sheets |

Every format version is backward-compatible: a manifest valid under an older version stays valid. The full change list is in the schema's [version history](https://github.com/panelwave/schema#version-history).

## Getting Started

### TypeScript Types

```bash
npm install @panelwave/types
```

```typescript
import type { PanelwaveManifest, Chapter, Panel } from '@panelwave/types';
```

### CLI

```bash
npm install -g @panelwave/cli          # or without installing: npx @panelwave/cli validate …

panelwave validate ./my-comic/panelwave.json     # --strict fails on warnings, --json for machines
panelwave bundle ./my-comic/ -o dist/panelwave.json
panelwave diff v1.json v2.json
panelwave upgrade ./my-comic/panelwave.json --dry-run   # bring a manifest up to format 1.13.0
```

Options and exit codes: [packages/cli](./packages/cli).

### MCP bridge

The fastest way is the setup command. Run it in the folder with your scripts and artwork, or ask your coding agent to run it:

```bash
npx -y @panelwave/mcp@latest setup
```

It asks PanelWave for an approval link. You approve once in the browser, and the token goes straight into the configuration of the MCP clients on your computer (Claude Code, Claude Desktop, Cursor, Codex CLI, VS Code, Gemini CLI); it is never printed. `npx -y @panelwave/mcp status` shows what is configured, `npx -y @panelwave/mcp doctor` diagnoses problems. The bridge needs Node.js 20 or newer.

To set it up by hand, create a personal access token (`pw_pat_…`) in PanelWave under **Profile → Connected apps & access tokens**, then for example:

```bash
claude mcp add panelwave \
  --env PANELWAVE_TOKEN=pw_pat_… \
  --env PANELWAVE_ALLOWED_DIRS="$HOME/comics" \
  -- npx -y @panelwave/mcp
```

For Claude Desktop there is also a bundle, `panelwave.mcpb`, attached to every `mcp-v*` [GitHub release](https://github.com/panelwave/packages/releases). See [packages/mcp](./packages/mcp) for the other clients, the local file and upload tools, and the configuration options.

## Development

This is an npm workspaces monorepo with a single root `package-lock.json`. Use Node 24 / npm 11, like CI (the lockfile is written by npm 11).

```bash
npm install            # install all workspaces
npm run build          # schema drift check + build all packages
npm run build:types    # @panelwave/types only
npm run build:cli      # schema drift check + @panelwave/cli only
npm run build:mcp      # @panelwave/mcp only
npm test               # tests of every package that has them (today: the MCP bridge)
npm run build:mcpb --workspace=packages/mcp   # Claude Desktop bundle from the built bridge → packages/mcp/mcpb-dist/
```

### CI

`ci.yml` runs on every push to `master` and on pull requests. It checks out `panelwave/schema` next to the repo, builds all packages (including the schema drift check), runs the tests, smoke-tests both binaries (`panelwave --help`; the bridge prints its version and must refuse to start without a token) and runs `npm pack --dry-run` for all three packages.

## Schema

The canonical PanelWave JSON Schema lives in [panelwave/schema](https://github.com/panelwave/schema). `@panelwave/cli` bundles a copy (`packages/cli/schema/1.0/`) for offline validation. [`scripts/sync-schema.js`](scripts/sync-schema.js) keeps the two aligned:

- `npm run sync-schema` copies the canonical schema from a sibling `../schema` checkout (or `$PANELWAVE_SCHEMA_DIR`) into the CLI.
- `npm run check-schema` (runs before every build) fails if the copy drifts, or if `LATEST_VERSION` in `packages/cli/src/commands/upgrade.ts` doesn't match the schema's declared version.

CI clones `panelwave/schema` for this check, so a schema change has to be pushed there before the synced copy lands here.

A new format version therefore goes through these steps:

1. Push the schema change to `panelwave/schema`.
2. Run `npm run sync-schema` and set `LATEST_VERSION` to the new version.
3. Update the interfaces in `packages/types/src/index.ts` (its header names the schema version), and add CLI checks for rules JSON Schema can't express (such as 1.13's "the frame stays on the page").
4. Release `types` and `cli`, and add a row to the [format table](#format-versions) above.

## Releases

Packages are published to npm by the **`release` workflow** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. Actions → **release** → Run workflow → choose the package (`types`, `cli` or `mcp`) and the bump (`patch` / `minor` / `major` / `prerelease`).
2. The workflow builds, runs the tests, bumps `packages/<package>/package.json`, publishes with **npm trusted publishing** (OIDC, no stored token, provenance attached), commits the bump, tags `<package>-vX.Y.Z` and creates the GitHub release. An `mcp` release also builds the Claude Desktop bundle and attaches `panelwave-<version>.mcpb` and `panelwave.mcpb` to its GitHub release.

Leave `version` in `package.json` alone in feature work. The workflow bumps it itself, so a version set by hand makes the release skip a number, and npm never reuses one.

A new package needs a one-time bootstrap before the workflow can publish it: npm only lets you register a trusted publisher on a package that already exists. Publish the first version by hand (`npm publish --access public` in `packages/<package>` while logged in to an npm account with publish rights in the `panelwave` npm org), then add this repo and `release.yml` as its trusted publisher on npmjs.com.

## License

MIT
