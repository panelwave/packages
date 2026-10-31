import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Project skeleton (`setup --scaffold`, concept §6.1 step 6b): the files the
 * two in-house builds taught us to keep. Never overwrites anything.
 */
const CONCEPT_MD = `# <Working title> — story concept

> Written with your AI assistant before any PanelWave call. Approve each section before the next.

## 1. Logline and core idea

## 2. Design rules
- No villains, only incentives.
- Every choice costs something.
- Twists are fair: at least three clues before each reveal.

## 3. World and characters

## 4. Variables
| Name | Scope (global, chapter, page, session, persistent) | Type | Start | Meaning |
|---|---|---|---|---|

## 5. Chapter and panel plan
Panel ids per scene (P001 …), branch panels, variant panels.

## 6. Decision index
| Decision | Panel | Options | Effects on variables | Rejoins at |
|---|---|---|---|---|

## 7. Ending logic (JSON Logic, the language PanelWave edges use)

## 8. PanelWave build notes
Page formats, languages, extras, paywall placement.
`;

const SCRIPT_FOUNTAIN = `/*
  PanelWave script conventions (kept by the CMS Script Import and by the assistant's outline step):
  - One scene heading per panel, the panel id as trailing parenthetical: INT. STUDIO - DAY (P001)
  - At most three balloons per panel; !SUPER: captions count as balloons.
  - Action first, then captions, then dialogue. No ALL-CAPS dialogue unless it is a shout.
  - Decisions and branches as notes on the action line: [[DECISION C01 — "Go left" → P012 | "Go right" → P020]]
  - Variant panels get their own heading: (P012-V2) plus [[VARIANT of P012 when has_key]]
  - # opens a chapter, ## a page grouping; both go after the chapter's first heading.
*/

# Chapter 1

INT. STUDIO - DAY (P001)

A pencil-drawn artist looks up from a blank page.

ARTIST
This is where it starts.
`;

const BUILD_MD = `# PanelWave build log

Memory for the assistant across sessions. Keep it current; a new session reads it first.

- Work id: _(after pw_works_create_from_outline)_
- Editor link:
- Page formats:
- Languages:

## Panel id → PanelWave id

| Panel | Chapter | PanelWave id | Artwork attached | Lettered | Notes |
|---|---|---|---|---|---|

## Done
- [ ] Chapter 1 outline created and reviewed

## Gaps (things the editor still has to do)
`;

const GITIGNORE_LINES = ['.state.json', '*.panelwave.bak'];

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

export function scaffoldProject(cwd: string): ScaffoldResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const files: Array<[string, string]> = [
    ['concept.md', CONCEPT_MD],
    ['script.fountain', SCRIPT_FOUNTAIN],
    ['panelwave-build.md', BUILD_MD],
  ];
  for (const dir of ['panels', 'references']) {
    const full = path.join(cwd, dir);
    if (fs.existsSync(full)) skipped.push(dir + path.sep);
    else {
      fs.mkdirSync(full, { recursive: true });
      created.push(dir + path.sep);
    }
  }
  for (const [name, content] of files) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full)) skipped.push(name);
    else {
      fs.writeFileSync(full, content, 'utf8');
      created.push(name);
    }
  }
  const gitignore = path.join(cwd, '.gitignore');
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) {
    fs.writeFileSync(gitignore, `${current}${current.length && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
    created.push(current.length ? '.gitignore (2 lines)' : '.gitignore');
  } else skipped.push('.gitignore');
  return { created, skipped };
}
