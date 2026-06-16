/**
 * work-items-normalize.test.ts — pure unit coverage for normalizeWorkItemState,
 * the cross-dialect lifecycle mapper (EI-24) that translates the canonical
 * agent-facing lifecycle vocabulary onto each family's native states.
 *
 * Regression guard for EI-450: agents drive work-items with the canonical
 * dialect (in_progress/wip/blocked/needs-human), but the issue family's CHECK
 * only knows open/resolved/closed. The "active" states must MAP to `open`, never
 * throw a structural refusal. db-org is mocked defensively so this stays a pure,
 * PG-free unit test (the function itself touches no PG).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { normalizeWorkItemState } = await import('./work-items');

describe('normalizeWorkItemState — issue family', () => {
  // EI-450: every "active / in-flight" canonical state collapses to `open`
  // rather than throwing the structural refusal.
  it.each(['in_progress', 'wip', 'blocked', 'needs-human', 'todo'])(
    'maps active state %s → open',
    (state) => {
      expect(normalizeWorkItemState('issue', state)).toEqual({ ok: true, state: 'open' });
    },
  );

  it.each([
    ['done', 'resolved'],
    ['passed', 'resolved'],
    ['resolved', 'resolved'],
    ['dropped', 'closed'],
    ['deprecated', 'closed'],
    ['closed', 'closed'],
    ['open', 'open'],
  ])('maps settled/native state %s → %s', (state, expected) => {
    expect(normalizeWorkItemState('issue', state)).toEqual({ ok: true, state: expected });
  });

  it('refuses a genuinely-unknown state, listing the accepted dialect', () => {
    const res = normalizeWorkItemState('issue', 'banana');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // The advertised valid set must include the states it actually accepts —
    // a drifted list (EI-450's original symptom) is itself the bug.
    for (const accepted of ['in_progress', 'wip', 'blocked', 'needs-human']) {
      expect(res.valid).toContain(accepted);
    }
  });
});

describe('normalizeWorkItemState — feature family', () => {
  // Feature-family passes through un-restricted beyond its aliases (hfc.status
  // carries no CHECK) — so blocked/in_progress survive verbatim there.
  it.each([
    ['done', 'passed'],
    ['resolved', 'passed'],
    ['dropped', 'deprecated'],
    ['closed', 'deprecated'],
    ['open', 'todo'],
    ['blocked', 'blocked'],
    ['in_progress', 'in_progress'],
    ['validating', 'validating'],
  ])('maps %s → %s', (state, expected) => {
    expect(normalizeWorkItemState('feature', state)).toEqual({ ok: true, state: expected });
  });
});
