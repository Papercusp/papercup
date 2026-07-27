/**
 * P-012 (agent-state-plane-verification-2026-07-27) — HOLDER-CONTEXT INJECTION PARITY.
 *
 * The item, verbatim: assert all four friction points and both non-conflict claim
 * reads "render the SAME holder goal for the same holder+reader, and that each goes
 * through the one shared resolver rather than assembling locally. Diff the rendered
 * payloads — divergence between surfaces is the exact defect the shared projection
 * exists to prevent."
 *
 * ── WHY A STRUCTURAL HALF, GIVEN holder-advisory.test.ts IS ALREADY 416 LINES ──
 *
 * That suite proves the shared seam BEHAVES correctly — it drives
 * `resolveHolderAdvisory` / `resolveHolderAdvisoryMap` through every failure mode
 * and pins D-094's subtraction. What it cannot prove, because it only ever calls
 * those two functions, is that the SURFACES ACTUALLY USE THEM. A tool that
 * re-implements "resolve once per holder" against the pure resolver passes every
 * assertion in that file by never being mentioned in it.
 *
 * That is not a hypothetical gap — it is how this file earned its keep. `enrichBusy`
 * (locks:acquire's contended rows) called `resolveHolderContext` directly with its
 * own per-owner `Promise.all`, while its sibling `locks/queue.ts` went through the
 * shared fan-out. Two surfaces in ONE directory resolving the same projection two
 * ways, which is the precise divergence D-038 axis 5 and this plan item exist to
 * forbid — and the concrete cost was real: the shared path caps the distinct
 * holder fan-out at HOLDER_ADVISORY_DISTINCT_CAP and reports what it skipped,
 * and the local copy was UNBOUNDED.
 *
 * ⚠ THE CHECK IS ON THE VALUE IMPORT, NOT THE TYPE IMPORT. Every consumer legitimately
 * imports `HolderContext` / `HolderContextSources` as TYPES — that is the shared shape
 * doing its job. What must be centralised is the RESOLUTION. So the scan looks for
 * modules that pull in the resolver FUNCTION, and a `import type { ... }` line is
 * deliberately not a violation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHolderAdvisory, resolveHolderAdvisoryMap } from './holder-advisory';
import { attachHolderContext } from '../work_items/_holder-lens';
import { forSubject, type HolderContextSources, type HolderGoalRecord } from '../../coord/holder-context';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';
import { AGENT_GOAL_CELL } from '../../cell-registrations';

const LIB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Modules permitted to call the PURE resolver directly.
 *
 * `coord/holder-context.ts` DEFINES it; `holder-advisory.ts` is the one wiring layer
 * that binds the pure projection to the real stores (its own header states this is
 * why it exists as a module rather than as six call sites). Anything else calling it
 * is a second copy of that binding.
 */
const RESOLVER_ALLOWLIST = new Set([
  'coord/holder-context.ts',
  'agent-tools/coordination/holder-advisory.ts',
]);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(abs, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Files that import the RESOLVER FUNCTION (not merely the types) from the pure module. */
function modulesCallingPureResolver(): string[] {
  const hits: string[] = [];
  for (const abs of walkTs(LIB_ROOT)) {
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('resolveHolderContext')) continue;
    // A type-only import, or a mention inside a comment, is not a call.
    const callsIt = /(^|[^.\w])resolveHolderContext\s*\(/m.test(src);
    const importsValue = /import\s+(?!type\s)\{[^}]*\bresolveHolderContext\b[^}]*\}\s+from/s.test(src);
    if (callsIt || importsValue) hits.push(relative(LIB_ROOT, abs).replace(/\\/g, '/'));
  }
  return hits.sort();
}

/** Surfaces that render a HolderContext through the SHARED wiring. */
function modulesUsingSharedWiring(): string[] {
  const hits: string[] = [];
  for (const abs of walkTs(LIB_ROOT)) {
    const src = readFileSync(abs, 'utf8');
    const rel = relative(LIB_ROOT, abs).replace(/\\/g, '/');
    if (RESOLVER_ALLOWLIST.has(rel) || rel === 'agent-tools/work_items/_holder-lens.ts') continue;
    if (/(^|[^.\w])(resolveHolderAdvisory|resolveHolderAdvisoryMap|attachHolderContext)\s*\(/m.test(src)) {
      hits.push(rel);
    }
  }
  return hits.sort();
}

describe('P-012: ONE shared resolver — no surface assembles holder context locally', () => {
  /**
   * NON-VACUITY. A tree-walking scan whose glob silently matches nothing is green and
   * worthless — the failure mode P-009 found in all four of this plane's scanning
   * guards. These floors are what stop a broken walk from reading as "no violations".
   */
  it('the scan actually reaches the tree it claims to audit', () => {
    const files = walkTs(LIB_ROOT);
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith('coord/holder-context.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('agent-tools/coordination/holder-advisory.ts'))).toBe(true);
  });

  /**
   * THE ASSERTION THE EXISTING SUITE STRUCTURALLY CANNOT MAKE.
   *
   * A surface that re-implements the fan-out is invisible to a test that only calls
   * the shared functions — it passes by never being mentioned. This names every
   * module that reaches past the wiring layer to the pure resolver.
   */
  it('only the pure module and the ONE wiring layer call resolveHolderContext', () => {
    const offenders = modulesCallingPureResolver().filter((f) => !RESOLVER_ALLOWLIST.has(f));
    expect(
      offenders,
      `these modules resolve holder context THEMSELVES instead of going through ` +
        `resolveHolderAdvisory / resolveHolderAdvisoryMap / attachHolderContext. Each is a second copy ` +
        `of "resolve once per holder, project per subject" — they agree on the day they are written ` +
        `and drift afterwards, and each looks correct in isolation. Route them through ` +
        `agent-tools/coordination/holder-advisory.ts (D-038 axis 5).`,
    ).toEqual([]);
  });

  /**
   * The dual, so the guard above cannot be satisfied by DELETING the enrichment: the
   * consumer population must stay non-trivial. P-012 names four friction points and
   * two non-conflict claim reads; the friction points span six tool files.
   */
  it('the consumer population is intact — the friction points and both claim reads still enrich', () => {
    const users = modulesUsingSharedWiring();
    expect(users.length).toBeGreaterThanOrEqual(8);

    // The two NON-CONFLICT claim reads (P-030's lens), named explicitly because they
    // are the pair most easily lost: they decorate an ordinary read, not a refusal.
    expect(users).toContain('agent-tools/work_items/list.ts');
    expect(users).toContain('agent-tools/work_items/get.ts');

    // The friction points (P-027).
    for (const f of [
      'agent-tools/work_items/claim.ts',
      'agent-tools/work_items/request_release.ts',
      'agent-tools/work_items/decline_release_request.ts',
      'agent-tools/locks/queue.ts',
      'agent-tools/plan-items/claim.ts',
      'agent-tools/plans/set-status.ts',
    ]) {
      expect(users, `${f} no longer renders holder context through the shared wiring`).toContain(f);
    }
  });
});

/* ── The rendered payloads themselves ──────────────────────────────────────── */

const NOW = Date.parse('2026-07-27T18:00:00.000Z');
const reader = { ownerId: 'su-reader', role: 'su' } as never;

beforeEach(() => {
  __resetCellRegistryForTests();
  registerCell(AGENT_GOAL_CELL as CellSpec);
});

function sourcesFor(goals: Record<string, HolderGoalRecord>, keys: string[] = []): HolderContextSources {
  return {
    holderGoal: async (holder) => goals[holder] ?? null,
    holderAssumptionKeys: async () => keys,
  };
}

describe('P-012: the friction path and the claim-read path render the SAME holder goal', () => {
  const GOAL: HolderGoalRecord = {
    itemId: 'WI-900',
    intent: 'shipping the parser',
    competing: ['WI-500', 'WI-777'],
  } as HolderGoalRecord;

  /**
   * THE DIFF THE ITEM ASKS FOR. Same holder, same reader, same sources, same clock —
   * a refusal surface and an ordinary list read must not disagree about what the
   * holder is doing. This is the assertion that would catch a lens that quietly
   * gained a field, or a friction point that resolved against different sources.
   */
  it('a friction refusal and a work-item list row agree field-for-field', async () => {
    const friction = await resolveHolderAdvisory({
      holder: 'su-holder',
      reader,
      subjectRef: 'WI-500',
      nowMs: NOW,
      sources: sourcesFor({ 'su-holder': GOAL }),
    });

    const [row] = await attachHolderContext(
      [{ id: 'WI-500', assignee: 'su-holder', state: 'open' } as never],
      reader,
      { nowMs: NOW, sources: sourcesFor({ 'su-holder': GOAL }) },
    );

    expect(friction).not.toBeNull();
    expect((row as { holder?: unknown }).holder).toBeDefined();
    // Byte-for-byte: both are rendered against the SAME subject (WI-500), so even
    // D-094's subtraction must land identically.
    expect((row as { holder?: unknown }).holder).toEqual(friction);
  });

  /**
   * ⚠ THE ONE PERMITTED DIFFERENCE, PINNED SO IT CANNOT GROW. D-094 subtracts the
   * SUBJECT from `competing`, so two surfaces rendering the same holder against
   * DIFFERENT subjects legitimately differ — in `competing` and nowhere else. A test
   * that simply deep-equals everything would be wrong here, and a test that skipped
   * the comparison would miss a real divergence; this asserts the difference is
   * exactly the subtraction.
   */
  it('different subjects differ ONLY by the D-094 subtraction', async () => {
    const sources = sourcesFor({ 'su-holder': GOAL });
    const onFiveHundred = await resolveHolderAdvisory({ holder: 'su-holder', reader, subjectRef: 'WI-500', nowMs: NOW, sources });
    const onSevenSevenSeven = await resolveHolderAdvisory({ holder: 'su-holder', reader, subjectRef: 'WI-777', nowMs: NOW, sources });

    expect(onFiveHundred?.competing).toEqual(['WI-777']);
    expect(onSevenSevenSeven?.competing).toEqual(['WI-500']);

    // Every OTHER field is identical — the goal does not change because a different
    // peer collided with it.
    const { competing: _a, ...restA } = onFiveHundred!;
    const { competing: _b, ...restB } = onSevenSevenSeven!;
    expect(restA).toEqual(restB);

    // ...and the un-subtracted holder-level fact is the common ancestor of both.
    expect(forSubject(onFiveHundred!, null).goalRef).toBe('WI-900');
  });

  /**
   * The LIST path renders one holder across several rows, and each row subtracts its
   * OWN id. This is D-094's multi-row case — the one P-030 shipped wrong on 3 of 18
   * live rows — asserted here as a PARITY property: every row must equal what the
   * friction path would have produced for that same subject.
   */
  it('every list row equals what the friction path would render for that row subject', async () => {
    const rows = await attachHolderContext(
      [
        { id: 'WI-500', assignee: 'su-holder', state: 'open' },
        { id: 'WI-777', assignee: 'su-holder', state: 'open' },
      ] as never[],
      reader,
      { nowMs: NOW, sources: sourcesFor({ 'su-holder': GOAL }) },
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const expected = await resolveHolderAdvisory({
        holder: 'su-holder',
        reader,
        subjectRef: (row as { id: string }).id,
        nowMs: NOW,
        sources: sourcesFor({ 'su-holder': GOAL }),
      });
      expect((row as { holder?: unknown }).holder).toEqual(expected);
      // The row never names ITSELF as the holder's rival.
      expect((row as { holder: { competing: string[] } }).holder.competing).not.toContain((row as { id: string }).id);
    }
  });

  /**
   * Parity must hold in the DEGRADED direction too, and this is the case a
   * happy-path fixture never reaches: an unreadable holder must be ABSENT on every
   * surface identically (D-056). If one surface rendered a partial and another
   * rendered nothing, a reader could infer the existence of state it may not read by
   * diffing two surfaces — the probe oracle the indistinguishability rule forbids.
   */
  it('a holder with nothing disclosable is absent on BOTH surfaces, identically', async () => {
    const empty = sourcesFor({});
    const friction = await resolveHolderAdvisory({ holder: 'su-holder', reader, subjectRef: 'WI-500', nowMs: NOW, sources: empty });
    const [row] = await attachHolderContext(
      [{ id: 'WI-500', assignee: 'su-holder', state: 'open' } as never],
      reader,
      { nowMs: NOW, sources: empty },
    );

    expect(friction).toBeNull();
    expect((row as { holder?: unknown }).holder).toBeUndefined();
  });

  /**
   * The fan-out used by the LIST surfaces resolves once per DISTINCT holder and
   * projects per row — so a holder appearing on many rows must still agree with the
   * single-resolution friction path. This is the property that makes "resolve once,
   * project per subject" safe to share.
   */
  it('the map fan-out agrees with the single-holder path for the same subject', async () => {
    const sources = sourcesFor({ 'su-holder': GOAL });
    const map = await resolveHolderAdvisoryMap(['su-holder', 'su-holder'], reader, { nowMs: NOW, sources });
    const single = await resolveHolderAdvisory({ holder: 'su-holder', reader, subjectRef: 'WI-500', nowMs: NOW, sources });

    expect(map.forRow('su-holder', 'WI-500')).toEqual(single);
    expect(map.omitted.size).toBe(0);
  });
});
