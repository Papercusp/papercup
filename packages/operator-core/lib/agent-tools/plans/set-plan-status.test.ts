import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePlanStatus,
  flipPlanFrontmatterStatus,
  launchAcceptanceGraderForGate,
  shouldEvaluateAcceptanceGate,
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

// Sanity that the mapped target actually flips the frontmatter (active→ready writes ready).
describe('flipPlanFrontmatterStatus with mapped alias', () => {
  it('writes the canonical target from a mapped alias', () => {
    const body = '---\ntitle: T\nstatus: draft\n---\n\n# Body\n';
    const { status } = normalizePlanStatus('active'); // → ready
    const flip = flipPlanFrontmatterStatus(body, status, 'draft');
    expect(flip.oldStatus).toBe('draft');
    expect(flip.newBody).toContain('status: ready');
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
