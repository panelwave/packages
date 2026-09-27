# PanelWave Packages

This monorepo contains the official PanelWave SDK packages.

| Package | Version | Description |
|---------|---------|-------------|
| [`@panelwave/types`](./packages/types) | 1.0.0 | Full TypeScript interfaces for the PanelWave manifest format |
| [`@panelwave/cli`](./packages/cli) | 1.0.0 | Validate, bundle, diff, and upgrade manifests from the command line |

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

```bash
# Install all dependencies
npm install

# Build all packages
npm run build

# Build a single package
npm run build:types
npm run build:cli
```

## Schema

The PanelWave JSON Schema (v1.0) lives in the [`panelwave/schema`](https://github.com/panelwave/schema) repository. The schema file is also bundled inside `@panelwave/cli` for offline validation.

## License

MIT
