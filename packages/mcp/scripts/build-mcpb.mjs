#!/usr/bin/env node
/**
 * Build the Claude Desktop extension bundle (panelwave-<version>.mcpb and a
 * stable panelwave.mcpb) from the compiled bridge: manifest + server/ (dist)
 * + production node_modules + icon. Run `npm run build` first.
 *
 * The bundle is a zip packed and validated by the official `mcpb` CLI. The
 * release workflow attaches it to the GitHub release of @panelwave/mcp, so
 * https://github.com/panelwave/packages/releases/latest/download/panelwave.mcpb
 * always points at the newest build.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const stage = path.join(pkgDir, 'mcpb-build');
const out = path.join(pkgDir, 'mcpb-dist');

if (!existsSync(path.join(pkgDir, 'dist', 'index.js'))) {
  console.error('dist/index.js is missing — run `npm run build` first');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(out, { recursive: true });

// server/ = the compiled bridge; its config.ts reads ../package.json for the version.
cpSync(path.join(pkgDir, 'dist'), path.join(stage, 'server'), { recursive: true });
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: 'server/index.js', dependencies: pkg.dependencies }, null, 2) + '\n',
);
execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', { cwd: stage, stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'mcpb', 'manifest.template.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(path.join(pkgDir, 'mcpb', 'icon.png'), path.join(stage, 'icon.png'));
cpSync(path.join(pkgDir, 'LICENSE'), path.join(stage, 'LICENSE'));

const versioned = path.join(out, `panelwave-${pkg.version}.mcpb`);
rmSync(versioned, { force: true });
execSync(`npx -y @anthropic-ai/mcpb@latest pack "${stage}" "${versioned}"`, { stdio: 'inherit' });
cpSync(versioned, path.join(out, 'panelwave.mcpb'));
console.log(`bundle: ${versioned}`);
