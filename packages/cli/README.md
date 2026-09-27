# @panelwave/cli

Validate, bundle, diff, and upgrade [PanelWave](https://panelwave.org) manifests from the command line.

## Install

```bash
npm install -g @panelwave/cli
```

## Commands

### `panelwave validate <file>`

Validate a manifest against the PanelWave JSON Schema.

```bash
panelwave validate ./my-comic/panelwave.json
panelwave validate ./my-comic/panelwave.json --schema 1.0.0
panelwave validate ./my-comic/panelwave.json --strict   # fail on warnings too
panelwave validate ./my-comic/panelwave.json --json     # machine-readable output
```

### `panelwave bundle <directory>`

Bundle a split manifest directory into a single JSON file.

```bash
panelwave bundle ./my-comic/                        # stdout
panelwave bundle ./my-comic/ -o dist/panelwave.json # write to file
panelwave bundle ./my-comic/ --minify               # minified output
```

Supported directory layout:

```
my-comic/
  panelwave.json      ← root (panelwave header, etc.)
  meta.json
  assets.json
  chapters/
    ch-01.json
    ch-02.json
```

### `panelwave diff <fileA> <fileB>`

Show structural differences between two manifests.

```bash
panelwave diff v1/panelwave.json v2/panelwave.json
panelwave diff v1/panelwave.json v2/panelwave.json --json
panelwave diff v1/panelwave.json v2/panelwave.json --ignore-order
```

### `panelwave upgrade <file>`

Upgrade a manifest to the latest schema version.

```bash
panelwave upgrade ./my-comic/panelwave.json              # in-place
panelwave upgrade ./my-comic/panelwave.json --dry-run     # preview changes
panelwave upgrade ./my-comic/panelwave.json -o upgraded.json
```

## Exit Codes

| Code | Meaning                           |
|------|-----------------------------------|
| `0`  | Success / valid / identical       |
| `1`  | Errors found / differences exist  |

## Links

- **Source:** [github.com/panelwave/packages](https://github.com/panelwave/packages/tree/master/packages/cli) ([issues](https://github.com/panelwave/packages/issues))
- **Types:** [`@panelwave/types`](https://www.npmjs.com/package/@panelwave/types): TypeScript interfaces for manifests
- **Player:** [`@panelwave/player`](https://www.npmjs.com/package/@panelwave/player): the open-source Angular player
- **Format:** [github.com/panelwave/schema](https://github.com/panelwave/schema) (the canonical schema this CLI bundles, CC BY 4.0)
- **Docs:** [docs.panelwave.org](https://docs.panelwave.org)

## License

MIT
