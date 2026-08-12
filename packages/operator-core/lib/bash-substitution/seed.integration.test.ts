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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { loadPairFixtures } from './corpus';
import { MIN_POPULATION_ATOMS, MIN_POPULATION_SESSIONS, MIN_SAMPLE_SIZE } from './equivalence';
import { promoteEarnedRows, seedSubstitutionRegistry } from './seed';
import { BASH_GATE_PAIRS } from './pairs';
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
      fixtures: loadPairFixtures(BASH_GATE_PAIRS),
      client: db.adminSql,
    });

    expect(outcomes).toHaveLength(BASH_GATE_PAIRS.length);
    expect(outcomes.every((o) => o.inserted)).toBe(true);

    const rows = (await db.adminSql`
      SELECT intent_label, tool_name, equivalence_verdict, tier, advisory_text,
             sample_size, baseline_calls, baseline_sessions
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${WORKSPACE}
       ORDER BY intent_label
    `) as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(BASH_GATE_PAIRS.length);
    for (const row of rows) {
      expect(row.advisory_text).toBeTruthy();
      // The frozen population count feeds Phase 5's before/after measurement.
      expect(Number(row.baseline_calls)).toBeGreaterThan(0);

      const pair = BASH_GATE_PAIRS.find((candidate) => candidate.intentLabel === row.intent_label);
      expect(pair, `${String(row.intent_label)} has no source pair`).toBeDefined();

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
      if (pair?.policyTier !== undefined && pair.expectedVerdict === 'unaudited') {
        // D-003 policy rows are enforced by an independent pre-existing rule,
        // not by an equivalence verdict. They must still seed when their
        // evidence is below the audit floor, and must remain explicitly honest
        // about that lack of a derived verdict.
        expect(row.equivalence_verdict).toBe('unaudited');
        expect(Number(row.sample_size)).toBeLessThan(MIN_SAMPLE_SIZE);
      } else {
        expect(
          bySample || byCensus,
          `${String(row.intent_label)} is thin evidence: sample=${String(row.sample_size)} ` +
            `population=${String(row.baseline_calls)} atoms / ${String(row.baseline_sessions)} sessions`,
        ).toBe(true);
      }

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

  it('seeds a below-floor policy row as unaudited instead of deriving a verdict', async () => {
    const pair = BASH_GATE_PAIRS.find((candidate) => candidate.policyTier !== undefined)!;
    const fixture = loadPairFixtures([pair])[0].fixture;
    expect(pair.expectedVerdict).toBe('unaudited');
    expect(fixture.sample.length).toBeLessThan(MIN_SAMPLE_SIZE);

    const workspace = `${WORKSPACE}-policy-regression`;
    const [outcome] = await seedSubstitutionRegistry({
      workspaceId: workspace,
      fixtures: [{ pair, fixture }],
      client: db.adminSql,
    });

    expect(outcome).toMatchObject({
      intentLabel: pair.intentLabel,
      verdict: 'unaudited',
      sampleSize: fixture.sample.length,
      inserted: true,
    });

    const [row] = (await db.adminSql`
      SELECT equivalence_verdict, tier, sample_size
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${workspace} AND intent_label = ${pair.intentLabel}
    `) as unknown as Array<{ equivalence_verdict: string; tier: string; sample_size: number }>;
    expect(row).toEqual({ equivalence_verdict: 'unaudited', tier: pair.policyTier, sample_size: fixture.sample.length });
  });

  it('seeds an authorized policy row AT its declared tier, and re-asserts it on conflict', async () => {
    // The policy tier is pair-owned, not earned from an observation window, so —
    // unlike an ordinary row's tier — re-seeding must re-assert it. Otherwise a
    // row seeded BEFORE the declaration sits at `observe` forever and the policy
    // is enforced nowhere, which is this file's whole reason for existing.
    const policyPairs = BASH_GATE_PAIRS.filter((p) => p.policyTier !== undefined);
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
      fixtures: loadPairFixtures(BASH_GATE_PAIRS),
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
    // `unaudited` is an honest absence of a derived verdict, not a failing
    // audit. Only derived non-equivalent verdicts must carry failure evidence;
    // the below-floor policy row intentionally stores an empty array.
    const nonEquivalent = BASH_GATE_PAIRS.filter(
      (p) => p.expectedVerdict !== 'equivalent' && p.expectedVerdict !== 'unaudited',
    );
    for (const pair of nonEquivalent) {
      const row = rows.find((r) => r.intent_label === pair.intentLabel);
      expect(row, `${pair.id} was not seeded`).toBeDefined();
      expect(Number(row!.len), `${pair.id} must name its failing cases`).toBeGreaterThan(0);
    }
  });

  it('re-seeding UPDATES in place rather than duplicating a rule', async () => {
    const again = await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(BASH_GATE_PAIRS),
      client: db.adminSql,
    });
    expect(again.every((o) => o.inserted)).toBe(false);

    const [{ count }] = (await db.adminSql`
      SELECT count(*)::int AS count FROM harness_shared.bash_tool_substitutions WHERE workspace_id = ${WORKSPACE}
    `) as unknown as Array<{ count: number }>;
    expect(count).toBe(BASH_GATE_PAIRS.length);
  });

  it('freezes the population baselines when re-seeding with new fixture totals', async () => {
    const pair = BASH_GATE_PAIRS.find(
      (candidate) => candidate.policyTier === undefined && candidate.expectedVerdict === 'equivalent',
    )!;
    const { fixture } = loadPairFixtures([pair])[0];
    const workspace = `${WORKSPACE}-baseline-regression`;
    const refreshedFixture = {
      ...fixture,
      totalAtoms: fixture.totalAtoms + 100,
      totalSessions: fixture.totalSessions + 10,
    };

    await seedSubstitutionRegistry({
      workspaceId: workspace,
      fixtures: [{ pair, fixture }],
      client: db.adminSql,
    });

    const [first] = (await db.adminSql`
      SELECT baseline_calls, baseline_sessions
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${workspace} AND intent_label = ${pair.intentLabel}
    `) as unknown as Array<{ baseline_calls: number; baseline_sessions: number }>;
    expect(first).toBeDefined();

    await seedSubstitutionRegistry({
      workspaceId: workspace,
      fixtures: [{ pair, fixture: refreshedFixture }],
      client: db.adminSql,
    });

    const [second] = (await db.adminSql`
      SELECT baseline_calls, baseline_sessions
        FROM harness_shared.bash_tool_substitutions
       WHERE workspace_id = ${workspace} AND intent_label = ${pair.intentLabel}
    `) as unknown as Array<{ baseline_calls: number; baseline_sessions: number }>;

    expect(Number(second.baseline_calls)).toBe(fixture.totalAtoms);
    expect(Number(second.baseline_sessions)).toBe(fixture.totalSessions);
    expect(Number(second.baseline_calls)).not.toBe(refreshedFixture.totalAtoms);
    expect(Number(second.baseline_sessions)).not.toBe(refreshedFixture.totalSessions);
  });

  it('never demotes a rule that an observation window already promoted', async () => {
    // Simulate P-020 promoting one rule to `advise` after its window.
    const target = BASH_GATE_PAIRS[0].intentLabel;
    await db.adminSql`
      UPDATE harness_shared.bash_tool_substitutions
         SET tier = 'advise', false_positive_count = 3
       WHERE workspace_id = ${WORKSPACE} AND intent_label = ${target}
    `;

    await seedSubstitutionRegistry({
      workspaceId: WORKSPACE,
      fixtures: loadPairFixtures(BASH_GATE_PAIRS),
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

  describe('promoteEarnedRows (P-020 staged promotion)', () => {
    beforeEach(async () => {
      // Clean baseline: every earned row back to `observe` with no
      // false-positive evidence. A POLICY tier is deliberately left alone — it
      // is declared by the pair, not earned from an observation window (D-039),
      // so promotion must never be the thing that sets or clears it.
      await db.adminSql`
        UPDATE harness_shared.bash_tool_substitutions
           SET tier = CASE WHEN tier = 'deny' THEN tier ELSE 'observe' END,
               false_positive_count = 0,
               promoted_at = NULL
         WHERE workspace_id = ${WORKSPACE}
      `;
    });

    it('promotes only rows whose replacement is PROVEN equivalent, and stamps promoted_at', async () => {
      const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE, apply: true, client: db.adminSql });

      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes.every((o) => o.from === 'observe' && o.to === 'advise')).toBe(true);

      const rows = (await db.adminSql`
        SELECT intent_label, tier, equivalence_verdict, promoted_at
          FROM harness_shared.bash_tool_substitutions
         WHERE workspace_id = ${WORKSPACE}
      `) as unknown as Array<{
        intent_label: string;
        tier: string;
        equivalence_verdict: string;
        promoted_at: Date | null;
      }>;

      const heldLabels = new Set(
        BASH_GATE_PAIRS.filter((p) => p.holdAtObserve !== undefined).map((p) => p.intentLabel),
      );

      for (const r of rows) {
        if (r.intent_label.startsWith(POLICY_INTENT_PREFIX)) {
          // A declared policy row is not promotion's business in either direction.
          expect(r.tier).toBe('deny');
          continue;
        }
        if (heldLabels.has(r.intent_label)) {
          // `equivalent` but pinned to the staging tier by its own pair (D-011).
          expect(r.tier).toBe('observe');
          continue;
        }
        if (r.equivalence_verdict === 'equivalent') {
          expect(r.tier).toBe('advise');
          expect(r.promoted_at).not.toBeNull();
        } else {
          // D-001: a pattern whose replacement is unproven may never be
          // enforced, however long it has sat in the registry.
          expect(r.tier).toBe('observe');
          expect(r.promoted_at).toBeNull();
        }
      }
    });

    it('a filed false positive pauses that row’s promotion', async () => {
      // P-020's safety valve: "Any agent may file a false-positive against a row
      // and that pauses its promotion." Worth nothing if it lives only in prose.
      const target = BASH_GATE_PAIRS.find((p) => p.expectedVerdict === 'equivalent')!.intentLabel;
      await db.adminSql`
        UPDATE harness_shared.bash_tool_substitutions
           SET false_positive_count = 1
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${target}
      `;

      const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE, apply: true, client: db.adminSql });
      expect(outcomes.some((o) => o.intentLabel === target)).toBe(false);

      const [row] = (await db.adminSql`
        SELECT tier FROM harness_shared.bash_tool_substitutions
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${target}
      `) as unknown as Array<{ tier: string }>;
      expect(row.tier).toBe('observe');
    });

    it('never promotes a pair that holds itself at observe, whatever its verdict', async () => {
      const heldPairs = BASH_GATE_PAIRS.filter((p) => p.holdAtObserve !== undefined);
      expect(heldPairs.length).toBeGreaterThan(0); // D-011's git-read row

      const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE, apply: true, client: db.adminSql });

      for (const p of heldPairs) {
        expect(outcomes.some((o) => o.intentLabel === p.intentLabel && o.to === 'advise')).toBe(false);
        const [row] = (await db.adminSql`
          SELECT tier FROM harness_shared.bash_tool_substitutions
           WHERE workspace_id = ${WORKSPACE} AND intent_label = ${p.intentLabel}
        `) as unknown as Array<{ tier: string }>;
        expect(row.tier).toBe('observe');
      }
    });

    it('DEMOTES a held row that has drifted above observe (the D-042 regression)', async () => {
      // The exact incident: a verdict-only promotion swept the held git-read row
      // into `advise`. Declining to promote it next time is not enough — nothing
      // else in the system ever demotes, so the drift would be permanent.
      const held = BASH_GATE_PAIRS.find((p) => p.holdAtObserve !== undefined)!;
      await db.adminSql`
        UPDATE harness_shared.bash_tool_substitutions
           SET tier = 'advise', promoted_at = now()
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${held.intentLabel}
      `;

      const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE, apply: true, client: db.adminSql });
      expect(outcomes).toContainEqual(
        expect.objectContaining({ intentLabel: held.intentLabel, from: 'advise', to: 'observe' }),
      );

      const [row] = (await db.adminSql`
        SELECT tier, promoted_at FROM harness_shared.bash_tool_substitutions
         WHERE workspace_id = ${WORKSPACE} AND intent_label = ${held.intentLabel}
      `) as unknown as Array<{ tier: string; promoted_at: Date | null }>;
      expect(row.tier).toBe('observe');
      expect(row.promoted_at).toBeNull();
    });

    it('is a DRY RUN unless apply is passed — reports the eligible set, changes nothing', async () => {
      const outcomes = await promoteEarnedRows({ workspaceId: WORKSPACE, client: db.adminSql });
      expect(outcomes.length).toBeGreaterThan(0);

      const [{ promoted }] = (await db.adminSql`
        SELECT count(*)::int AS promoted
          FROM harness_shared.bash_tool_substitutions
         WHERE workspace_id = ${WORKSPACE} AND tier = 'advise'
      `) as unknown as Array<{ promoted: number }>;
      expect(Number(promoted)).toBe(0);
    });
  });

  it('refuses to seed a verdict the harness does not re-derive', async () => {
    // The anti-drift latch: a pair whose recorded verdict disagrees with what
    // its sample computes must never reach the table, because D-001's gate
    // would then rest on a claim no evidence supports.
    const [{ pair, fixture }] = loadPairFixtures([BASH_GATE_PAIRS[0]]);
    const lying = { ...pair, expectedVerdict: 'not-a-substitute' as const };

    await expect(
      seedSubstitutionRegistry({ workspaceId: WORKSPACE, fixtures: [{ pair: lying, fixture }], client: db.adminSql }),
    ).rejects.toThrow(/envelope and the evidence disagree/);
  });
});
