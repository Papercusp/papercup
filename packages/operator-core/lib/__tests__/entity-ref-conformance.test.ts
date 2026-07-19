/**
 * entity-ref-conformance.test.ts — the RATCHET that makes referential integrity
 * stick across the whole tool surface
 * (tool-arg-referential-integrity-2026-07-19 P-003 / D-001).
 *
 * THE PROBLEM THIS SOLVES IS SOCIAL, NOT TECHNICAL. `entityRef` (P-001) and the
 * `entity-check` dispatch step (P-002) give us enforcement; nothing makes ~700
 * tool definitions ADOPT it. A convention that depends on every future tool
 * author remembering it will rot within a month — which is exactly how
 * `harness_slug` came to hold 234 invented values across 12,230 rows.
 *
 * So this is a SHRINK-ONLY BASELINE, the same shape as `DARK_FLAGS_HIGH_WATERMARK`
 * in libs/flags and the empty baseline of `lint:no-raw-setinterval`:
 *
 *   • Every arg whose NAME identifies a durable entity (`pot`, `harness`,
 *     `plan`, `fleet`, `ownerId`, …) SHOULD be declared with `entityRef(kind)`.
 *   • The ones that are not yet converted are counted, and that count may only
 *     GO DOWN. Adding a new unconverted entity-named arg FAILS THE BUILD.
 *
 * A hard "all must convert" gate would fail on day one with ~300 violations and
 * be disabled within the hour; the ratchet lands the guard NOW and lets the
 * migration proceed tool-by-tool without ever regressing.
 *
 * Note the two registries (cf. tool-input-schema-rejection.test.ts):
 * `getCatalog()` exposes built-ins with real Zod `args` we can WALK for the
 * entityRef marker; `listAllProjectedTools()` exposes everything as JSON
 * `inputSchema` only, where the marker is deliberately invisible (P-001 keeps it
 * out of JSON Schema so published contracts never change). Only the walkable
 * registry can be conformance-checked, which this test states explicitly rather
 * than quietly under-reporting.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full real tool catalog
import { getCatalog, collectEntityRefs } from '@papercusp/tooldef';

/**
 * Arg NAMES that denote a durable entity. Name-based on purpose: the whole point
 * is to catch args that were never typed as references, so we cannot key off the
 * type we are trying to introduce.
 */
const ENTITY_ARG_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'pot', re: /^(pot|potSlug|potId|potHomeSlug)$/ },
  { kind: 'harness', re: /^(harness|harnessSlug)$/ },
  { kind: 'plan', re: /^(plan|planSlug)$/ },
  { kind: 'fleet', re: /^(fleet|fleetSlug)$/ },
  { kind: 'workspace', re: /^(workspace|workspaceId)$/ },
  { kind: 'owner', re: /^(ownerId|cupId|targetOwnerId)$/ },
];

/**
 * Args that LOOK like entity references but legitimately are not, and must never
 * be converted. Keep this list SHORT and justified — it is the escape hatch that
 * would otherwise hollow out the ratchet.
 */
const EXEMPT: ReadonlyArray<{ tool: string; arg: string; why: string }> = [
  // `fleet:create` NAMES a fleet that does not exist yet — validating existence
  // would reject every creation. Same shape for any create-the-entity tool.
  { tool: 'fleet:create', arg: 'fleet', why: 'creates the fleet; it cannot pre-exist' },
  { tool: 'harness:create', arg: 'harness', why: 'creates the harness; it cannot pre-exist' },
  { tool: 'pot:create', arg: 'pot', why: 'creates the pot; it cannot pre-exist' },
  { tool: 'plans:new', arg: 'slug', why: 'creates the plan; it cannot pre-exist' },
];

const isExempt = (tool: string, arg: string) => EXEMPT.some((e) => e.tool === tool && e.arg === arg);

/** Last path segment — `members.*.pot` is still a `pot` arg. */
const leafName = (path: string) => path.split('.').filter((p) => p !== '*').pop() ?? path;

interface Unconverted {
  tool: string;
  arg: string;
  kind: string;
}

function scanCatalog(): { unconverted: Unconverted[]; converted: number; walkable: number } {
  const unconverted: Unconverted[] = [];
  let converted = 0;
  let walkable = 0;

  for (const tool of getCatalog()) {
    const name = (tool as { name?: string }).name ?? '(unnamed)';
    const args = (tool as { args?: unknown }).args;
    if (!args) continue;
    walkable++;

    // Which arg paths ARE already declared as entity refs.
    let refPaths: Set<string>;
    try {
      refPaths = new Set(collectEntityRefs(args).map((s) => s.path));
    } catch {
      continue; // unwalkable schema — not a conformance failure
    }
    converted += refPaths.size;

    // Which arg names LOOK like entity refs, from the published shape.
    const shape = (args as { shape?: Record<string, unknown> }).shape;
    if (!shape || typeof shape !== 'object') continue;
    for (const argName of Object.keys(shape)) {
      const match = ENTITY_ARG_PATTERNS.find((p) => p.re.test(argName));
      if (!match) continue;
      if (refPaths.has(argName)) continue; // already converted
      if (isExempt(name, argName)) continue;
      unconverted.push({ tool: name, arg: argName, kind: match.kind });
    }
  }
  return { unconverted, converted, walkable };
}

/**
 * THE RATCHET. This number may only ever DECREASE.
 *
 * Lowering it is the point: convert an arg to `entityRef(kind)`, re-run, drop
 * this to the new count. RAISING it requires an explicit, reviewed decision —
 * do not "fix" a failing build by bumping it, that is the one move that makes
 * this test worthless.
 */
const UNCONVERTED_BASELINE = 33; // measured 2026-07-19: workspace 21, pot 7, harness 6

describe('entityRef conformance ratchet (tool-arg-referential-integrity P-003)', () => {
  it('the real tool catalog loaded (guard against a vacuous pass)', () => {
    // Without this, an import regression would empty the catalog and every
    // assertion below would trivially "pass" while checking nothing.
    expect(getCatalog().length).toBeGreaterThan(10);
  });

  it('entity-named args do not GROW — the count is shrink-only', () => {
    const { unconverted } = scanCatalog();
    if (unconverted.length > UNCONVERTED_BASELINE) {
      const added = unconverted
        .slice(0, 20)
        .map((u) => `  ${u.tool} → ${u.arg} (${u.kind})`)
        .join('\n');
      throw new Error(
        `entityRef conformance REGRESSED: ${unconverted.length} unconverted entity-named args ` +
          `(baseline ${UNCONVERTED_BASELINE}).\n` +
          `An arg naming a durable entity must be declared \`entityRef('<kind>')\` so the ` +
          `entity-check dispatch step can reject invented values.\n` +
          `Sample:\n${added}\n` +
          `Do NOT raise the baseline to make this pass — convert the arg, or add a justified EXEMPT entry.`,
      );
    }
    expect(unconverted.length).toBeLessThanOrEqual(UNCONVERTED_BASELINE);
  });

  it('reports the conformance gap so the migration has a visible target', () => {
    const { unconverted, converted, walkable } = scanCatalog();
    const byKind = new Map<string, number>();
    for (const u of unconverted) byKind.set(u.kind, (byKind.get(u.kind) ?? 0) + 1);
    // Not an assertion on the numbers — a durable, greppable record of where the
    // surface stands, printed on every run so the gap cannot go quietly stale.
    console.log(
      `[entityRef conformance] walkable tools=${walkable} converted=${converted} ` +
        `unconverted=${unconverted.length} baseline=${UNCONVERTED_BASELINE}\n` +
        [...byKind.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${k}: ${n}`)
          .join('\n'),
    );
    expect(Array.isArray(unconverted)).toBe(true);
  });

  it('every EXEMPT entry carries a justification and targets a real arg name', () => {
    for (const e of EXEMPT) {
      expect(e.why.length, `EXEMPT ${e.tool}.${e.arg} needs a justification`).toBeGreaterThan(10);
      expect(
        ENTITY_ARG_PATTERNS.some((p) => p.re.test(e.arg)) || e.arg === 'slug',
        `EXEMPT ${e.tool}.${e.arg} does not match any entity pattern — it is exempting nothing`,
      ).toBe(true);
    }
  });
});
