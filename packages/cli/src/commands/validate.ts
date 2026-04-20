import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { validateManifest, ValidationResult } from '../schema';

interface ValidateOptions {
  schema: string;
  strict: boolean;
  json: boolean;
}

export function validateCommand(file: string, options: ValidateOptions): void {
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`Error: File not found: ${filePath}`));
    process.exit(1);
  }

  let manifest: unknown;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    manifest = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: Invalid JSON — ${msg}`));
    process.exit(1);
  }

  let result: ValidationResult;
  try {
    result = validateManifest(manifest, options.schema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  // Human-readable output
  const relPath = path.relative(process.cwd(), filePath);
  console.log();

  if (result.valid) {
    console.log(chalk.green(`  ✓ ${relPath} is valid (schema ${options.schema})`));
  } else {
    console.log(chalk.red(`  ✗ ${relPath} has ${result.errors.length} error(s)`));
    console.log();

    // Group errors by path
    const grouped = new Map<string, string[]>();
    for (const err of result.errors) {
      const msgs = grouped.get(err.path) || [];
      msgs.push(err.message);
      grouped.set(err.path, msgs);
    }

    for (const [errPath, messages] of grouped) {
      console.log(chalk.yellow(`  ${errPath}`));
      for (const msg of [...new Set(messages)]) {
        console.log(`    → ${msg}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    console.log();
    console.log(chalk.yellow(`  ⚠ ${result.warnings.length} warning(s):`));
    for (const w of result.warnings) {
      console.log(`    → ${w}`);
    }
  }

  console.log();

  if (options.strict && result.warnings.length > 0) {
    process.exit(1);
  }

  process.exit(result.valid ? 0 : 1);
}
