/**
 * `panelwave verify-package` (panelwave-cms docs/channel-manager/06 §5.2):
 * a channel package folder with a signed package-manifest.json, checked by
 * the module and by the CLI binary. Run after `npm run build` (npm test does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { canonicalJson, verifyPackage, keysFrom, safePath } = require('../dist/verify/package.js');
const { folderSource } = require('../dist/commands/verify-package.js');
const bin = resolve(here, '..', 'dist', 'index.js');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makePackage({ signed = true, kid = 'pw-test-1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-pkg-'));
  const files = {
    'index.html': '<!doctype html><title>Hero</title>',
    'panelwave.json': JSON.stringify({ panelwave: { version: '1.15.0' } }),
    'assets/hero/w1280.webp': Buffer.from([1, 2, 3, 4, 5]),
    'listing.json': '{"listingId":"l-1"}',
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  const list = Object.entries(files)
    .map(([p, c]) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      return { path: p, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const { privateKey } = generateKeyPairSync('ed25519');
  const manifest = {
    format: 'panelwave-package/1', profile: 'channel', workId: 'w-1', releaseId: 'r-1', listingId: 'l-1',
    generatedAt: '2026-11-19T12:00:00.000Z', playerVersion: '2.4.0', files: list,
  };
  const signature = signed ? { alg: 'Ed25519', keyId: kid, value: b64url(sign(null, Buffer.from(canonicalJson(manifest)), privateKey)) } : null;
  writeFileSync(join(dir, 'package-manifest.json'), JSON.stringify({ signature, ...manifest }, null, 2));
  const { kty, crv, x } = createPublicKey(privateKey).export({ format: 'jwk' });
  const keysFile = join(dir, '..', `keys-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(keysFile, JSON.stringify({ keys: [{ kty, crv, x, kid, use: 'sig', alg: 'EdDSA' }] }));
  return { dir, keysFile, keys: keysFrom({ keys: [{ kty, crv, x, kid }] }) };
}

const cleanup = (pkg) => {
  rmSync(pkg.dir, { recursive: true, force: true });
  rmSync(pkg.keysFile, { force: true });
};

test('canonical JSON matches the export worker (sorted keys, no whitespace)', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' } }), '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
});

test('an intact signed package passes', async () => {
  const pkg = makePackage();
  try {
    const r = await verifyPackage(folderSource(pkg.dir), pkg.keys);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.signature, 'valid');
    assert.equal(r.checked, 4);
    assert.deepEqual([r.changed, r.missing, r.extra], [[], [], []]);
  } finally {
    cleanup(pkg);
  }
});

test('a changed, a missing and an extra file are reported; extra fails only with --strict', async () => {
  const pkg = makePackage();
  try {
    writeFileSync(join(pkg.dir, 'panelwave.json'), '{"tampered":true}');
    unlinkSync(join(pkg.dir, 'listing.json'));
    writeFileSync(join(pkg.dir, 'added.js'), 'alert(1)');
    const r = await verifyPackage(folderSource(pkg.dir), pkg.keys);
    assert.equal(r.ok, false);
    assert.deepEqual(r.changed, ['panelwave.json']);
    assert.deepEqual(r.missing, ['listing.json']);
    assert.deepEqual(r.extra, ['added.js']);
  } finally {
    cleanup(pkg);
  }
  const clean = makePackage();
  try {
    writeFileSync(join(clean.dir, 'added.js'), 'x');
    assert.equal((await verifyPackage(folderSource(clean.dir), clean.keys)).ok, true);
    assert.equal((await verifyPackage(folderSource(clean.dir), clean.keys, { strict: true })).ok, false);
  } finally {
    cleanup(clean);
  }
});

test('a changed list breaks the signature; unknown keys and unsigned lists fail', async () => {
  const pkg = makePackage();
  try {
    const manifestPath = join(pkg.dir, 'package-manifest.json');
    const m = JSON.parse((await import('node:fs')).readFileSync(manifestPath, 'utf8'));
    m.releaseId = 'r-2';
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = await verifyPackage(folderSource(pkg.dir), pkg.keys);
    assert.equal(r.signature, 'invalid');
    assert.equal(r.ok, false);
    assert.equal((await verifyPackage(folderSource(pkg.dir), [])).signature, 'unknown-key');
  } finally {
    cleanup(pkg);
  }
  const unsigned = makePackage({ signed: false });
  try {
    assert.equal((await verifyPackage(folderSource(unsigned.dir), unsigned.keys)).ok, false);
    assert.equal((await verifyPackage(folderSource(unsigned.dir), unsigned.keys, { allowUnsigned: true })).ok, true);
  } finally {
    cleanup(unsigned);
  }
});

test('paths in the list cannot leave the package', () => {
  for (const bad of ['../etc/passwd', '/abs.txt', 'a/../../b', 'a\\b', '', 'a//b']) assert.equal(safePath(bad), false, bad);
  assert.equal(safePath('assets/hero/w1280.webp'), true);
});

test('the CLI exits 0 for an intact package and 1 for a tampered one', () => {
  const pkg = makePackage();
  try {
    const ok = spawnSync(process.execPath, [bin, 'verify-package', pkg.dir, '--keys', pkg.keysFile, '--json'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(JSON.parse(ok.stdout).signature, 'valid');
    writeFileSync(join(pkg.dir, 'index.html'), 'changed');
    const bad = spawnSync(process.execPath, [bin, 'verify-package', pkg.dir, '--keys', pkg.keysFile], { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /changed\s+index\.html/);
  } finally {
    cleanup(pkg);
  }
});
