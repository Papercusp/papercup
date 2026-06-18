import { describe, expect, it } from 'vitest';
import { normalizePlanStatus, flipPlanFrontmatterStatus } from './set-plan-status';

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
