/**
 * seed.integration.test.ts — the substitution registry seeder against real
 * Postgres (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 * What matters here is not "does an INSERT work" but the three properties the
 * enforcement gate rests on:
 *   1. rows are DERIVED from the committed fixtures, so the table cannot drift
 *      from the evidence (D-002);
 *   2. re-seeding UPDATES in place — a duplicate rule would fire twice on the
 *      same command and double the advisory noise;
 *   3. promotion state earned by an observation window survives a re-seed
 *      (P-020), so routine seeding can never silently demote a promoted rule.
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/bash-substitution/seed.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { loadPairFixtures } from './corpus';
import { seedSubstitutionRegistry } from './seed';
import { ALL_PAIRS } from './pairs';

const { createOrgTestDb } = await import('../../test/_org-test-db');

const WORKSPACE = 'seed-test-workspace';

describe('seedSubstitutionRegistry (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('seeds every audited pair, deriving the verdict from its committed sample', async () => {
    const outcomes = await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(ALL_PAIRS),
      client: db.adminSql,
    });

    expect(outcomes).toHaveLength(ALL_PAIRS.length);
    expect(outcomes.every((o) => o.inserted)).toBe(true);
    // Every sample must be a real one of at least the mandated size.
    expect(outcomes.every((o) => o.sampleSize >= 20)).toBe(true);

    const rows = (await db.adminSql`
      SELECT intent_label, tool_name, equivalence_verdict, tier, advisory_text, sample_size, baseline_calls
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${WORKSPACE}
       ORDER BY intent_label
    `) as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(ALL_PAIRS.length);
    for (const row of rows) {
      // Rows land at `observe` no matter how good the verdict is — promotion is
      // P-020's staged decision, never an automatic consequence of a green audit.
      expect(row.tier).toBe('observe');
      expect(row.advisory_text).toBeTruthy();
      expect(Number(row.sample_size)).toBeGreaterThanOrEqual(20);
      // The frozen population count feeds Phase 5's before/after measurement.
      expect(Number(row.baseline_calls)).toBeGreaterThan(0);
    }
  });

  it('re-seeding UPDATES in place rather than duplicating a rule', async () => {
    const again = await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(ALL_PAIRS),
      client: db.adminSql,
    });
    expect(again.every((o) => o.inserted)).toBe(false);

    const [{ count }] = (await db.adminSql`
      SELECT count(*)::int AS count FROM harness_shared.bash_tool_substitutions WHERE workspace_id = ${WORKSPACE}
    `) as unknown as Array<{ count: number }>;
    expect(count).toBe(ALL_PAIRS.length);
  });

  it('never demotes a rule that an observation window already promoted', async () => {
    // Simulate P-020 promoting one rule to `advise` after its window.
    const target = ALL_PAIRS[0].intentLabel;
    await db.adminSql`
      UPDATE harness_shared.bash_tool_substitutions
         SET tier = 'advise', false_positive_count = 3
       WHERE workspace_id = ${WORKSPACE} AND intent_label = ${target}
    `;

    await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(ALL_PAIRS),
      client: db.adminSql,
    });

    const [row] = (await db.adminSql`
      SELECT tier, false_positive_count
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${WORKSPACE} AND intent_label = ${target}
    `) as unknown as Array<{ tier: string; false_positive_count: number }>;

    // A routine re-seed must not undo promotion, nor erase the false-positive
    // evidence that would argue against keeping it promoted.
    expect(row.tier).toBe('advise');
    expect(Number(row.false_positive_count)).toBe(3);
  });

  it('refuses to seed a verdict the harness does not re-derive', async () => {
    // The anti-drift latch: a pair whose recorded verdict disagrees with what
    // its sample computes must never reach the table, because D-001's gate
    // would then rest on a claim no evidence supports.
    const [{ pair, fixture }] = loadPairFixtures([ALL_PAIRS[0]]);
    const lying = { ...pair, expectedVerdict: 'not-a-substitute' as const };

    await expect(
      seedSubstitutionRegistry({ workspaceId: WORKSPACE, fixtures: [{ pair: lying, fixture }], client: db.adminSql }),
    ).rejects.toThrow(/envelope and the evidence disagree/);
  });
});
