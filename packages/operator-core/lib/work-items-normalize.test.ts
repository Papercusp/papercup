/**
 * work-items-normalize.test.ts — pure unit coverage for normalizeWorkItemState,
 * the cross-dialect lifecycle mapper (EI-24) that folds the agent-facing lifecycle
 * vocabulary onto the ONE unified work-item enum.
 *
 * work-item-status-full-unify (P-003 writer-flip): BOTH families now normalize to the
 * unified enum (open | wip | blocked | needs-human | done | dropped). The issue family no
 * longer collapses the in-flight states to `open` (EI-450 is fixed at the root — there is
 * no engineer_issues status CHECK, so blocked/wip/needs-human store directly); the feature
 * family stores unified instead of the legacy feature dialect. db-org is mocked defensively
 * so this stays a pure, PG-free unit test (the function itself touches no PG).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { normalizeWorkItemState } = await import('./work-items');

describe('normalizeWorkItemState — issue family', () => {
  // Writer-flip: the in-flight states now STORE directly (no collapse to `open`).
  it.each([
    ['open', 'open'],
    ['todo', 'open'],
    ['wip', 'wip'],
    ['in_progress', 'wip'],
    ['blocked', 'blocked'],
    ['needs-human', 'needs-human'],
    ['needs_human', 'needs-human'],
  ])('maps in-flight state %s → %s', (state, expected) => {
    expect(normalizeWorkItemState('issue', state)).toEqual({ ok: true, state: expected });
  });

  it.each([
    ['done', 'done'],
    ['passed', 'done'],
    ['resolved', 'done'],
    ['dropped', 'dropped'],
    ['deprecated', 'dropped'],
    ['closed', 'dropped'],
  ])('maps terminal state %s → %s', (state, expected) => {
    expect(normalizeWorkItemState('issue', state)).toEqual({ ok: true, state: expected });
  });

  it('refuses a genuinely-unknown state, listing the unified accepted set', () => {
    const res = normalizeWorkItemState('issue', 'banana');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // The advertised valid set must include the unified enum it actually accepts —
    // a drifted list (EI-450's original symptom) is itself the bug.
    for (const accepted of ['open', 'wip', 'blocked', 'needs-human', 'done', 'dropped']) {
      expect(res.valid).toContain(accepted);
    }
  });
});

describe('normalizeWorkItemState — feature family', () => {
  // Writer-flip: the feature family now stores the UNIFIED enum. Legacy feature dialect +
  // canonical/drift spellings fold to unified; a truly-unknown state is rejected (the typo guard).
  it.each([
    ['done', 'done'],
    ['resolved', 'done'],
    ['passed', 'done'],
    ['dropped', 'dropped'],
    ['closed', 'dropped'],
    ['deprecated', 'dropped'],
    ['open', 'open'],
    ['todo', 'open'],
    ['failing', 'open'],
    ['blocked', 'blocked'],
    ['wip', 'wip'],
    ['in_progress', 'wip'],
    ['validating', 'wip'],
    ['needs-human', 'needs-human'],
    // drift-variant + case normalization
    ['in-progress', 'wip'],
    ['In_Progress', 'wip'],
    ['needs_human', 'needs-human'],
    ['TODO', 'open'],
  ])('maps %s → %s', (state, expected) => {
    expect(normalizeWorkItemState('feature', state)).toEqual({ ok: true, state: expected });
  });

  it('rejects a truly-unknown feature state with the valid set', () => {
    const res = normalizeWorkItemState('feature', 'some-novel-pipeline-phase');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.valid).toContain('wip');
  });
});
