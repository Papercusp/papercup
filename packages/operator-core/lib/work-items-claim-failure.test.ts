/**
 * work-items-claim-failure.test.ts — pure unit coverage for classifyClaimFailure
 * (EI-2197).
 *
 * Regression guard: claimWorkItem / claimIssue return a bare `null` for THREE
 * distinct outcomes, and the claim tools used to flatten all three into the
 * single misleading message `work_item '<id>' not found`. That sent agents into
 * a futile retry-with-harness dance (the id WAS resolvable via get/observe/
 * comment/complete — only claim's compare-and-claim had lost) and hid the real
 * signal (a lost race / a dead claim to take over). This classifier names the
 * outcome from the re-read row so the tool returns an accurate, actionable error.
 *
 * db-org is mocked defensively so this stays a pure, PG-free unit test (the
 * function itself touches no PG — it reasons over an already-fetched row).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: vi.fn() }) }),
}));

const { classifyClaimFailure } = await import('./work-items');

describe('classifyClaimFailure (EI-2197)', () => {
  it('null row → not_found (the item genuinely does not exist)', () => {
    expect(classifyClaimFailure(null, 'me')).toEqual({ reason: 'not_found', holder: null });
  });

  it('held by ANOTHER agent → conflict, naming the holder (the EI-2197 / WI-291 case)', () => {
    // The exact scenario that produced the bogus "not found": the item exists and
    // resolves fine, but it is held by a (possibly dead) prior assignee.
    expect(classifyClaimFailure({ assignee: 'su-3bd530b3' }, 'su-05ae3')).toEqual({
      reason: 'conflict',
      holder: 'su-3bd530b3',
    });
  });

  it('held by the claimer themselves → gated, never a self-conflict (claim would have succeeded idempotently)', () => {
    expect(classifyClaimFailure({ assignee: 'me' }, 'me')).toEqual({ reason: 'gated', holder: null });
  });

  it('exists but unheld (empty/whitespace/null assignee) → gated (admission/trust gate or a release race)', () => {
    expect(classifyClaimFailure({ assignee: null }, 'me')).toEqual({ reason: 'gated', holder: null });
    expect(classifyClaimFailure({ assignee: '' }, 'me')).toEqual({ reason: 'gated', holder: null });
    expect(classifyClaimFailure({ assignee: '   ' }, 'me')).toEqual({ reason: 'gated', holder: null });
    expect(classifyClaimFailure({}, 'me')).toEqual({ reason: 'gated', holder: null });
  });

  it('trims surrounding whitespace before comparing holder vs claimer', () => {
    // A padded holder string is still a real, different holder.
    expect(classifyClaimFailure({ assignee: '  su-peer  ' }, 'me')).toEqual({
      reason: 'conflict',
      holder: 'su-peer',
    });
    // Padded but equal to the claimer → not a conflict.
    expect(classifyClaimFailure({ assignee: '  me  ' }, 'me')).toEqual({ reason: 'gated', holder: null });
  });
});
