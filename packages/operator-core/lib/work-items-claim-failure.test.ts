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

  it('EI-21921431863111143: a TRUNCATED-prefix assignee is self-held (gated), not a live peer conflict', () => {
    // The exact repro: assignee stored as the 11-char prefix of the caller's own
    // full su-<uuid> ownerId.
    expect(
      classifyClaimFailure({ assignee: 'su-4408713d' }, 'su-4408713d-7181-47d5-b249-0e006b69ed65'),
    ).toEqual({ reason: 'gated', holder: null });
    // Padding around the truncated prefix is still tolerated.
    expect(
      classifyClaimFailure({ assignee: '  su-4408713d  ' }, 'su-4408713d-7181-47d5-b249-0e006b69ed65'),
    ).toEqual({ reason: 'gated', holder: null });
  });

  it('EI-21921431863111143: the prefix match is directional — a caller impersonating a longer stored holder is still a conflict', () => {
    // The reverse shape (caller's own id is SHORTER than, and a prefix of, the
    // stored holder) is NOT self-held — that would let a short/truncated caller
    // identity match against an unrelated longer holder id.
    expect(classifyClaimFailure({ assignee: 'su-4408713d-xyz' }, 'su-4408713d')).toEqual({
      reason: 'conflict',
      holder: 'su-4408713d-xyz',
    });
  });

  it('EI-21921431863111143: a holder that shares NO common prefix with the caller is still a conflict', () => {
    expect(classifyClaimFailure({ assignee: 'su-3bd530b3' }, 'su-4408713d-7181-47d5-b249-0e006b69ed65')).toEqual({
      reason: 'conflict',
      holder: 'su-3bd530b3',
    });
  });

  it('EI-15027: a literal "unassigned" sentinel assignee reads as unclaimed (gated), never as a live holder', () => {
    // Repro: WI-5303 had assignee:"unassigned" (some federated/legacy writer's "not
    // taken" placeholder instead of NULL/'') and work_items:claim reported
    // claim_conflict against holder:"unassigned" — permanently unclaimable.
    expect(classifyClaimFailure({ assignee: 'unassigned' }, 'me')).toEqual({ reason: 'gated', holder: null });
    // Case/whitespace-insensitive, mirroring EI-7939's normalizeTakenBy for the
    // feature-family taken_by column.
    expect(classifyClaimFailure({ assignee: 'Unassigned' }, 'me')).toEqual({ reason: 'gated', holder: null });
    expect(classifyClaimFailure({ assignee: '  UNASSIGNED  ' }, 'me')).toEqual({ reason: 'gated', holder: null });
    // A real holder whose id merely CONTAINS "unassigned" as a substring is still a
    // real, different holder — only an exact (trimmed, case-insensitive) match to the
    // sentinel is treated as unclaimed.
    expect(classifyClaimFailure({ assignee: 'su-unassigned-1' }, 'me')).toEqual({
      reason: 'conflict',
      holder: 'su-unassigned-1',
    });
  });
});
