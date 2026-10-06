import { describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePlanStatus,
  flipPlanFrontmatterStatus,
  launchAcceptanceGraderForGate,
  shouldEvaluateAcceptanceGate,
  tidyFilingsForTerminalPlan,
  type TerminalPlanTidyDeps,
} from './set-plan-status';
import setPlanStatusTool from './set-plan-status';
import { ACCEPTANCE_GRADING_SWEEP_ACTOR } from '../../acceptance-grader';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('set-plan-status public lifecycle guidance', () => {
  it('documents the completion audit gate for shipped and done', () => {
    const publicGuidance = [
      setPlanStatusTool.description,
      setPlanStatusTool.guidance?.when,
      setPlanStatusTool.guidance?.chaining,
    ].join('\n');

    expect(publicGuidance).toContain('shipped');
    expect(publicGuidance).toContain('`done`');
    expect(publicGuidance).toContain("plans:audit { phase:'completion'");
    expect(publicGuidance).toContain('AFTER implementation');
    expect(publicGuidance).toContain('as-built');
    expect(publicGuidance).toContain('peer grade');
  });

  it('documents the dropped plan-status alias', () => {
    expect(setPlanStatusTool.description).toContain('`dropped` maps to the terminal `superseded` status');
  });

  it('projects the post-implementation authoring contract to both agent clients', () => {
    for (const clientDoc of ['AGENTS.md', 'CLAUDE.md']) {
      const projected = readFileSync(resolve(ROOT, clientDoc), 'utf8');
      expect(projected).toContain('## Every plan ships with a graded acceptance rubric');
      expect(projected).toContain('After implementation is verified:');
    }
  });

  it('warns that a rubric revision invalidates independent grading as well as attestation', () => {
    const revisionWarning =
      'Any later rubric edit invalidates BOTH the attestation AND any independent grading';
    const staleWarning = 'Any later rubric edit invalidates the attestation.';

    for (const clientDoc of ['AGENTS.md', 'CLAUDE.md']) {
      const projected = readFileSync(resolve(ROOT, clientDoc), 'utf8');
      expect(projected).toContain(revisionWarning);
      expect(projected).not.toContain(staleWarning);
    }
  });
});

describe('set-plan-status idempotent-completion opt-in (EI-21122694679454626)', () => {
  it('declares idempotent:true so a committed-but-slow flip is reported as success', () => {
    expect((setPlanStatusTool as { idempotent?: boolean }).idempotent).toBe(true);
  });
});

describe('set-plan-status acceptance-grader launch deadline', () => {
  it('covers the bounded headless judge launch path so its outcome reaches the recruiter', () => {
    expect((setPlanStatusTool as { timeoutSec?: number }).timeoutSec).toBe(90);
  });
});

// Caller-DX (watchdog P-006): plans:set-plan-status previously zod-REJECTED the
// status words agents reach for ('active' from old plans, 'done' confused with the
// item-status verb). Now they are accepted + mapped to the canonical settable form,
// echoing `mappedFrom`, so the confusing reject (vs plans:set-status) stops recurring.
describe('normalizePlanStatus (P-006)', () => {
  it('maps the legacy/confused aliases to canonical, reporting mappedFrom', () => {
    expect(normalizePlanStatus('active')).toEqual({ status: 'ready', mappedFrom: 'active' });
    expect(normalizePlanStatus('done')).toEqual({ status: 'shipped', mappedFrom: 'done' });
    expect(normalizePlanStatus('dropped')).toEqual({ status: 'superseded', mappedFrom: 'dropped' });
  });

  it('accepts dropped in the public status schema', () => {
    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'dropped',
      expectedCurrent: 'draft',
    }).success).toBe(true);
  });

  it('passes a canonical status through with no mappedFrom', () => {
    for (const s of ['draft', 'ready', 'shipped', 'superseded']) {
      expect(normalizePlanStatus(s)).toEqual({ status: s });
    }
  });
});

describe('set-plan-status expectedCurrent vocabulary', () => {
  it('accepts the derived awaiting-acceptance lifecycle state as a guard', () => {
    const parsed = setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'shipped',
      expectedCurrent: 'awaiting-acceptance',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('set-plan-status BAR proof metadata force', () => {
  it('accepts the reasoned waiver only for a shipped target', () => {
    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'shipped',
      force: { reason: 'BAR proof metadata is stale; recorded evidence remains reviewable.', acceptanceBarProofMetadata: true },
    }).success).toBe(true);

    expect(setPlanStatusTool.args.safeParse({
      harness: 'papercusp',
      slug: 'plan-a',
      status: 'superseded',
      force: { reason: 'reason', acceptanceBarProofMetadata: true },
    }).success).toBe(false);
  });
});

describe('set-plan-status terminal repair gate (WI-38303)', () => {
  it('skips the completion gate for an explicit shipped→shipped repair replay', () => {
    expect(shouldEvaluateAcceptanceGate('shipped', 'shipped')).toBe(false);
  });

  it('keeps the completion gate for a real transition into shipped', () => {
    expect(shouldEvaluateAcceptanceGate('shipped', 'ready')).toBe(true);
    expect(shouldEvaluateAcceptanceGate('shipped')).toBe(true);
  });

  it('never applies the completion gate to non-shipped targets', () => {
    expect(shouldEvaluateAcceptanceGate('superseded')).toBe(false);
  });
});

// Sanity that mapped targets write their canonical plan-level status.
describe('flipPlanFrontmatterStatus with mapped aliases', () => {
  it.each([
    ['active', 'ready'],
    ['dropped', 'superseded'],
  ])('writes the canonical target for %s', (alias, canonical) => {
    const body = '---\ntitle: T\nstatus: draft\n---\n\n# Body\n';
    const { status } = normalizePlanStatus(alias);
    expect(status).toBe(canonical);
    const flip = flipPlanFrontmatterStatus(body, status, 'draft');
    expect(flip.oldStatus).toBe('draft');
    expect(flip.newBody).toContain(`status: ${canonical}`);
    expect(flip.code).toBeUndefined();
  });
});

describe('launchAcceptanceGraderForGate (D-006)', () => {
  it.each(['acceptance_ungraded', 'self_graded_only'])('launches once for %s', async (code) => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    const result = await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'sidestage',
      launch as never,
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-test',
      harnessSlug: 'sidestage',
      // No attributable caller in this ctx → nothing to carry (EI-24402913315950329).
      acceptanceShipperOwnerId: null,
      // WI-10003286: both recruiting codes mean the gate found no admissible grading.
      acceptanceGateFoundNoAdmissibleGrading: true,
      uiClientId: null,
      isSuperuser: false,
      isPowerUser: false,
      principal: {
        kind: 'system',
        slug: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        workspaceId: 'ws-test',
      },
      ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
      ownerLabel: 'acceptance grading sweep',
      userId: null,
    });
    expect(result?.state).toBe('launched');
  });

  /**
   * EI-24402913315950329. The system-actor rewrite is for launch LINEAGE; it must
   * not also erase WHO shipped. The real caller rides through as
   * `acceptanceShipperOwnerId` so the recruiter's D-009 shipper exclusion keeps
   * the implementer-shipper (and, by party collapse, its forks) off the menu.
   */
  it('carries the real ship-gate caller through the system-actor rewrite as an exclusion input', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'acceptance_ungraded' },
      { workspaceId: 'ws-test', isSuperuser: true, uiClientId: 'su-implementer-shipper' } as never,
      'papercusp',
      launch as never,
    );
    expect(launch).toHaveBeenCalledWith(
      'plan-a',
      expect.objectContaining({
        ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        acceptanceShipperOwnerId: 'su-implementer-shipper',
      }),
    );
  });

  // WI-10003286: a self_graded_only refusal that names the independent card its BAR
  // judged cohort-stale must hand that id to the recruiter, whose settlement read would
  // otherwise count the stale card as "settled" and never dispatch the fresh grading.
  it('carries the cohort-stale independent card from a self_graded_only refusal to the recruiter', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'self_graded_only', staleGradingScorecardId: 'EI-stale-independent' },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'papercusp',
      launch as never,
    );
    expect(launch).toHaveBeenCalledWith(
      'plan-a',
      expect.objectContaining({ acceptanceStaleGradingScorecardId: 'EI-stale-independent' }),
    );
  });

  // WI-10003286 (second half): the gate excludes the named card AND every older
  // independent card predating it. Carrying only the named id let the recruiter's
  // settlement read fall back to the older excluded card and report "settled".
  it('carries EVERY cohort-stale independent card the gate excluded, not just the named one', async () => {
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      idempotencyKey: 'acceptance-grader:key',
      label: 'acceptance-grader:rubric:key',
    }));
    await launchAcceptanceGraderForGate(
      'plan-a',
      {
        satisfied: false,
        code: 'self_graded_only',
        staleGradingScorecardId: 'EI-stale-independent',
        staleGradingScorecardIds: ['EI-stale-independent', 'EI-older-independent'],
      },
      { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as never,
      'papercusp',
      launch as never,
    );
    const ctx = (launch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(ctx.acceptanceStaleGradingScorecardId).toBe('EI-stale-independent');
    expect([...(ctx.acceptanceStaleGradingScorecardIds as string[])].sort()).toEqual([
      'EI-older-independent',
      'EI-stale-independent',
    ]);
    // The gate's verdict (no admissible independent grading) must reach the recruiter so
    // its identity-free settlement read cannot answer "settled" over it.
    expect(ctx.acceptanceGateFoundNoAdmissibleGrading).toBe(true);
  });

  it('does not recruit a judge for unrelated acceptance failures', async () => {
    const launch = vi.fn();
    const result = await launchAcceptanceGraderForGate(
      'plan-a',
      { satisfied: false, code: 'acceptance_unaudited' },
      {} as never,
      undefined,
      launch as never,
    );
    expect(result).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('tidyFilingsForTerminalPlan — the terminal-plan tidy-up wiring (WI-10004531)', () => {
  type MockedDeps = { [K in keyof TerminalPlanTidyDeps]: Mock<TerminalPlanTidyDeps[K]> };
  function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
    const deps: MockedDeps = {
      retire: vi.fn<TerminalPlanTidyDeps['retire']>(async () => 'acceptance-plan-a'),
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({ settled: ['WI-R1'], failed: [] })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: 'WI-A1',
      })),
      ...overrides,
    };
    return deps;
  }
  const base = {
    slug: 'plan-a',
    ownerId: () => 'su-shipper',
    scope: { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
  };

  it('a changed ship retires the rubric, settles reservations and closes the activation filing', async () => {
    const deps = makeDeps();

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(deps.retire).toHaveBeenCalledWith('plan-a', 'su-shipper', {
      harnessSlug: 'papercusp',
      terminalStatus: 'shipped',
    });
    expect(deps.settle).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      terminalStatus: 'shipped',
    });
    expect(deps.reconcileActivationRepair).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      terminalStatus: 'shipped',
    });
    expect(out).toEqual({
      acceptanceRubricRetired: 'acceptance-plan-a',
      acceptanceReviewReservations: { settled: ['WI-R1'], failed: [] },
      activationAuditRepair: { conditionKey: 'activation-audit:papercusp/plan-a', closed: 'WI-A1' },
    });
  });

  it('a repeat (unchanged) ship touches nothing and never resolves the caller identity', async () => {
    const deps = makeDeps();
    const ownerId = vi.fn(() => 'su-shipper');

    const out = await tidyFilingsForTerminalPlan({ ...base, ownerId, status: 'shipped', changed: false }, deps);

    expect(out).toEqual({});
    expect(ownerId).not.toHaveBeenCalled();
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('superseded tidies even when unchanged, repairing older terminal rows', async () => {
    const deps = makeDeps();

    await tidyFilingsForTerminalPlan({ ...base, status: 'superseded', changed: false }, deps);

    expect(deps.retire).toHaveBeenCalledTimes(1);
    expect(deps.settle.mock.calls[0]?.[1]).toMatchObject({ terminalStatus: 'superseded' });
    expect(deps.reconcileActivationRepair.mock.calls[0]?.[0]).toMatchObject({ terminalStatus: 'superseded' });
  });

  it.each(['active', 'ready', 'awaiting-acceptance', 'draft'])('non-terminal status %s is a no-op', async (status) => {
    const deps = makeDeps();

    await expect(tidyFilingsForTerminalPlan({ ...base, status, changed: true }, deps)).resolves.toEqual({});
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.settle).not.toHaveBeenCalled();
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('a throwing settle is reported on the result and does not stop the activation close', async () => {
    const deps = makeDeps({
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => {
        throw new Error('pg down');
      }),
    });

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(out.acceptanceReviewReservations).toEqual({ error: 'pg down' });
    expect(out.activationAuditRepair).toMatchObject({ closed: 'WI-A1' });
  });

  it('omits keys with nothing to report: no live rubric, empty settlement, no open activation filing', async () => {
    const deps = makeDeps({
      retire: vi.fn<TerminalPlanTidyDeps['retire']>(async () => null),
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({ settled: [], failed: [] })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: null,
      })),
    });

    await expect(tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps)).resolves.toEqual({});
  });

  it('surfaces a failed settlement row and a failed activation close', async () => {
    const deps = makeDeps({
      settle: vi.fn<TerminalPlanTidyDeps['settle']>(async () => ({
        settled: [],
        failed: [{ id: 'WI-R2', error: 'gate refused' }],
      })),
      reconcileActivationRepair: vi.fn<TerminalPlanTidyDeps['reconcileActivationRepair']>(async () => ({
        conditionKey: 'activation-audit:papercusp/plan-a',
        closed: null,
        error: 'writer unavailable',
      })),
    });

    const out = await tidyFilingsForTerminalPlan({ ...base, status: 'shipped', changed: true }, deps);

    expect(out.acceptanceReviewReservations).toEqual({ settled: [], failed: [{ id: 'WI-R2', error: 'gate refused' }] });
    expect(out.activationAuditRepair).toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      closed: null,
      error: 'writer unavailable',
    });
  });

  it('without a harness: skips the harness-keyed activation close and passes null to the settle', async () => {
    const deps = makeDeps();

    await tidyFilingsForTerminalPlan(
      { ...base, scope: { workspaceId: 'ws-1', harnessSlug: null }, status: 'shipped', changed: true },
      deps,
    );

    expect(deps.retire.mock.calls[0]?.[2]).toEqual({ terminalStatus: 'shipped' });
    expect(deps.settle.mock.calls[0]?.[1]).toMatchObject({ harnessSlug: null });
    expect(deps.reconcileActivationRepair).not.toHaveBeenCalled();
  });

  it('the handler routes its terminal tidy-up through this helper (no inline copy)', () => {
    const source = readFileSync(resolve(ROOT, 'packages/operator-core/lib/agent-tools/plans/set-plan-status.ts'), 'utf8');
    const handlerCalls = source.match(/await tidyFilingsForTerminalPlan\(\{/g) ?? [];
    expect(handlerCalls).toHaveLength(1);
    expect(source).toContain('...terminalTidy,');
    // The helper is the only caller of each dependency inside this module.
    expect(source.match(/await settleAcceptanceReviewReservationsForPlan\(/g) ?? []).toHaveLength(0);
    expect(source.match(/await retireAcceptanceRubricForPlan\(/g) ?? []).toHaveLength(0);
  });
});
