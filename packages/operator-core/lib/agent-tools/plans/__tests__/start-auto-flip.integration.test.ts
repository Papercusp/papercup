/**
 * start-auto-flip.integration.test.ts — plans:start auto-approves a draft (P2-3).
 *
 * Starting a plan IS the approval signal: a still-`draft` plan has its
 * frontmatter auto-advanced to `ready` (best-effort, inside withPlanLock), and
 * the start result reports `autoApproved: true`. start-guard.test.ts stubs
 * withPlanLock to a no-op, so it never exercises the flip — this drives the REAL
 * flip against Postgres via the shared baseline-schema fixture.
 *
 * Covers:
 *   - draft start → frontmatter reads `ready`, autoApproved:true;
 *   - re-start (now ready) → autoApproved:false, no second flip;
 *   - a non-draft (ready) start → autoApproved:false, frontmatter unchanged.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/start-auto-flip.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import type { PlanPgFixture } from './_pg-tool-fixture';

// WI-5825: plans:start resolves its write key through resolvePlanScope — the SAME
// authority its plan READ uses — not the ambient activeWorkspaceId(). Pin the resolver
// to what this fixture seeds under, rather than depending on the real machine's
// harness registry / workspace-registry file.
vi.mock('../source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: DEFAULT_WORKSPACE_ID,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

// P-047 (retire-mug-kettle-su-only-2026-08-09): plans:start's op_status write is
// gated on the Mug/Kettle retirement flag, whose default is OFF. This suite is
// about the AUTO-APPROVE half, which survives the retirement untouched — so pin
// the tier ON here rather than rewrite assertions that are not about the gate.
// The retired shape (no op_status write, promotion still runs) is pinned in
// start-guard.test.ts, and the surviving auto-approve is re-asserted at the foot
// of this file with the tier OFF, so neither half can regress unnoticed.
// vi.hoisted, not a plain const: vi.mock factories are hoisted above module-scope
// declarations, so a bare const read inside one is a TDZ hazard.
const MUG_KETTLE = vi.hoisted(() => ({ on: true }));
vi.mock('../../../pot/started', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../pot/started')>();
  return { ...actual, mugKettleSystemEnabled: async () => MUG_KETTLE.on };
});

// This fixture targets the real draft→ready body write and revision spine, not
// the lifecycle/admission contracts that every production start must satisfy.
// Keep those unrelated doors deterministic, matching start-guard.test.ts; the
// Postgres-backed withPlanLock below remains real and is the subject under test.
const START_GATES = vi.hoisted(() => ({
  activation: vi.fn(),
  admission: vi.fn(),
  claimSpec: vi.fn(),
}));
vi.mock('../plan-activation-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-activation-gate')>();
  return {
    ...actual,
    evaluateConversationActivationGate: (...args: unknown[]) => START_GATES.activation(...args),
  };
});
vi.mock('../plan-admission-preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan-admission-preflight')>();
  return {
    ...actual,
    preflightExactPlanAdmission: (...args: unknown[]) => START_GATES.admission(...args),
  };
});
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: vi.fn(async () => ({ promoted: 0, skipped: 0, flagOff: false, workItems: [] })),
}));
vi.mock('../../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    setClaimSpec: (...args: unknown[]) => START_GATES.claimSpec(...args),
  };
});

// Import AFTER the mock is declared (vi.mock is hoisted, but these pull in `start`,
// which resolves the scope at call time, not at import time — either ordering works;
// kept dynamic for symmetry with the mock-then-import convention elsewhere).
const startTool = (await import('../start')).default;
const { setupPlanPgFixture, cleanupPlans, seedPlan } = await import('./_pg-tool-fixture');

const HARNESS = `zzz-start-flip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-start-flip-plan-2026-06-16';
const WS = DEFAULT_WORKSPACE_ID;

function planBody(status: 'draft' | 'ready'): string {
  return `---
title: Auto-Approve Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: ${status}
---

# Auto-Approve Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose for the body.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-start-flip-test', workspaceId: WS },
  } as never;
}

async function runStart(): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  // Bulk-pattern tools return a structured `{ data: { ok, results, counts } }`
  // envelope (../_bulk bulkContent) — the per-slug result is data.results[0], and
  // a failure shows as counts.failed > 0 (no legacy `content[0].text` / isError).
  // This fixture isolates the draft→ready write and revision spine; explicitly
  // override the unrelated live-peer checkpoint consult so fleet liveness cannot
  // turn the deterministic auto-flip assertion into a consult_available refusal.
  const res = (await startTool.handler({
    harness: HARNESS,
    slug: SLUG,
    consulted: false,
    consult_reason: 'auto-flip integration fixture isolates revisioned approval write',
  } as never, makeCtx())) as {
    data: { results: Record<string, unknown>[]; counts?: { failed?: number } };
  };
  return { data: res.data.results[0], isError: (res.data.counts?.failed ?? 0) > 0 };
}

async function frontmatterStatus(): Promise<string | null> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  const content = rows[0]?.content ?? '';
  const m = /^status:[ \t]*([A-Za-z][\w-]*)/m.exec(content.split('\n---')[0] ?? '');
  return m?.[1] ?? null;
}

async function revisionRows(): Promise<Array<{ seq: number; content_hash: string; content_snapshot: string; rationale: string | null }>> {
  return admin<Array<{ seq: number; content_hash: string; content_snapshot: string; rationale: string | null }>>`
    SELECT seq, content_hash, content_snapshot, rationale
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
     ORDER BY seq
  `;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  START_GATES.activation.mockReset();
  START_GATES.activation.mockResolvedValue({ satisfied: true, auditSeq: 1 });
  START_GATES.admission.mockReset();
  START_GATES.admission.mockResolvedValue({
    ready: true,
    status: 'ready',
    reason: 'ready',
    message: 'exact-plan admission fixture override',
  });
  START_GATES.claimSpec.mockReset();
  START_GATES.claimSpec.mockResolvedValue({ ok: true, errors: [], revision: 1 });
});

describe('plans:start — draft auto-approve (P2-3)', () => {
  it('starting a DRAFT plan flips its frontmatter to ready and reports autoApproved:true', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));
    expect(await frontmatterStatus()).toBe('draft');

    const { data, isError } = await runStart();
    expect(isError).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: true, transitioned: true });

    // The real withPlanLock flip landed: the frontmatter now reads ready.
    expect(await frontmatterStatus()).toBe('ready');

    // The approval write is a canonical plan-body mutation, so it must leave a
    // revision spine row for activation audits/BAR pinning to resolve.
    await expect(revisionRows()).resolves.toEqual([
      expect.objectContaining({
        seq: 1,
        rationale: 'plans:start → auto-approve draft',
        content_snapshot: expect.stringContaining('status: ready'),
      }),
    ]);
  });

  it('re-starting the now-ready plan does NOT flip again (autoApproved:false)', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));
    const first = await runStart();
    expect(first.data.autoApproved).toBe(true);
    expect(await frontmatterStatus()).toBe('ready');

    const second = await runStart();
    expect(second.isError).toBe(false);
    // Already ready → expectedCurrent:'draft' makes the flip a no-op.
    expect(second.data.autoApproved).toBe(false);
    // Idempotent re-start: op_status was already started → not a transition.
    expect(second.data.transitioned).toBe(false);
    expect(await frontmatterStatus()).toBe('ready');
    // The idempotent re-start performs no body write and must not append a
    // duplicate revision.
    expect(await revisionRows()).toHaveLength(1);
  });

  it('starting a plan that is ALREADY ready does not auto-approve', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('ready'));
    expect(await frontmatterStatus()).toBe('ready');

    const { data, isError } = await runStart();
    expect(isError).toBe(false);
    expect(data).toMatchObject({ status: 'started', autoApproved: false, transitioned: true });
    // Frontmatter untouched — it was never a draft.
    expect(await frontmatterStatus()).toBe('ready');
  });
});

/**
 * P-047 — the same auto-approve, with the OPERATIONAL axis retired.
 *
 * The retirement gates the op_status WRITE, not the verb (D-010): approval and
 * promotion are what a user actually starts a plan for, and they must survive.
 * The unit suite pins the SQL shape; this pins the real end-to-end effect
 * against Postgres, because "the frontmatter flip still lands" is a claim about
 * a withPlanLock write no mocked-tx assertion can make.
 */
describe('plans:start — draft auto-approve survives the retired op_status axis (P-047)', () => {
  beforeEach(() => {
    MUG_KETTLE.on = false;
  });
  afterAll(() => {
    MUG_KETTLE.on = true;
  });

  it('flips draft→ready and reports the retirement, without ever writing op_status', async () => {
    await seedPlan(admin, WS, HARNESS, SLUG, planBody('draft'));

    const { data, isError } = await runStart();
    expect(isError).toBe(false);
    // The approval half is untouched...
    expect(data).toMatchObject({ autoApproved: true, opStatusRetired: true });
    expect(await frontmatterStatus()).toBe('ready');
    // ...and the operational half never happened — asserted against the ROW, not
    // the tool's own report, so a handler that lied could not pass this.
    expect(data).toMatchObject({ status: null, transitioned: false });
    const rows = await admin<{ op_status: string | null }[]>`
      SELECT op_status FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(rows[0]?.op_status ?? null).toBeNull();
  });
});
