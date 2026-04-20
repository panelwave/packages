#!/usr/bin/env node

import { Command } from 'commander';
import { validateCommand } from './commands/validate';
import { bundleCommand } from './commands/bundle';
import { diffCommand } from './commands/diff';
import { upgradeCommand } from './commands/upgrade';

const pkg = require('../package.json');

const program = new Command();

program
  .name('panelwave')
  .description('PanelWave CLI — validate, bundle, diff, and upgrade manifests')
  .version(pkg.version);

program
  .command('validate <file>')
  .description('Validate a PanelWave manifest against the schema')
  .option('-s, --schema <version>', 'Schema version to validate against', '1.0.0')
  .option('--strict', 'Enable strict mode (fail on warnings)', false)
  .option('--json', 'Output results as JSON', false)
  .action(validateCommand);

program
  .command('bundle <directory>')
  .description('Bundle a manifest directory into a single JSON file')
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--minify', 'Minify the output', false)
  .action(bundleCommand);

program
  .command('diff <fileA> <fileB>')
  .description('Show structural differences between two PanelWave manifests')
  .option('--json', 'Output diff as JSON', false)
  .option('--ignore-order', 'Ignore array ordering differences', false)
  .action(diffCommand);

program
  .command('upgrade <file>')
  .description('Upgrade a manifest to the latest schema version')
  .option('-o, --output <file>', 'Output file path (default: overwrite in-place)')
  .option('--dry-run', 'Show changes without writing', false)
  .action(upgradeCommand);

program.parse();
