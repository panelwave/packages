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

    checkCanvasSemantics(m, errors, warnings);
  }

  return { valid: valid === true && errors.length === 0, errors, warnings };
}

/** Semantic canvas rules (schema 1.4) that JSON Schema cannot express structurally. */
const CANVAS_PANEL_BUDGET = 150;

function checkCanvasSemantics(
  m: Record<string, unknown>,
  errors: ValidationResult['errors'],
  warnings: string[]
): void {
  const chapters = Array.isArray(m.chapters) ? (m.chapters as Record<string, unknown>[]) : [];
  let anyCanvas = false;

  chapters.forEach((chapter, ci) => {
    if (!chapter || typeof chapter !== 'object') return;
    const canvas = chapter.canvas as Record<string, unknown> | undefined;
    const graph = chapter.graph as Record<string, unknown> | undefined;
    const edges = graph && Array.isArray(graph.edges) ? (graph.edges as Record<string, unknown>[]) : [];

    // waypoints/path consistency applies with or without a canvas
    edges.forEach((edge, ei) => {
      const move = edge?.cameraMove as Record<string, unknown> | undefined;
      if (!move) return;
      const hasWaypoints = Array.isArray(move.waypoints) && move.waypoints.length > 0;
      if (move.path === 'waypoints' && !hasWaypoints) {
        warnings.push(
          `/chapters/${ci}/graph/edges/${ei}/cameraMove: path is "waypoints" but no waypoints are given — players treat this as "direct".`
        );
      } else if (hasWaypoints && move.path !== 'waypoints') {
        warnings.push(
          `/chapters/${ci}/graph/edges/${ei}/cameraMove: waypoints are only used when path is "waypoints" (path is "${move.path ?? 'direct'}").`
        );
      }
    });

    if (!canvas) return;
    anyCanvas = true;

    const panels = (chapter.panels && typeof chapter.panels === 'object' ? chapter.panels : {}) as Record<string, unknown>;
    const placements = (canvas.placements && typeof canvas.placements === 'object' ? canvas.placements : {}) as Record<string, unknown>;
    const placementIds = Object.keys(placements);

    // Error: every placement key must be an existing panel of this chapter
    for (const id of placementIds) {
      if (!(id in panels)) {
        errors.push({
          path: `/chapters/${ci}/canvas/placements/${id}`,
          message: `placement references unknown panel "${id}" (not in this chapter's panels)`,
          keyword: 'canvas-reference',
        });
      }
    }

    // Warning: reachable panels without a placement
    if (graph) {
      const reachable = collectReachablePanels(graph, edges);
      const unplaced = [...reachable].filter((id) => id in panels && !(id in placements));
      if (unplaced.length > 0) {
        warnings.push(
          `/chapters/${ci}/canvas: ${unplaced.length} reachable panel(s) without a placement (${unplaced.slice(0, 5).join(', ')}${unplaced.length > 5 ? ', …' : ''}) — players lay these out heuristically.`
        );
      }
    }

    // Warning: performance budget
    if (placementIds.length > CANVAS_PANEL_BUDGET) {
      warnings.push(
        `/chapters/${ci}/canvas: ${placementIds.length} placed panels exceed the tested budget of ${CANVAS_PANEL_BUDGET} — expect degraded performance on low-end devices; consider splitting the chapter.`
      );
    }
  });

  // Warning: canvasView enabled but no chapter has a canvas (or vice versa)
  const settings = m.settings as Record<string, unknown> | undefined;
  const presets = (settings?.outputPresets ?? {}) as Record<string, Record<string, unknown>>;
  const anyCanvasView = Object.values(presets).some((p) => p && p.canvasView === true);
  if (anyCanvasView && !anyCanvas) {
    warnings.push('settings.outputPresets enables canvasView, but no chapter defines a canvas — canvas view will never activate.');
  }
  if (anyCanvas && !anyCanvasView) {
    warnings.push('A chapter defines a canvas, but no output preset enables canvasView — players will always fall back to panel view.');
  }
}

/** Panels reachable from the graph entry by following edges (both endpoints count as touched). */
function collectReachablePanels(graph: Record<string, unknown>, edges: Record<string, unknown>[]): Set<string> {
  const entries = Array.isArray(graph.entry) ? (graph.entry as string[]) : typeof graph.entry === 'string' ? [graph.entry] : [];
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const from = edge?.from as string | undefined;
    const to = edge?.to as string | undefined;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    const targets = out.get(from) || [];
    targets.push(to);
    out.set(from, targets);
  }
  const reachable = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of out.get(id) || []) queue.push(next);
  }
  return reachable;
}
