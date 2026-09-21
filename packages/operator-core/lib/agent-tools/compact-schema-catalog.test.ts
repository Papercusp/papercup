/**
 * compact-schema-catalog — the CATALOG-WIDE half of the compact-schema contract
 * (deterministic-tool-definition-delivery-2026-09-21, spec clauses
 * AUTO-BAR-R-3-P-001 and AUTO-BAR-R-7-P-001).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `compact-schema.test.ts`.
 * `libs/generic/tooldef/src/compact-schema.test.ts` proves the reducer against a
 * HAND-BUILT fixture schema. That is the right test for a domain-free library —
 * the lib is a standalone submodule and must not import the operator catalog —
 * but it cannot answer the question the plan actually rests on:
 *
 *     does compaction preserve the callable contract of EVERY REAL TOOL
 *     in the live catalog, and how many bytes does it actually return?
 *
 * A fixture cannot answer that, because the failure mode is a schema SHAPE the
 * fixture author did not think of (an `allOf` sitting under `items`, a
 * `patternProperties` map whose keys are regexes, a property literally named
 * `default`). The catalog has ~900 tools and hits shapes no fixture enumerates,
 * so the property has to be asserted over the population, not a sample.
 *
 * WHAT IS ASSERTED, and why it is a PROPERTY rather than a threshold:
 *   1. CONTRACT EQUALITY, per tool. Every validity-bearing element of the full
 *      schema — property names (including nested ones), types, the `required`
 *      set, enum/const members, every numeric/length/array bound, oneOf/anyOf/
 *      allOf/if-then-else discriminators, and `$defs`/`$ref` STRUCTURE — appears
 *      in the compact schema at the SAME path. This is stated as set equality of
 *      a path-keyed projection, so an element that MOVED is caught as well as
 *      one that vanished.
 *   2. PROSE REMOVAL, per tool. No `description`/`title`/`examples`/`example`/
 *      `default` key survives at any depth — except where such a word is an
 *      author-chosen PROPERTY NAME inside `properties`/`$defs`/etc., which must
 *      survive because dropping it would delete a real argument.
 *   3. MEASURED REDUCTION, catalog-wide. The saving is REPORTED as the real
 *      measured delta across the live catalog. There is deliberately NO magic
 *      threshold: AUTO-BAR-R-7-P-001 is falsified by asserting a hardcoded
 *      figure, so the only assertions here are that the reduction is real
 *      (> 0), monotone per tool (compact <= full), and that the instrument
 *      measured a plausible population.
 *
 * VACUOUS-GREEN TRAPS THIS FILE DEFENDS AGAINST — every assertion above passes
 * trivially against a broken instrument:
 *   - an empty catalog satisfies "every tool preserves its contract" (floor:
 *     MIN_PLAUSIBLE_CATALOG_SIZE);
 *   - an `inputSchema` field that stopped being populated makes both the full
 *     and compact projections `{}`, so contract equality holds and the byte
 *     delta collapses to ~0 (floor: MIN_PLAUSIBLE_FULL_BYTES, plus the
 *     schema-bearing tool count);
 *   - a `contractLines` walker that silently returns `[]` would make every
 *     comparison trivially equal (CONTROL: a deliberately-broken reducer must
 *     be CAUGHT by the same comparison on real catalog input).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  listAllProjectedTools,
  compactInputSchema,
  compactWireBytes,
  COMPACT_DROPPED_KEYS,
  type ProjectedTool,
} from '@papercusp/tooldef';
import { MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';

/** Prose keywords compaction removes. Mirrors the reducer's own exported set so
 *  this file cannot drift from it: widening the reducer widens the check. */
const PROSE_KEYS = new Set<string>(COMPACT_DROPPED_KEYS);

/** Keywords whose VALUE is a map of author-chosen names to subschemas. A key
 *  inside one of these is a NAME, never a prose keyword. */
const NAME_KEYED_CONTAINERS = new Set<string>([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Path marker distinguishing an author-chosen NAME segment from a keyword
 *  segment, so a property literally called `type` can never be confused with
 *  the `type` KEYWORD one level up. Deliberately a printable pair rather than a
 *  control byte (lint:no-control-bytes is a green-checkpoint leg). */
function nameSegment(key: string): string {
  return `⟨${key}⟩`;
}

/**
 * Project a schema onto its CONTRACT: the sorted set of `path=value` leaves,
 * with prose keywords excluded at every non-name-keyed position.
 *
 * Prose is excluded from BOTH sides on purpose — the contract is what remains
 * once prose is disregarded, so equality of these two projections is exactly
 * the claim "compaction removed only prose".
 */
function contractLines(node: unknown, path: string, inNameKeyedMap: boolean, out: string[]): void {
  if (node === null || typeof node !== 'object') {
    out.push(`${path}=${JSON.stringify(node)}`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) out.push(`${path}=[]`);
    node.forEach((entry, i) => contractLines(entry, `${path}[${i}]`, false, out));
    return;
  }
  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.length === 0) out.push(`${path}={}`);
  for (const [key, value] of entries) {
    if (inNameKeyedMap) {
      // An author-chosen property/$def NAME. Keep it verbatim; its VALUE is a
      // subschema, so prose rules apply again one level down.
      contractLines(value, `${path}/${nameSegment(key)}`, false, out);
      continue;
    }
    if (PROSE_KEYS.has(key)) continue;
    contractLines(value, `${path}/${key}`, NAME_KEYED_CONTAINERS.has(key), out);
  }
}

function contractOf(schema: unknown): string[] {
  const out: string[] = [];
  contractLines(schema, '$', false, out);
  out.sort();
  return out;
}

/** Every surviving prose KEY (path-qualified), name-keyed maps excepted. */
function survivingProseKeys(
  node: unknown,
  path: string,
  inNameKeyedMap: boolean,
  out: string[],
): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((entry, i) => survivingProseKeys(entry, `${path}[${i}]`, false, out));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inNameKeyedMap) {
      survivingProseKeys(value, `${path}/${nameSegment(key)}`, false, out);
      continue;
    }
    if (PROSE_KEYS.has(key)) out.push(`${path}/${key}`);
    survivingProseKeys(value, `${path}/${key}`, NAME_KEYED_CONTAINERS.has(key), out);
  }
}

/** Every `$ref` target string in a schema, so ref STRUCTURE can be compared. */
function refTargets(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((entry) => refTargets(entry, out));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') out.push(value);
    refTargets(value, out);
  }
}

/** Resolve a local `#/a/b` JSON pointer against a root schema. */
function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined; // external ref — not this file's subject
  const segments = ref
    .slice(1)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * CONTROL reducer — deliberately WRONG in a way the contract check must catch.
 * It drops `required` and `enum`, which are exactly the elements a "compact"
 * projection is most tempted to treat as prose. If the comparison above ever
 * stops distinguishing this from the real reducer, every green in this file is
 * meaningless.
 */
function brokenCompactSchema(node: unknown, inNameKeyedMap = false): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => brokenCompactSchema(entry, false));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inNameKeyedMap) {
      out[key] = brokenCompactSchema(value, false);
      continue;
    }
    if (PROSE_KEYS.has(key)) continue;
    if (key === 'required' || key === 'enum') continue; // the injected defect
    out[key] = brokenCompactSchema(value, NAME_KEYED_CONTAINERS.has(key));
  }
  return out;
}

function mcpName(t: ProjectedTool): string | null {
  return (t as { expose?: { mcp?: { name?: string } } }).expose?.mcp?.name ?? null;
}

interface CatalogRow {
  name: string;
  description: string;
  inputSchema: unknown;
  hasSchema: boolean;
}

/**
 * Lower plausibility floor on the measured FULL wire bytes across the catalog.
 * The live seed alone has been measured in the hundreds of KB (see
 * omp-seed-wire-budget.test.ts), so a whole-catalog reading below this means
 * `inputSchema` stopped being populated — the instrument broke, the catalog did
 * not get cheap.
 */
const MIN_PLAUSIBLE_FULL_BYTES = 1_000_000;

/** A catalog where almost nothing carries a schema cannot support any claim
 *  about schema compaction, however many tools it returns. */
const MIN_SCHEMA_BEARING_TOOLS = 300;

describe('compact schema projection — live catalog (AUTO-BAR-R-3-P-001 / AUTO-BAR-R-7-P-001)', () => {
  let rows: CatalogRow[] = [];
  let catalogSize = 0;

  beforeAll(async () => {
    // Side-effect import: registers the catalog listAllProjectedTools() reads.
    await import('./index');
    const all = listAllProjectedTools();
    catalogSize = all.length;
    rows = all
      .map((t) => {
        const name = mcpName(t);
        if (!name) return null;
        const schema = (t as { inputSchema?: unknown }).inputSchema;
        return {
          name,
          description: (t as { description?: string }).description ?? '',
          inputSchema: schema,
          hasSchema:
            schema !== null &&
            typeof schema === 'object' &&
            Object.keys(schema as Record<string, unknown>).length > 0,
        } satisfies CatalogRow;
      })
      .filter((r): r is CatalogRow => r !== null);
  }, 120_000);

  it('measured a genuinely-registered catalog (a vacuous green is worse than a red)', () => {
    expect(
      catalogSize,
      `listAllProjectedTools() returned ${catalogSize} tool(s), below the ${MIN_PLAUSIBLE_CATALOG_SIZE} ` +
        'plausibility floor. Every assertion in this file is satisfied trivially by an empty ' +
        'catalog, so this is an instrument failure, not a passing contract.',
    ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

    const schemaBearing = rows.filter((r) => r.hasSchema).length;
    expect(
      schemaBearing,
      `only ${schemaBearing} of ${rows.length} catalog tools carry a non-empty inputSchema. ` +
        'Below the floor this file is comparing empty objects to empty objects.',
    ).toBeGreaterThanOrEqual(MIN_SCHEMA_BEARING_TOOLS);
  });

  it('preserves the callable CONTRACT of every tool in the catalog', () => {
    const broken: Array<{ name: string; missing: string[]; added: string[] }> = [];
    for (const row of rows) {
      const fullLines = contractOf(row.inputSchema ?? {});
      const compactLines = contractOf(compactInputSchema(row.inputSchema ?? {}));
      if (
        fullLines.length === compactLines.length &&
        fullLines.every((l, i) => l === compactLines[i])
      ) {
        continue;
      }
      const compactSet = new Set(compactLines);
      const fullSet = new Set(fullLines);
      broken.push({
        name: row.name,
        missing: fullLines.filter((l) => !compactSet.has(l)).slice(0, 8),
        added: compactLines.filter((l) => !fullSet.has(l)).slice(0, 8),
      });
    }
    expect(
      broken.slice(0, 5),
      `compaction changed the callable contract of ${broken.length} tool(s). ` +
        'A compact definition must be a SMALLER definition of the SAME contract, never a ' +
        'partial one — a dropped required field or enum member makes a model emit calls the ' +
        'server rejects.',
    ).toEqual([]);
  });

  it('removes every prose keyword at every depth, and keeps prose-NAMED properties', () => {
    const offenders: Array<{ name: string; keys: string[] }> = [];
    for (const row of rows) {
      const found: string[] = [];
      survivingProseKeys(compactInputSchema(row.inputSchema ?? {}), '$', false, found);
      if (found.length > 0) offenders.push({ name: row.name, keys: found.slice(0, 6) });
    }
    expect(
      offenders.slice(0, 5),
      `${offenders.length} tool(s) still carry a prose keyword after compaction.`,
    ).toEqual([]);

    // The dual: a property whose NAME collides with a prose keyword must SURVIVE.
    // Asserted over the live catalog rather than a fixture; the fixture-level
    // case lives in libs/generic/tooldef/src/compact-schema.test.ts, so a
    // catalog that happens to contain no such property is not a gap here.
    const collisions: string[] = [];
    for (const row of rows) {
      const props = (row.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      if (!props) continue;
      for (const key of Object.keys(props)) {
        if (!PROSE_KEYS.has(key)) continue;
        const compacted = compactInputSchema(row.inputSchema) as {
          properties?: Record<string, unknown>;
        };
        if (!compacted.properties || !(key in compacted.properties)) {
          collisions.push(`${row.name}.${key}`);
        }
      }
    }
    expect(collisions, 'a prose-NAMED property was deleted — that removes a real argument').toEqual(
      [],
    );
  });

  it('keeps $defs/$ref STRUCTURE resolvable rather than inlining it', () => {
    const unresolved: string[] = [];
    let toolsWithRefs = 0;
    for (const row of rows) {
      const fullRefs: string[] = [];
      refTargets(row.inputSchema ?? {}, fullRefs);
      if (fullRefs.length === 0) continue;
      toolsWithRefs += 1;
      const compact = compactInputSchema(row.inputSchema ?? {});
      const compactRefs: string[] = [];
      refTargets(compact, compactRefs);
      if ([...fullRefs].sort().join('|') !== [...compactRefs].sort().join('|')) {
        unresolved.push(`${row.name}: ref set changed (inlined or dropped)`);
        continue;
      }
      for (const ref of new Set(compactRefs)) {
        if (!ref.startsWith('#')) continue;
        if (resolveLocalRef(compact, ref) === undefined) {
          unresolved.push(`${row.name}: ${ref} no longer resolves`);
        }
      }
    }
    expect(unresolved.slice(0, 5), 'compaction broke $ref resolution').toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`COMPACT_SCHEMA_CATALOG_REFS toolsWithRefs=${toolsWithRefs}`);
  });

  it('CONTROL: the same comparison CATCHES a reducer that drops required/enum', () => {
    const caught: string[] = [];
    for (const row of rows) {
      const fullLines = contractOf(row.inputSchema ?? {});
      const brokenLines = contractOf(brokenCompactSchema(row.inputSchema ?? {}));
      if (fullLines.join('\n') !== brokenLines.join('\n')) caught.push(row.name);
    }
    expect(
      caught.length,
      'a deliberately-broken reducer (drops `required` and `enum`) produced a contract ' +
        'IDENTICAL to the full schema for every catalog tool. That means the contract ' +
        'comparison above is not measuring anything, so its green is vacuous.',
    ).toBeGreaterThan(0);
  });

  it('MEASURES the catalog-wide byte reduction and reports it (no magic threshold)', () => {
    let fullTotal = 0;
    let compactTotal = 0;
    const regressions: string[] = [];
    const perTool: Array<{ name: string; saved: number }> = [];
    for (const row of rows) {
      const m = compactWireBytes(row.name, {
        description: row.description,
        inputSchema: row.inputSchema,
      });
      fullTotal += m.full;
      compactTotal += m.compact;
      perTool.push({ name: row.name, saved: m.saved });
      if (m.compact > m.full) {
        regressions.push(`${row.name}: compact ${m.compact} > full ${m.full}`);
      }
    }

    expect(
      fullTotal,
      `the catalog measured only ${fullTotal} B at FULL tier, below the ${MIN_PLAUSIBLE_FULL_BYTES} B ` +
        'plausibility floor — inputSchema is not being populated, so the reduction below is ' +
        'measuring nothing.',
    ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_FULL_BYTES);

    expect(regressions.slice(0, 5), 'compaction made a tool BIGGER').toEqual([]);

    const saved = fullTotal - compactTotal;
    expect(saved, 'compaction returned no bytes at all across the whole catalog').toBeGreaterThan(0);

    const pct = ((saved / fullTotal) * 100).toFixed(1);
    const top = perTool
      .sort((a, b) => b.saved - a.saved)
      .slice(0, 8)
      .map((r) => `${r.name} ${r.saved}`)
      .join(', ');
    // REPORTED, not asserted — AUTO-BAR-R-7-P-001 is falsified by gating this on
    // a hardcoded figure, so the number travels in the run log instead.
    // eslint-disable-next-line no-console
    console.log(
      `COMPACT_SCHEMA_CATALOG_MEASURED tools=${rows.length} fullBytes=${fullTotal} ` +
        `compactBytes=${compactTotal} savedBytes=${saved} savedPct=${pct} top8=[${top}]`,
    );
  });
});
