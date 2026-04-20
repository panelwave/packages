import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import deepEqual from 'fast-deep-equal';

interface DiffOptions {
  json: boolean;
  ignoreOrder: boolean;
}

interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  valueA?: unknown;
  valueB?: unknown;
}

function sortArrays(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortArrays).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (obj && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortArrays((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

function computeDiff(
  a: unknown,
  b: unknown,
  currentPath: string,
  diffs: DiffEntry[],
  ignoreOrder: boolean
): void {
  const effectiveA = ignoreOrder ? sortArrays(a) : a;
  const effectiveB = ignoreOrder ? sortArrays(b) : b;

  if (deepEqual(effectiveA, effectiveB)) return;

  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    diffs.push({ path: currentPath, type: 'changed', valueA: a, valueB: b });
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${currentPath}[${i}]`;
      if (i >= a.length) {
        diffs.push({ path: childPath, type: 'added', valueB: b[i] });
      } else if (i >= b.length) {
        diffs.push({ path: childPath, type: 'removed', valueA: a[i] });
      } else {
        computeDiff(a[i], b[i], childPath, diffs, ignoreOrder);
      }
    }
    return;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

  for (const key of allKeys) {
    const childPath = currentPath ? `${currentPath}.${key}` : key;
    if (!(key in objA)) {
      diffs.push({ path: childPath, type: 'added', valueB: objB[key] });
    } else if (!(key in objB)) {
      diffs.push({ path: childPath, type: 'removed', valueA: objA[key] });
    } else {
      computeDiff(objA[key], objB[key], childPath, diffs, ignoreOrder);
    }
  }
}

function loadJson(file: string): unknown {
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`Error: File not found: ${filePath}`));
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    console.error(chalk.red(`Error: Invalid JSON in ${filePath}`));
    process.exit(1);
  }
}

function truncate(val: unknown, maxLen = 80): string {
  const str = JSON.stringify(val);
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

export function diffCommand(fileA: string, fileB: string, options: DiffOptions): void {
  const a = loadJson(fileA);
  const b = loadJson(fileB);

  const diffs: DiffEntry[] = [];
  computeDiff(a, b, '', diffs, options.ignoreOrder);

  if (options.json) {
    console.log(JSON.stringify(diffs, null, 2));
    process.exit(diffs.length > 0 ? 1 : 0);
  }

  const relA = path.relative(process.cwd(), path.resolve(fileA));
  const relB = path.relative(process.cwd(), path.resolve(fileB));
  console.log();
  console.log(`  Comparing ${chalk.cyan(relA)} ↔ ${chalk.cyan(relB)}`);
  console.log();

  if (diffs.length === 0) {
    console.log(chalk.green('  ✓ Manifests are identical'));
    console.log();
    process.exit(0);
  }

  console.log(`  ${chalk.yellow(`${diffs.length} difference(s) found:`)}`);
  console.log();

  for (const d of diffs) {
    const loc = chalk.dim(d.path || '(root)');
    switch (d.type) {
      case 'added':
        console.log(`  ${chalk.green('+')} ${loc}`);
        console.log(`    ${chalk.green(truncate(d.valueB))}`);
        break;
      case 'removed':
        console.log(`  ${chalk.red('-')} ${loc}`);
        console.log(`    ${chalk.red(truncate(d.valueA))}`);
        break;
      case 'changed':
        console.log(`  ${chalk.yellow('~')} ${loc}`);
        console.log(`    ${chalk.red('- ' + truncate(d.valueA))}`);
        console.log(`    ${chalk.green('+ ' + truncate(d.valueB))}`);
        break;
    }
  }

  console.log();
  process.exit(1);
}
