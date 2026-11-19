import { createHash, createPublicKey, verify } from 'crypto';

/**
 * Verification of a PanelWave channel package (panelwave-cms
 * docs/channel-manager/06 §5.2): `package-manifest.json` lists every file
 * with size and SHA-256 and carries an Ed25519 signature over its canonical
 * JSON (sorted keys, no whitespace) without the `signature` field. The public
 * keys are published at https://read.panelwave.org/.well-known/panelwave-keys.json.
 */

export const PACKAGE_MANIFEST_FILE = 'package-manifest.json';
export const DEFAULT_KEYS_URL = 'https://read.panelwave.org/.well-known/panelwave-keys.json';

export interface PackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PackageManifest {
  format: string;
  workId?: string;
  releaseId?: string;
  listingId?: string | null;
  generatedAt?: string;
  playerVersion?: string;
  files: PackageFile[];
  signature: { alg: string; keyId: string; value: string } | null;
  [key: string]: unknown;
}

export interface Jwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  [key: string]: unknown;
}

/** Where the package's files come from: a folder or a web address. */
export interface PackageSource {
  /** The file's bytes, or null when it does not exist. */
  read(path: string): Promise<Buffer | null>;
  /** Every file below the package root (folders only; null when unknown). */
  list(): Promise<string[] | null>;
}

export interface VerifyResult {
  ok: boolean;
  format: string | null;
  signature: 'valid' | 'invalid' | 'unsigned' | 'unknown-key';
  keyId: string | null;
  checked: number;
  /** Listed files whose size or hash differs. */
  changed: string[];
  /** Listed files that are not there. */
  missing: string[];
  /** Files in the folder that the list does not name (only reported for folders). */
  extra: string[];
  errors: string[];
}

export interface VerifyOptions {
  /** Accept a package without signature (default false). */
  allowUnsigned?: boolean;
  /** Extra files fail the check (default false: reported only). */
  strict?: boolean;
}

/** Canonical JSON: object keys sorted, no whitespace, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The keys of a JWKS (or a bare key array); only Ed25519 public keys. */
export function keysFrom(json: unknown): Jwk[] {
  const list = Array.isArray(json) ? json : (json as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (k): k is Jwk => !!k && typeof k === 'object' && (k as Jwk).kty === 'OKP' && (k as Jwk).crv === 'Ed25519' && typeof (k as Jwk).x === 'string' && typeof (k as Jwk).kid === 'string'
  );
}

/** Check the signature of a package manifest against a set of public keys. */
export function checkSignature(manifest: PackageManifest, keys: Jwk[]): { state: VerifyResult['signature']; keyId: string | null } {
  const sig = manifest.signature;
  if (!sig) return { state: 'unsigned', keyId: null };
  if (sig.alg !== 'Ed25519' || typeof sig.value !== 'string') return { state: 'invalid', keyId: sig.keyId ?? null };
  const jwk = keys.find((k) => k.kid === sig.keyId);
  if (!jwk) return { state: 'unknown-key', keyId: sig.keyId };
  const rest: Record<string, unknown> = { ...manifest };
  delete rest['signature'];
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    const valid = verify(null, Buffer.from(canonicalJson(rest), 'utf8'), key, fromB64url(sig.value));
    return { state: valid ? 'valid' : 'invalid', keyId: sig.keyId };
  } catch {
    return { state: 'invalid', keyId: sig.keyId };
  }
}

/** A listed path must stay inside the package (no absolute paths, no `..`). */
export function safePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((p) => p === '..' || p === '');
}

/** Verify a package: the signature, then every listed file's size and SHA-256. */
export async function verifyPackage(source: PackageSource, keys: Jwk[], options: VerifyOptions = {}): Promise<VerifyResult> {
  const result: VerifyResult = {
    ok: false, format: null, signature: 'unsigned', keyId: null, checked: 0, changed: [], missing: [], extra: [], errors: [],
  };
  const raw = await source.read(PACKAGE_MANIFEST_FILE);
  if (!raw) {
    result.errors.push(`${PACKAGE_MANIFEST_FILE} is missing: this is not a PanelWave channel package.`);
    return result;
  }
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8')) as PackageManifest;
  } catch {
    result.errors.push(`${PACKAGE_MANIFEST_FILE} is not valid JSON.`);
    return result;
  }
  result.format = typeof manifest.format === 'string' ? manifest.format : null;
  if (result.format !== 'panelwave-package/1') result.errors.push(`Unknown package format: ${String(manifest.format)}`);
  if (!Array.isArray(manifest.files)) {
    result.errors.push(`${PACKAGE_MANIFEST_FILE} has no file list.`);
    return result;
  }

  const sig = checkSignature(manifest, keys);
  result.signature = sig.state;
  result.keyId = sig.keyId;
  if (sig.state === 'invalid') result.errors.push('The signature does not match the file list: the list was changed or not made by PanelWave.');
  if (sig.state === 'unknown-key') result.errors.push(`The signing key ${sig.keyId} is not among the published keys.`);
  if (sig.state === 'unsigned' && !options.allowUnsigned) result.errors.push('The package is not signed (use --allow-unsigned to check the files only).');

  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (!file || !safePath(file.path) || typeof file.sha256 !== 'string' || typeof file.bytes !== 'number') {
      result.errors.push(`Malformed entry in the file list: ${JSON.stringify(file).slice(0, 120)}`);
      continue;
    }
    listed.add(file.path);
    const bytes = await source.read(file.path);
    result.checked++;
    if (!bytes) {
      result.missing.push(file.path);
      continue;
    }
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) {
      result.changed.push(file.path);
    }
  }
  const all = await source.list();
  if (all) {
    result.extra = all.filter((p) => p !== PACKAGE_MANIFEST_FILE && !listed.has(p)).sort();
  }

  result.ok =
    result.errors.length === 0 &&
    result.changed.length === 0 &&
    result.missing.length === 0 &&
    (!options.strict || result.extra.length === 0);
  return result;
}
