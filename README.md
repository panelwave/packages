# PanelWave Packages

The official SDK for the open [PanelWave](https://panelwave.org) format for interactive graphic novels: TypeScript types, a command-line tool for `panelwave.json` manifests, and the MCP bridge that connects AI assistants to PanelWave.

[![ci](https://github.com/panelwave/packages/actions/workflows/ci.yml/badge.svg)](https://github.com/panelwave/packages/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

| Package | npm | Description |
|---------|-----|-------------|
| [`@panelwave/types`](./packages/types) | [![npm](https://img.shields.io/npm/v/@panelwave/types.svg)](https://www.npmjs.com/package/@panelwave/types) | Full TypeScript interfaces for the PanelWave manifest format |
| [`@panelwave/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@panelwave/cli.svg)](https://www.npmjs.com/package/@panelwave/cli) | Validate, bundle, diff, and upgrade manifests from the command line |
| [`@panelwave/mcp`](./packages/mcp) | [![npm](https://img.shields.io/npm/v/@panelwave/mcp.svg)](https://www.npmjs.com/package/@panelwave/mcp) | MCP bridge: connects Claude and other MCP clients to PanelWave, plus local file tools |

Related: the format itself lives in [panelwave/schema](https://github.com/panelwave/schema) (CC BY 4.0), and the open-source Angular player in [panelwave/player](https://github.com/panelwave/player) ([`@panelwave/player`](https://www.npmjs.com/package/@panelwave/player)). Documentation: [docs.panelwave.org](https://docs.panelwave.org).

## Getting Started

### TypeScript Types

```bash
npm install @panelwave/types
```

```typescript
import type { PanelwaveManifest } from '@panelwave/types';
```

### CLI

```bash
npm install -g @panelwave/cli

panelwave validate ./my-comic/panelwave.json
panelwave bundle ./my-comic/ -o dist/panelwave.json
panelwave diff v1.json v2.json
panelwave upgrade ./my-comic/panelwave.json --dry-run
```

### MCP bridge

```bash
claude mcp add panelwave --env PANELWAVE_TOKEN=pw_pat_… -- npx -y @panelwave/mcp
```

See [packages/mcp](./packages/mcp) for Claude Desktop, Cursor and the configuration options.

## Development

This is an npm workspaces monorepo with a single root `package-lock.json`. Use Node 24 / npm 11 (the lockfile is written by npm 11).

```bash
npm install            # install all workspaces
npm run build          # schema drift check + build all packages
npm run build:types    # @panelwave/types only
npm run build:cli      # schema drift check + @panelwave/cli only
npm run build:mcp      # @panelwave/mcp only
npm test               # tests of every package that has them
```

## Schema

The canonical PanelWave JSON Schema lives in [panelwave/schema](https://github.com/panelwave/schema). `@panelwave/cli` bundles a copy (`packages/cli/schema/1.0/`) for offline validation. [`scripts/sync-schema.js`](scripts/sync-schema.js) keeps the two aligned:

- `npm run sync-schema` copies the canonical schema from a sibling `../schema` checkout (or `$PANELWAVE_SCHEMA_DIR`) into the CLI.
- `npm run check-schema` (runs before every build) fails if the copy drifts, or if `LATEST_VERSION` in `packages/cli/src/commands/upgrade.ts` doesn't match the schema's declared version.

CI clones `panelwave/schema` for this check, so a schema change has to be pushed there before the synced copy lands here.

## Releases

Packages are published to npm by the **`release` workflow** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. Actions → **release** → Run workflow → choose the package (`types`, `cli` or `mcp`) and the bump (`patch` / `minor` / `major` / `prerelease`).
2. The workflow builds, runs the tests, bumps `packages/<package>/package.json`, publishes with **npm trusted publishing** (OIDC, no stored token, provenance attached), commits the bump, tags `<package>-vX.Y.Z` and creates the GitHub release.

A new package needs a one-time bootstrap before the workflow can publish it: npm only lets you register a trusted publisher on a package that already exists. Publish the first version by hand (`npm publish --access public` in `packages/<package>` while logged in to an npm account with publish rights in the `panelwave` npm org), then add this repo and `release.yml` as its trusted publisher on npmjs.com.

## License

MIT
