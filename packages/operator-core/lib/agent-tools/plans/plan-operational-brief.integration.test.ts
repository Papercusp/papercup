/**
 * OP-BRIEF-P007-PLAN integration layer: plans:get { operationalBrief:true }
 * against a real Postgres plan row. The brief must agree with the plan state
 * in the SAME payload (next item, its status and phase), report blockers only
 * from a complete item graph, and keep a missing baseline (no audit, no
 * acceptance rubric) explicit rather than zero.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import plansGetTool from './get';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plan-brief-${RUN}`;
const PLAN = `plan-operational-brief-${RUN}`;

const PLAN_CONTENT = `---
title: Plan operational brief integration
slug: ${PLAN}
status: active
---

# Plan operational brief integration

## Now

State: proving the plan brief.

Next: P-002.

## Work

- **P-001** \`done\` — Build the core.
- **P-002** \`todo\` — Build the brief. blocked-by: P-001
- **P-003** \`todo\` — Verify the brief. blocked-by: P-002

## Decisions

### D-001 — Briefs are projections

Date: 2026-09-22

Project from existing plan state only.
`;

// Blocked-item fixture: every remaining item is blocked, so the brief must
// report a blocked next item — never promote one to "actionable".
const BLOCKED_PLAN = `plan-operational-brief-blocked-${RUN}`;
const BLOCKED_PLAN_CONTENT = `---
title: Plan operational brief blocked fixture
slug: ${BLOCKED_PLAN}
status: active
---

# Plan operational brief blocked fixture

## Now

State: waiting on an external dependency.

Next: P-001.

## Work

- **P-001** \`blocked\` — Wait for the dependency.
- **P-002** \`todo\` — Build on the dependency. blocked-by: P-001
`;

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-plan-operational-brief-integration',
  workspaceId: 'default',
  harnessSlug: HARNESS,
  metadata: vi.fn(),
  log: vi.fn(),
  progress: vi.fn(),
} as never;

type Field = { status: 'known'; value: unknown; source: string } | { status: 'unknown'; reason: string };
type BriefResult = {
  items: Array<{ id: string; effectiveStatus: string; phase: string | null }>;
  operationalBrief?: {
    schemaVersion: string;
    blockers: Field;
    lastVerified: Field;
    nextAction: Field;
    unknowns: string[];
    text: string;
    facts: { nextItem: Field; phase: Field; acceptance: Field; authority: Field };
  };
};

let fx: PlanPgFixture;
let previousWorkspaceId: string | undefined;

beforeAll(async () => {
  previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture();
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, PLAN, PLAN_CONTENT);
}, 60_000);

afterAll(async () => {
  if (fx) await cleanupPlans(fx.admin, fx.workspaceId, HARNESS).catch(() => {});
  if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  await fx?.dispose();
});

async function read(args: Record<string, unknown>): Promise<BriefResult> {
  const out = (await plansGetTool.handler({ slug: PLAN, harness: HARNESS, ...args } as never, CTX)) as {
    data: { results: BriefResult[] };
  };
  return out.data.results[0]!;
}

describe('plans:get operationalBrief (real PG)', () => {
  it('omits the brief unless requested', async () => {
    const result = await read({});
    expect(result.operationalBrief).toBeUndefined();
  });

  it('agrees with the same read on next item, status and phase, and keeps a missing baseline explicit', async () => {
    const result = await read({ operationalBrief: true });
    const brief = result.operationalBrief!;
    expect(brief.schemaVersion).toBe('operational-brief-v1');

    expect(brief.facts.nextItem).toMatchObject({ status: 'known', value: { id: 'P-002', reason: 'actionable' } });
    const next = brief.facts.nextItem.status === 'known' ? (brief.facts.nextItem.value as { id: string; effectiveStatus: string }) : null;
    const planItem = result.items.find((item) => item.id === next?.id);
    expect(next?.effectiveStatus).toBe(planItem?.effectiveStatus);
    if (planItem?.phase) {
      expect(brief.facts.phase).toMatchObject({ status: 'known', value: planItem.phase });
    } else {
      expect(brief.facts.phase.status).toBe('unknown');
    }

    expect(brief.blockers).toMatchObject({ status: 'known', value: ['P-003 blocked by P-002'] });
    expect(brief.facts.authority).toMatchObject({ status: 'known', value: { decisionCount: 1 } });
    expect(brief.lastVerified.status).toBe('unknown');
    expect(brief.facts.acceptance.status).toBe('unknown');
    expect(brief.unknowns).toEqual(expect.arrayContaining(['lastVerified', 'facts.acceptance']));
    expect(brief.text).toContain('next: Start P-002');
  });

  it('refuses plan-wide blockers from a narrowed items selection', async () => {
    const result = await read({ operationalBrief: true, items: ['P-002'] });
    expect(result.operationalBrief!.blockers.status).toBe('unknown');
    expect(result.operationalBrief!.facts.nextItem).toMatchObject({ status: 'known', value: { id: 'P-002' } });
  });
});
