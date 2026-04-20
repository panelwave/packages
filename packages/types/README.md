# @panelwave/types

Full TypeScript interfaces for the [PanelWave](https://panelwave.org) JSON manifest format (v1.0).

## Install

```bash
npm install @panelwave/types
```

## Usage

```typescript
import type { PanelwaveManifest, Chapter, Panel } from '@panelwave/types';

const manifest: PanelwaveManifest = {
  panelwave: { version: '1.0.0', schema: 'https://panelwave.org/schema/1.0/panelwave.schema.json' },
  meta: {
    id: 'my-comic',
    title: { 'en-US': 'My Comic' },
    locales: ['en-US'],
    default_locale: 'en-US',
  },
  chapters: [
    {
      id: 'ch-01',
      panels: {
        'panel-01': {
          layers: [{ kind: 'image', assetId: 'bg', z: 0 }],
        },
      },
      graph: { entry: 'panel-01', edges: [] },
    },
  ],
};
```

## What's included

Every `$defs` entry from [`panelwave.schema.json`](https://panelwave.org/schema/1.0/panelwave.schema.json) is exported as a named TypeScript interface or type alias:

- **Root** — `PanelwaveManifest`
- **Header / Meta** — `PanelwaveHeader`, `Meta`, `Character`, `Creator`, `ContentWarning`
- **Assets** — `Assets`, `AssetCatalogItem`, `ImageVariant`, `AudioVariant`, `VideoVariant`, …
- **Chapters** — `Chapter`, `Page`, `PageLayout`, `Placement`, `Graph`, `Edge`
- **Panels** — `Panel`, `Layer` (union), `SpeechBubble`, `Hotspot`, `AudioTrack`, …
- **Balloons** — `BalloonConfig`, `BalloonConfigOverride`, `TailConfig`, `HideBorderConfig`
- **Variables** — `Variables`, `VariableDefinition`, `Mutation`
- **Settings** — `Settings`, `FormatPreset`, `PreloadSettings`, …
- **Paywall / Tracking / UI** — `Paywall`, `PaywallRule`, `Tracking`, `UISettings`, …
- **Primitives** — `Identifier`, `LocaleCode`, `Uri`, `ColorHex`, `NormalizedNumber`, `LocalizedString`, …

## License

MIT
