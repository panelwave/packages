#!/usr/bin/env node
/**
 * Keep the CLI's bundled schema copy in sync with the canonical schema repo.
 *
 *   node scripts/sync-schema.js          copy schema/<major>/panelwave.schema.json
 *                                        from the sibling `schema` repo into
 *                                        packages/cli/schema/
 *   node scripts/sync-schema.js --check  exit 1 if the bundled copy drifts, or
 *                                        if the CLI's LATEST_VERSION does not
 *                                        match the schema's declared version
 *
 * The canonical location is ../schema (the umbrella workspace layout); set
 * PANELWAVE_SCHEMA_DIR to point elsewhere. When the schema repo is not
 * checked out, --check only verifies the version pin (with a warning).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schemaDir = process.env.PANELWAVE_SCHEMA_DIR || path.resolve(root, '..', 'schema');
const bundledDir = path.join(root, 'packages', 'cli', 'schema');
const upgradeTs = path.join(root, 'packages', 'cli', 'src', 'commands', 'upgrade.ts');
const check = process.argv.includes('--check');

function fail(message) {
  console.error(`sync-schema: ${message}`);
  process.exit(1);
}

function declaredVersion(schemaJson) {
  // The schema announces its version in the title ("PanelWave Manifest 1.5.0").
  const m = /(\d+\.\d+\.\d+)/.exec(String(schemaJson.title || ''));
  return m ? m[1] : null;
}

function pinnedVersion() {
  const src = fs.readFileSync(upgradeTs, 'utf8');
  const m = /LATEST_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(src);
  return m ? m[1] : null;
}

const bundledFiles = fs.existsSync(bundledDir)
  ? fs.readdirSync(bundledDir).filter((d) => fs.existsSync(path.join(bundledDir, d, 'panelwave.schema.json')))
  : [];
if (bundledFiles.length === 0) fail(`no bundled schema under ${bundledDir}`);

let problems = 0;
for (const major of bundledFiles) {
  const bundledPath = path.join(bundledDir, major, 'panelwave.schema.json');
  const canonicalPath = path.join(schemaDir, major, 'panelwave.schema.json');
  const bundled = fs.readFileSync(bundledPath, 'utf8');

  if (!fs.existsSync(canonicalPath)) {
    console.warn(`sync-schema: canonical schema not found at ${canonicalPath} — skipping copy/diff for ${major}`);
  } else {
    const canonical = fs.readFileSync(canonicalPath, 'utf8');
    // Compare modulo line endings: a Windows working copy (CRLF) is not drift.
    const lf = (s) => s.replace(/\r\n/g, '\n');
    if (lf(canonical) !== lf(bundled)) {
      if (check) {
        console.error(`sync-schema: packages/cli/schema/${major}/panelwave.schema.json drifts from ${canonicalPath}`);
        problems++;
      } else {
        fs.writeFileSync(bundledPath, canonical);
        console.log(`sync-schema: updated packages/cli/schema/${major}/panelwave.schema.json`);
      }
    } else {
      console.log(`sync-schema: ${major} in sync`);
    }
  }

  const declared = declaredVersion(JSON.parse(fs.readFileSync(bundledPath, 'utf8')));
  const pinned = pinnedVersion();
  if (declared && pinned && declared !== pinned) {
    console.error(`sync-schema: schema declares ${declared} but upgrade.ts pins LATEST_VERSION = '${pinned}' — bump it`);
    problems++;
  } else if (declared && pinned) {
    console.log(`sync-schema: LATEST_VERSION ${pinned} matches the schema title`);
  }
}

if (problems > 0) process.exit(1);
