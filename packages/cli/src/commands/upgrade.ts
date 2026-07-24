import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface UpgradeOptions {
  output?: string;
  dryRun: boolean;
}

interface UpgradeStep {
  description: string;
  path: string;
  action: string;
}

const LATEST_VERSION = '1.4.0';
const LATEST_SCHEMA_URI = 'https://panelwave.org/schema/1.0/panelwave.schema.json';

/**
 * Apply schema migration steps.
 * Currently only supports normalizing to 1.0.0 since that is the only version.
 * Future versions will add migration logic here.
 */
function applyUpgrades(manifest: Record<string, unknown>): { result: Record<string, unknown>; steps: UpgradeStep[] } {
  const result = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const steps: UpgradeStep[] = [];

  // Ensure panelwave header exists
  if (!result.panelwave) {
    result.panelwave = { version: LATEST_VERSION, schema: LATEST_SCHEMA_URI };
    steps.push({
      description: 'Added missing panelwave header',
      path: 'panelwave',
      action: 'add',
    });
  }

  const header = result.panelwave as Record<string, unknown>;

  // Upgrade version string
  if (header.version !== LATEST_VERSION) {
    const oldVersion = header.version;
    header.version = LATEST_VERSION;
    steps.push({
      description: `Updated version from "${oldVersion}" to "${LATEST_VERSION}"`,
      path: 'panelwave.version',
      action: 'update',
    });
  }

  // Upgrade schema URI
  if (header.schema !== LATEST_SCHEMA_URI) {
    const oldSchema = header.schema;
    header.schema = LATEST_SCHEMA_URI;
    steps.push({
      description: `Updated schema URI from "${oldSchema}" to "${LATEST_SCHEMA_URI}"`,
      path: 'panelwave.schema',
      action: 'update',
    });
  }

  // Ensure meta has required fields
  const meta = result.meta as Record<string, unknown> | undefined;
  if (meta) {
    if (!meta.locales && meta.default_locale) {
      meta.locales = [meta.default_locale];
      steps.push({
        description: `Added missing "locales" array from default_locale`,
        path: 'meta.locales',
        action: 'add',
      });
    }
  }

  // Normalize layer kind field (older drafts may use "type" instead of "kind")
  const chapters = result.chapters as Array<Record<string, unknown>> | undefined;
  if (chapters) {
    for (let ci = 0; ci < chapters.length; ci++) {
      const panels = chapters[ci].panels as Record<string, Record<string, unknown>> | undefined;
      if (!panels) continue;
      for (const [panelId, panel] of Object.entries(panels)) {
        const layers = panel.layers as Array<Record<string, unknown>> | undefined;
        if (!layers) continue;
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li];
          if (layer.type && !layer.kind) {
            layer.kind = layer.type;
            delete layer.type;
            steps.push({
              description: `Renamed layer "type" → "kind"`,
              path: `chapters[${ci}].panels.${panelId}.layers[${li}]`,
              action: 'rename',
            });
          }
        }
      }
    }
  }

  // Normalize graph.edges (ensure array)
  if (chapters) {
    for (let ci = 0; ci < chapters.length; ci++) {
      const graph = chapters[ci].graph as Record<string, unknown> | undefined;
      if (graph && !graph.edges) {
        graph.edges = [];
        steps.push({
          description: 'Added missing graph.edges array',
          path: `chapters[${ci}].graph.edges`,
          action: 'add',
        });
      }
    }
  }

  return { result, steps };
}

export function upgradeCommand(file: string, options: UpgradeOptions): void {
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`Error: File not found: ${filePath}`));
    process.exit(1);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    console.error(chalk.red(`Error: Invalid JSON in ${filePath}`));
    process.exit(1);
  }

  const { result, steps } = applyUpgrades(manifest);

  const relPath = path.relative(process.cwd(), filePath);
  console.log();

  if (steps.length === 0) {
    console.log(chalk.green(`  ✓ ${relPath} is already up to date (v${LATEST_VERSION})`));
    console.log();
    process.exit(0);
  }

  console.log(`  ${chalk.cyan(relPath)} — ${steps.length} upgrade(s):`);
  console.log();
  for (const step of steps) {
    const icon =
      step.action === 'add' ? chalk.green('+') :
      step.action === 'remove' ? chalk.red('-') :
      chalk.yellow('~');
    console.log(`  ${icon} ${chalk.dim(step.path)} — ${step.description}`);
  }
  console.log();

  if (options.dryRun) {
    console.log(chalk.yellow('  --dry-run: no files were modified'));
    console.log();
    process.exit(0);
  }

  const json = JSON.stringify(result, null, 2) + '\n';
  const outPath = options.output ? path.resolve(options.output) : filePath;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, 'utf-8');

  const outRel = path.relative(process.cwd(), outPath);
  console.log(chalk.green(`  ✓ Upgraded manifest written to ${outRel}`));
  console.log();
}
