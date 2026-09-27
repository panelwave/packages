# PanelWave Packages

The official SDK for the open [PanelWave](https://panelwave.org) format for interactive graphic novels: TypeScript types and a command-line tool for `panelwave.json` manifests.

[![ci](https://github.com/panelwave/packages/actions/workflows/ci.yml/badge.svg)](https://github.com/panelwave/packages/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

| Package | npm | Description |
|---------|-----|-------------|
| [`@panelwave/types`](./packages/types) | [![npm](https://img.shields.io/npm/v/@panelwave/types.svg)](https://www.npmjs.com/package/@panelwave/types) | Full TypeScript interfaces for the PanelWave manifest format |
| [`@panelwave/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@panelwave/cli.svg)](https://www.npmjs.com/package/@panelwave/cli) | Validate, bundle, diff, and upgrade manifests from the command line |

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

## Development

This is an npm workspaces monorepo with a single root `package-lock.json`. Use Node 24 / npm 11 (the lockfile is written by npm 11).

```bash
npm install            # install all workspaces
npm run build          # schema drift check + build both packages
npm run build:types    # @panelwave/types only
npm run build:cli      # schema drift check + @panelwave/cli only
```

## Schema

The canonical PanelWave JSON Schema lives in [panelwave/schema](https://github.com/panelwave/schema). `@panelwave/cli` bundles a copy (`packages/cli/schema/1.0/`) for offline validation. [`scripts/sync-schema.js`](scripts/sync-schema.js) keeps the two aligned:

- `npm run sync-schema` copies the canonical schema from a sibling `../schema` checkout (or `$PANELWAVE_SCHEMA_DIR`) into the CLI.
- `npm run check-schema` (runs before every build) fails if the copy drifts, or if `LATEST_VERSION` in `packages/cli/src/commands/upgrade.ts` doesn't match the schema's declared version.

CI clones `panelwave/schema` for this check, so a schema change has to be pushed there before the synced copy lands here.

## Releases

Packages are published to npm by the **`release` workflow** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. Actions → **release** → Run workflow → choose the package (`types` or `cli`) and the bump (`patch` / `minor` / `major` / `prerelease`).
2. The workflow builds, bumps `packages/<package>/package.json`, publishes with **npm trusted publishing** (OIDC, no stored token, provenance attached), commits the bump, tags `<package>-vX.Y.Z` and creates the GitHub release.

## License

MIT
