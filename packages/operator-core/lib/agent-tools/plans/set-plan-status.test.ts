import { describe, expect, it, vi } from 'vitest';
import {
  normalizePlanStatus,
  flipPlanFrontmatterStatus,
  launchAcceptanceGraderForGate,
} from './set-plan-status';
import setPlanStatusTool from './set-plan-status';

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
    expect(publicGuidance).toContain('peer-graded acceptance rubric');
  });
});

describe('set-plan-status idempotent-completion opt-in (EI-21122694679454626)', () => {
  it('declares idempotent:true so a committed-but-slow flip is reported as success', () => {
    expect((setPlanStatusTool as { idempotent?: boolean }).idempotent).toBe(true);
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
    });
    expect(result?.state).toBe('launched');
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
