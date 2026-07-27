/**
 * registry.integration.test.ts — P-018 / D-086 against REAL Postgres.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `conventions:governing` answered "what governs what I am about to do" with
 * ZERO plan decisions for every workspace-scoped caller — which is every psu
 * session on this box. The handler resolved `ctx.harnessSlug` to the sentinel
 * `'*'`, and the query compared it: `AND p.harness_slug = '*'` matches no plan
 * row, so half the answer vanished behind `ok:true` with no note.
 *
 * `registry.test.ts` is deliberately pure and stayed green throughout, because
 * every assertion there is about the SHAPE of a projection rather than about a
 * row ARRIVING. That is the same defect class as the fact
 * `required-field-collected-then-discarded` (6th instance) — so this file
 * applies the rule that class produced: **assert the value reads back from the
 * DESTINATION, against a real query, not that a helper was shaped right.**
 *
 * Run: npm run test:file -- packages/operator-core/lib/conventions/registry.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { ALL_HARNESSES, governingConventions } from './registry';

const WS = 'conv-governing-ws';
const HARNESS_A = 'conv-harness-a';
const HARNESS_B = 'conv-harness-b';
const OWNER = 'su-conv-reader';

let fx: BaselineCoordFixture;

/** One plan carrying one decision, under a named harness. */
async function seedPlan(
  harness: string,
  planSlug: string,
  decisionId: string,
  title: string,
  body: string,
): Promise<void> {
  await fx.admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, archived, decisions, updated_at)
    VALUES (${WS}, ${harness}, ${planSlug}, ${planSlug}, 'active', '', false,
            ${fx.admin.json([{ id: decisionId, title, body }] as never)}, now())`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.agent_facts WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
  await fx.admin`DELETE FROM harness_shared.agent_facts WHERE workspace_id = ${WS}`;
});

describe("D-086 R1 — harness '*' searches EVERY harness, never a harness named '*'", () => {
  const about = 'applying a database migration to the shared schema';

  it('THE BUG: a named harness finds the decision, and `*` used to find nothing', async () => {
    await seedPlan(
      HARNESS_A,
      'migrations-plan',
      'D-001',
      'Migrations go through the runner',
      'Apply every migration via the db:migrate runner, never a raw psql -f invocation.',
    );

    const named = await governingConventions({
      harness: HARNESS_A,
      about,
      scopeRefs: [OWNER, HARNESS_A],
      limit: 20,
      workspaceId: WS,
    });
    expect(named.counts.planDecisions).toBe(1);

    // The regression this file exists for: the SAME corpus, asked by a
    // workspace-scoped caller, must not silently come back empty.
    const starred = await governingConventions({
      harness: ALL_HARNESSES,
      about,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });
    expect(starred.counts.planDecisions).toBe(1);
    expect(starred.conventions.map((c) => c.id)).toContain('migrations-plan#D-001');
  });

  it('`*` spans harnesses — a decision under EITHER harness is returned', async () => {
    await seedPlan(HARNESS_A, 'plan-a', 'D-001', 'Migration runner rule', 'Use the db:migrate runner for migrations.');
    await seedPlan(HARNESS_B, 'plan-b', 'D-002', 'Migration numbering rule', 'Allocate the migration number atomically.');

    const out = await governingConventions({
      harness: ALL_HARNESSES,
      about,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });

    expect(out.counts.planDecisions).toBe(2);
    expect(out.conventions.map((c) => c.id).sort()).toEqual(['plan-a#D-001', 'plan-b#D-002']);
  });

  it('a NAMED harness still excludes the other one — widening `*` did not widen everything', async () => {
    await seedPlan(HARNESS_A, 'plan-a', 'D-001', 'Migration runner rule', 'Use the db:migrate runner for migrations.');
    await seedPlan(HARNESS_B, 'plan-b', 'D-002', 'Migration numbering rule', 'Allocate the migration number atomically.');

    const out = await governingConventions({
      harness: HARNESS_B,
      about,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });

    expect(out.counts.planDecisions).toBe(1);
    expect(out.conventions.map((c) => c.id)).toEqual(['plan-b#D-002']);
  });

  it('`*` NEVER crosses the workspace boundary — the tenant predicate is not the one being dropped', async () => {
    await seedPlan(HARNESS_A, 'plan-a', 'D-001', 'Migration runner rule', 'Use the db:migrate runner for migrations.');
    // Same harness + a matching decision, but a DIFFERENT tenant.
    await fx.admin`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, archived, decisions, updated_at)
      VALUES ('some-other-workspace', ${HARNESS_A}, 'foreign-plan', 'foreign', 'active', '', false,
              ${fx.admin.json([
                { id: 'D-009', title: 'Migration rule', body: 'Use the db:migrate runner for migrations.' },
              ] as never)}, now())`;

    const out = await governingConventions({
      harness: ALL_HARNESSES,
      about,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });

    expect(out.conventions.map((c) => c.id)).toEqual(['plan-a#D-001']);
    await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = 'some-other-workspace'`;
  });

  it('an ARCHIVED plan stays excluded under `*` — the other predicates survive the rewrite', async () => {
    await seedPlan(HARNESS_A, 'plan-a', 'D-001', 'Migration runner rule', 'Use the db:migrate runner for migrations.');
    await fx.admin`UPDATE harness_shared.harness_plans SET archived = true WHERE workspace_id = ${WS}`;

    const out = await governingConventions({
      harness: ALL_HARNESSES,
      about,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });

    expect(out.counts.planDecisions).toBe(0);
  });

  it('no `about` searches no decisions, under `*` exactly as under a named harness', async () => {
    await seedPlan(HARNESS_A, 'plan-a', 'D-001', 'Migration runner rule', 'Use the db:migrate runner for migrations.');

    const out = await governingConventions({
      harness: ALL_HARNESSES,
      about: null,
      scopeRefs: [OWNER],
      limit: 20,
      workspaceId: WS,
    });

    expect(out.counts.planDecisions).toBe(0);
  });
});
