import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

interface BundleOptions {
  output?: string;
  minify: boolean;
}

/**
 * Bundle a PanelWave manifest directory into a single JSON file.
 *
 * Supports a directory layout where the manifest is split into separate files:
 *   manifest/
 *     panelwave.json      ← root (or partial root with $ref-like includes)
 *     meta.json
 *     chapters/
 *       ch-01.json
 *       ch-02.json
 *     assets.json
 *     ...
 *
 * If the directory contains a single `panelwave.json`, it is used as-is.
 * Otherwise, each recognized top-level key file is merged into the root.
 */
export function bundleCommand(directory: string, options: BundleOptions): void {
  const dirPath = path.resolve(directory);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(chalk.red(`Error: Directory not found: ${dirPath}`));
    process.exit(1);
  }

  const rootFile = path.join(dirPath, 'panelwave.json');
  let manifest: Record<string, unknown> = {};

  if (fs.existsSync(rootFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(rootFile, 'utf-8'));
    } catch {
      console.error(chalk.red(`Error: Invalid JSON in ${rootFile}`));
      process.exit(1);
    }
  }

  // Merge top-level section files
  const sections = [
    'meta', 'assets', 'variables', 'settings', 'extras', 'paywall', 'tracking', 'ui',
  ];

  for (const section of sections) {
    const sectionFile = path.join(dirPath, `${section}.json`);
    if (fs.existsSync(sectionFile) && !(section in manifest)) {
      try {
        manifest[section] = JSON.parse(fs.readFileSync(sectionFile, 'utf-8'));
      } catch {
        console.error(chalk.red(`Error: Invalid JSON in ${sectionFile}`));
        process.exit(1);
      }
    }
  }

  // Merge chapter directory
  const chaptersDir = path.join(dirPath, 'chapters');
  if (fs.existsSync(chaptersDir) && fs.statSync(chaptersDir).isDirectory() && !manifest.chapters) {
    const chapterFiles = fs
      .readdirSync(chaptersDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const chapters: unknown[] = [];
    for (const cf of chapterFiles) {
      try {
        chapters.push(JSON.parse(fs.readFileSync(path.join(chaptersDir, cf), 'utf-8')));
      } catch {
        console.error(chalk.red(`Error: Invalid JSON in ${path.join(chaptersDir, cf)}`));
        process.exit(1);
      }
    }
    if (chapters.length > 0) {
      manifest.chapters = chapters;
    }
  }

  const indent = options.minify ? 0 : 2;
  const json = JSON.stringify(manifest, null, indent);

  if (options.output) {
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json + '\n', 'utf-8');
    console.log(chalk.green(`  ✓ Bundled manifest written to ${path.relative(process.cwd(), outPath)}`));
  } else {
    process.stdout.write(json + '\n');
  }
}
