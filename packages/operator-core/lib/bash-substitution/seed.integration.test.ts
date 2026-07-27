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
import { MIN_POPULATION_ATOMS, MIN_POPULATION_SESSIONS, MIN_SAMPLE_SIZE } from './equivalence';
import { seedSubstitutionRegistry } from './seed';
import { ALL_PAIRS } from './pairs';
import { POLICY_INTENT_PREFIX } from './types';

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

    const rows = (await db.adminSql`
      SELECT intent_label, tool_name, equivalence_verdict, tier, advisory_text,
             sample_size, baseline_calls, baseline_sessions
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${WORKSPACE}
       ORDER BY intent_label
    `) as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(ALL_PAIRS.length);
    for (const row of rows) {
      expect(row.advisory_text).toBeTruthy();
      // The frozen population count feeds Phase 5's before/after measurement.
      expect(Number(row.baseline_calls)).toBeGreaterThan(0);

      // Evidence floor — assert the SAME two-branch admissibility `auditPair`
      // enforces, not just the sample branch of it. A HOMOGENEOUS intent carries
      // every spelling that exists rather than 20 distinct ones (`nproc` has 2,
      // `uptime` 1), and D-036 admits it on POPULATION instead. Asserting
      // `sample_size >= 20` alone re-imposed the pre-D-036 floor here and would
      // have failed for the P-026/P-027 rows too — it only surfaced with P-028
      // because this suite needs real PG and had not been run since.
      const bySample = Number(row.sample_size) >= MIN_SAMPLE_SIZE;
      const byCensus =
        Number(row.baseline_calls) >= MIN_POPULATION_ATOMS &&
        Number(row.baseline_sessions) >= MIN_POPULATION_SESSIONS;
      expect(
        bySample || byCensus,
        `${String(row.intent_label)} is thin evidence: sample=${String(row.sample_size)} ` +
          `population=${String(row.baseline_calls)} atoms / ${String(row.baseline_sessions)} sessions`,
      ).toBe(true);

      // Rows land at `observe` no matter how good the verdict is — promotion is
      // P-020's staged decision, never an automatic consequence of a green audit.
      // The ONE exception is an authorized POLICY tier (D-003/D-039): a rule that
      // already existed independently has nothing to observe, so it is declared by
      // the pair and gated on the `policy-violation:` intent prefix.
      if (String(row.intent_label).startsWith(POLICY_INTENT_PREFIX)) {
        expect(row.tier).not.toBe('observe');
      } else {
        expect(row.tier).toBe('observe');
      }
    }
  });

  it('seeds an authorized policy row AT its declared tier, and re-asserts it on conflict', async () => {
    // The policy tier is pair-owned, not earned from an observation window, so —
    // unlike an ordinary row's tier — re-seeding must re-assert it. Otherwise a
    // row seeded BEFORE the declaration sits at `observe` forever and the policy
    // is enforced nowhere, which is this file's whole reason for existing.
    const policyPairs = ALL_PAIRS.filter((p) => p.policyTier !== undefined);
    expect(policyPairs.length).toBeGreaterThan(0);

    for (const pair of policyPairs) {
      expect(pair.intentLabel.startsWith(POLICY_INTENT_PREFIX)).toBe(true);
      await db.adminSql`
        UPDATE harness_shared.bash_tool_substitutions SET tier = 'observe'
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${pair.intentLabel}
      `;
    }

    await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(ALL_PAIRS),
      client: db.adminSql,
    });

    for (const pair of policyPairs) {
      const [row] = (await db.adminSql`
        SELECT tier FROM harness_shared.bash_tool_substitutions
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${pair.intentLabel}
      `) as unknown as Array<{ tier: string }>;
      expect(row?.tier).toBe(pair.policyTier);
    }
  });

  /**
   * The regression guard for a latent encoding bug P-008 was the first to reach
   * (2026-07-26). `failing_cases` is written through postgres-js, whose jsonb
   * parameter serializer DIFFERS between the drizzle-mutated canonical client
   * and the hand-rolled client this test builds — one passes a pre-stringified
   * string through, the other JSON.stringifies it AGAIN, storing the jsonb
   * SCALAR `"[{…}]"` instead of an array (see the note in seed.ts).
   *
   * It stayed invisible because every earlier pair audited `equivalent` and so
   * carried an EMPTY `failing_cases`, and the `verdict_evidence` CHECK
   * short-circuits on the verdict before it ever calls `jsonb_array_length` —
   * so the malformed value was never inspected. Asserting the STORED TYPE (not
   * merely that the insert succeeded) is what makes the bug catchable, because
   * the insert succeeds either way for an equivalent row.
   */
  it('stores failing_cases as a jsonb ARRAY, not a double-encoded scalar', async () => {
    const rows = (await db.adminSql`
      SELECT intent_label, jsonb_typeof(failing_cases) AS kind, jsonb_array_length(failing_cases) AS len
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${WORKSPACE}
    `) as unknown as Array<{ intent_label: string; kind: string; len: number }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.kind, `${row.intent_label} stored failing_cases as ${row.kind}`).toBe('array');
    }

    // And the point of storing them: a non-equivalent verdict must carry the
    // evidence that explains it, which is also the DB's own CHECK.
    const nonEquivalent = ALL_PAIRS.filter((p) => p.expectedVerdict !== 'equivalent');
    for (const pair of nonEquivalent) {
      const row = rows.find((r) => r.intent_label === pair.intentLabel);
      expect(row, `${pair.id} was not seeded`).toBeDefined();
      expect(Number(row!.len), `${pair.id} must name its failing cases`).toBeGreaterThan(0);
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
