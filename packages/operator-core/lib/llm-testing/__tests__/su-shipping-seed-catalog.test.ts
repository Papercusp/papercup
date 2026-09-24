/**
 * buildShippingSeedCatalog — the instrument R-6 needs
 * (deterministic-tool-definition-delivery-2026-09-21, D-019).
 *
 * WHAT THIS GUARDS. D-012 found that `llm-test --target su` builds its tools
 * array from `SU_CATALOG`, a hand-authored constant, so a delivery-tier A/B
 * over it does not measure the shipped surface. D-019 quantified the gap:
 * measured 2026-09-22, SU_CATALOG overlaps the claude shipping seed by 27 of
 * 63 — 32 of its entries are never delivered and 36 delivered tools are absent
 * from it.
 *
 * The fix is to source the offered NAMES from the generated delivery artifact
 * (the same file the launcher passes through as `PAPERCUSP_TOOLS_COMPACT`).
 * These tests pin the two properties that make the resulting A/B valid:
 *
 *  1. the offered set IS the shipping seed, not the curated constant; and
 *  2. the two arms offer the SAME set, so `toolDefinitionTier` is the only
 *     variable and DEFERRAL is constant across them by construction.
 *
 * Property 2 is the one worth stating out loud: it is why no arm needs to
 * simulate deferral. The ~836 undelivered tools are absent from both arms
 * either way.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildShippingSeedCatalog } from '../targets/su-compact-catalog';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated .mjs data module, no type declarations.
import { CLAUDE_TOOL_DELIVERY } from '../../../../../apps/operator/scripts/tool-delivery.generated.mjs';

/**
 * A seed this small means the artifact is empty or the registry did not
 * register — every assertion below would then pass VACUOUSLY over an empty
 * set. Calibration first, so a broken instrument is loud.
 */
const MIN_PLAUSIBLE_SEED = 40;

const artifactSeed = Object.keys(
  (CLAUDE_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers,
).sort();

describe('buildShippingSeedCatalog — the offered set is the SHIPPED set (D-019)', () => {
  beforeAll(async () => {
    // Side-effect import: registers the catalog the live-definition read walks.
    await import('../../agent-tools/index');
  });

  it('CALIBRATION: the artifact advertises a non-trivial seed, so the rest is not vacuous', () => {
    expect(artifactSeed.length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_SEED);
  });

  it('offers only names the delivery artifact says are DELIVERED', async () => {
    const built = await buildShippingSeedCatalog('full');
    const canonical = [...built.catalog.canonicalBySanitized.values()].sort();

    expect(canonical.length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_SEED);
    // Every offered name is a shipped name. A curated-constant regression
    // would drag in names like `blender:grade-idea` that ship nowhere.
    const notShipped = canonical.filter((n) => !artifactSeed.includes(n));
    expect(notShipped).toEqual([]);
  });

  it('reports its own coverage rather than implying the whole seed was live', async () => {
    const built = await buildShippingSeedCatalog('full');
    expect(built.coverage).toBeGreaterThan(0.85);
    expect(built.coverage).toBeLessThanOrEqual(1);
    // usedLive + missingFromLive must account for the entire seed — a
    // silently-dropped name would understate the gap.
    expect(built.usedLive.length + built.missingFromLive.length).toBe(built.seedNames.length);
    expect(built.seedNames).toEqual(artifactSeed);
  });

  it('holds the tool SET fixed across tiers, so the A/B varies only the tier', async () => {
    const full = await buildShippingSeedCatalog('full');
    const compact = await buildShippingSeedCatalog('compact');

    const fullNames = [...full.catalog.canonicalBySanitized.values()].sort();
    const compactNames = [...compact.catalog.canonicalBySanitized.values()].sort();

    // THE experimental-validity assertion. If these ever diverge, the arms
    // differ in availability as well as detail and the comprehension result
    // is uninterpretable.
    expect(compactNames).toEqual(fullNames);
    expect(compact.catalog.tools.length).toBe(full.catalog.tools.length);
  });

  it('actually compacts: the compact arm is strictly smaller on the same names', async () => {
    const full = await buildShippingSeedCatalog('full');
    const compact = await buildShippingSeedCatalog('compact');

    // Without this, a projection that silently no-ops would still satisfy
    // every assertion above while measuring nothing at all.
    expect(compact.bytes).toBeLessThan(full.bytes);
    expect(full.bytes).toBeGreaterThan(0);
  });

  it('D-046: the compact arm delivers a seed-FULL tool at FULL fidelity, not compacted', async () => {
    const seedFull = Object.entries(
      (CLAUDE_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers,
    )
      .filter(([, t]) => t === 'full')
      .map(([name]) => name);

    // The generated artifact currently may spend its whole byte budget on
    // compact definitions. Promote one real shipped name in this test so the
    // full-fidelity branch remains exercised without changing production policy.
    const promoted = seedFull.length > 0 ? seedFull : ['tools:invoke'];
    expect(artifactSeed).toEqual(expect.arrayContaining(promoted));
    const deliveryTiers = {
      ...(CLAUDE_TOOL_DELIVERY as { tiers: Record<string, string> }).tiers,
      ...Object.fromEntries(promoted.map((name) => [name, 'full'])),
    };

    const full = await buildShippingSeedCatalog('full', deliveryTiers);
    const compact = await buildShippingSeedCatalog('compact', deliveryTiers);
    const byCanonical = (built: Awaited<ReturnType<typeof buildShippingSeedCatalog>>) =>
      new Map(
        built.catalog.tools.map((t) => [
          built.catalog.canonicalBySanitized.get(t.name) ?? t.name,
          t,
        ]),
      );
    const fullByName = byCanonical(full);
    const compactByName = byCanonical(compact);

    for (const name of promoted) {
      const f = fullByName.get(name);
      const c = compactByName.get(name);
      if (!f || !c) continue; // absent from the live registry; coverage covers that
      // The whole point of D-046: over-compacting a tool the seed ships full
      // makes the arm deliver LESS than production, so the A/B can only
      // overstate the regression it is meant to measure.
      expect(c.description).toBe(f.description);
      expect(c.input_schema).toEqual(f.input_schema);
    }

    // …and the arm must still be compacting everything else, or this test
    // would also pass against a compact arm that had stopped compacting.
    expect(compact.bytes).toBeLessThan(full.bytes);
  });

  it('every offered definition is a legal Anthropic tool schema', async () => {
    for (const tier of ['full', 'compact'] as const) {
      const built = await buildShippingSeedCatalog(tier);
      for (const tool of built.catalog.tools) {
        expect(tool.input_schema).toBeTruthy();
        expect((tool.input_schema as { type?: unknown }).type).toBe('object');
        expect(tool.name).not.toContain(':');
      }
    }
  });
});
