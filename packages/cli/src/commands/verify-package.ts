import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { DEFAULT_KEYS_URL, keysFrom, verifyPackage, type Jwk, type PackageSource, type VerifyResult } from '../verify/package';

interface VerifyPackageOptions {
  keys?: string;
  allowUnsigned: boolean;
  strict: boolean;
  json: boolean;
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** A package folder on disk. */
export function folderSource(dir: string): PackageSource {
  const root = path.resolve(dir);
  return {
    async read(rel) {
      const file = path.resolve(root, ...rel.split('/'));
      if (!file.startsWith(root + path.sep)) return null;
      try {
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    },
    async list() {
      const out: string[] = [];
      const walk = (abs: string, prefix: string): void => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(abs, entry.name), relPath);
          else if (entry.isFile()) out.push(relPath);
        }
      };
      walk(root, '');
      return out;
    },
  };
}

/** A package on a web server (the folder's address). */
export function urlSource(base: string): PackageSource {
  const root = base.endsWith('/') ? base : base + '/';
  return {
    async read(rel) {
      const url = new URL(rel.split('/').map(encodeURIComponent).join('/'), root).toString();
      const res = await fetch(url, { redirect: 'follow' });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async list() {
      return null; // a web server does not list its files
    },
  };
}

async function loadKeys(spec: string | undefined): Promise<Jwk[]> {
  const where = spec || DEFAULT_KEYS_URL;
  const text = isUrl(where)
    ? await (async () => {
        const res = await fetch(where);
        if (!res.ok) throw new Error(`keys ${where}: HTTP ${res.status}`);
        return res.text();
      })()
    : fs.readFileSync(path.resolve(where), 'utf8');
  return keysFrom(JSON.parse(text));
}

function report(result: VerifyResult, target: string): void {
  const sig =
    result.signature === 'valid'
      ? chalk.green(`signed by PanelWave (key ${result.keyId})`)
      : result.signature === 'unsigned'
        ? chalk.yellow('not signed')
        : chalk.red(result.signature === 'unknown-key' ? `unknown key ${result.keyId}` : 'signature invalid');
  console.log(`${chalk.bold(target)}: ${sig}, ${result.checked} file(s) checked`);
  for (const p of result.changed) console.log(chalk.red(`  changed  ${p}`));
  for (const p of result.missing) console.log(chalk.red(`  missing  ${p}`));
  for (const p of result.extra) console.log(chalk.yellow(`  extra    ${p}`));
  for (const e of result.errors) console.log(chalk.red(`  ${e}`));
  console.log(result.ok ? chalk.green('✓ The package is intact.') : chalk.red('✗ The package did not pass the check.'));
}

/** `panelwave verify-package <folder|url>` */
export async function verifyPackageCommand(target: string, options: VerifyPackageOptions): Promise<void> {
  try {
    const keys = await loadKeys(options.keys);
    const source = isUrl(target) ? urlSource(target) : folderSource(target);
    const result = await verifyPackage(source, keys, { allowUnsigned: options.allowUnsigned, strict: options.strict });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else report(result, target);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) console.log(JSON.stringify({ ok: false, errors: [message] }, null, 2));
    else console.error(chalk.red(`✗ ${message}`));
    process.exitCode = 2;
  }
}
