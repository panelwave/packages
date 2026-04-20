import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

let _ajv: InstanceType<typeof Ajv> | null = null;

function getAjv(): InstanceType<typeof Ajv> {
  if (!_ajv) {
    _ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      validateFormats: true,
      allowUnionTypes: true,
    });
    addFormats(_ajv);
  }
  return _ajv;
}

/**
 * Resolve the schema file for a given version.
 * Looks first in the bundled `schema/` directory shipped with the CLI package,
 * then falls back to a local `schema/` directory relative to cwd.
 */
export function resolveSchemaPath(version: string): string {
  const major = version.split('.')[0];

  // Bundled with CLI package
  const bundled = path.resolve(__dirname, '..', 'schema', `${major}.0`, 'panelwave.schema.json');
  if (fs.existsSync(bundled)) return bundled;

  // Fallback: workspace-local (monorepo development)
  const local = path.resolve(process.cwd(), 'schema', `${major}.0`, 'panelwave.schema.json');
  if (fs.existsSync(local)) return local;

  // Fallback: traverse up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'schema', `${major}.0`, 'panelwave.schema.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Schema file not found for version ${version}. ` +
    `Expected at: ${bundled} or ${local}`
  );
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    keyword: string;
  }>;
  warnings: string[];
}

export function validateManifest(manifest: unknown, schemaVersion: string): ValidationResult {
  const schemaPath = resolveSchemaPath(schemaVersion);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

  const ajv = getAjv();
  const validate = ajv.compile(schema);
  const valid = validate(manifest);

  const errors: ValidationResult['errors'] = [];
  const warnings: string[] = [];

  if (!valid && validate.errors) {
    for (const err of validate.errors) {
      errors.push({
        path: err.instancePath || '/',
        message: err.message || 'Unknown error',
        keyword: err.keyword,
      });
    }
  }

  // Structural warnings (non-blocking)
  const m = manifest as Record<string, unknown>;
  if (m && typeof m === 'object') {
    if (!m.assets) {
      warnings.push('No "assets" section — panels referencing assetIds will fail at runtime.');
    }
    const meta = m.meta as Record<string, unknown> | undefined;
    if (meta && !meta.characters) {
      warnings.push('No "characters" defined in meta — speech bubbles with characterId will be unresolved.');
    }
  }

  return { valid, errors, warnings };
}
