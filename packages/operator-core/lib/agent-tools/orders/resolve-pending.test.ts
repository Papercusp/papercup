/**
 * resolve-pending.test.ts — proof for AUTO-BAR-R-5-P-001 of plan
 * `turn-start-memory-two-class-2026-09-21`:
 *
 *   "A dismissal submitted with an absent or empty reason is refused and
 *    leaves the directive in the state it already had."
 *
 * WHY THIS FILE EXISTS. The rule was implemented but unproven: the refusal
 * lives in the `orders:resolve-pending` TOOL HANDLER, while
 * `dismissOwnerDirective` underneath it does no reason validation at all and
 * will happily write an empty reason if called directly. So the whole of R-5
 * rests on one boundary check, and nothing failed if that check were deleted.
 *
 * THE TWO HALVES ARE TESTED SEPARATELY, BECAUSE THEY FAIL SEPARATELY.
 *  - "refused" is observable on the returned envelope (ok:false,
 *    error:'reason_required', isError:true).
 *  - "leaves the directive in the state it already had" is NOT observable
 *    there — it is the absence of a write. Asserting only the error message
 *    would still pass if the handler dismissed the row and then reported an
 *    error, which is precisely the regression that would matter. So every
 *    refusal case also asserts `dismissOwnerDirective` was never called.
 *
 * THE LOAD-BEARING CASE IS WHITESPACE, NOT EMPTY. A reason of four spaces
 * SATISFIES the `z.string().min(4)` schema and would reach a handler that
 * trusted its schema. Only the handler's own `.trim()` check rejects it. A
 * test that covered '' alone would pass against a handler with the trim
 * removed, so it would not be a test of this rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  promoteOwnerDirective: vi.fn(),
  dismissOwnerDirective: vi.fn(),
  directiveActionVerdict: vi.fn(async () => ({ allowed: true as const, because: 'addressee' as const })),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-test-owner' })),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return {
    ...actual,
    promoteOwnerDirective: h.promoteOwnerDirective,
    dismissOwnerDirective: h.dismissOwnerDirective,
  };
});

// P-008 added an ownership rail AHEAD of both writers: promote/dismiss now ask
// `directiveActionVerdict` whether this caller may act on the directive at all.
// That helper is a REAL Postgres read, so without this seam every case below
// that reaches a writer dies on the unit-test live-DB guard
// (EI-19311807188719573) — a failure about database access, in a file whose
// subject is the reason rule. Stubbed ALLOWED on purpose: the refusal side is
// the subject of resolve-pending-foreign-directive.test.ts, and duplicating it
// here would make two files fail for one regression while this one's own rule
// went untested.
vi.mock('../../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directive-agenda')>();
  return { ...actual, directiveActionVerdict: h.directiveActionVerdict };
});

vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});

const tool = (await import('./resolve-pending')).default;

const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

/** The envelope shape this tool returns: JSON in content[0].text. */
function envelopeOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return (await tool.handler(args as never, CTX)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
}

describe('orders:resolve-pending — dismissal requires a reason (AUTO-BAR-R-5-P-001)', () => {
  beforeEach(() => {
    h.promoteOwnerDirective.mockReset();
    h.dismissOwnerDirective.mockReset();
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });
    h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test-owner' });
  });

  it.each([
    ['absent', undefined],
    ['empty string', ''],
    ['whitespace that SATISFIES the min(4) schema', '    '],
    ['a tab', '\t\t\t\t'],
  ])('refuses a dismissal whose reason is %s, and writes nothing', async (_label, reason) => {
    const args: Record<string, unknown> = { id: 17, action: 'dismiss' };
    if (reason !== undefined) args.reason = reason;

    const result = await call(args);

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toEqual({ ok: false, error: 'reason_required' });

    // The half that the error message cannot prove: no state was touched.
    expect(
      h.dismissOwnerDirective,
      'a refused dismissal must not reach the writer — the directive keeps the state it already had',
    ).not.toHaveBeenCalled();
    expect(h.promoteOwnerDirective).not.toHaveBeenCalled();
  });

  it('accepts a real reason, and passes it TRIMMED to the writer', async () => {
    h.dismissOwnerDirective.mockResolvedValue({ ok: true, row: { id: 17 } });

    const result = await call({ id: 17, action: 'dismiss', reason: '  not a directive, just a greeting  ' });

    expect(result.isError).toBeUndefined();
    expect(h.dismissOwnerDirective).toHaveBeenCalledWith({
      id: 17,
      reason: 'not a directive, just a greeting',
      dismissedBy: 'su-test-owner',
    });
  });

  it('promote needs no reason and never reaches the dismiss writer', async () => {
    h.promoteOwnerDirective.mockResolvedValue({ ok: true, row: { id: 17 } });

    const result = await call({ id: 17, action: 'promote' });

    expect(result.isError).toBeUndefined();
    // Kept as an EXACT call-shape assertion (not objectContaining): it is the only thing
    // that fails when an argument is added or dropped here, which is exactly how the
    // promote-note gap below went unnoticed. `note: null` is the explicit "no note given".
    expect(h.promoteOwnerDirective).toHaveBeenCalledWith({ id: 17, promotedBy: 'su-test-owner', note: null });
    expect(h.dismissOwnerDirective).not.toHaveBeenCalled();
  });

  // P-005 / D-014: the plan's single un-waived gap. `reason` was accepted by the schema for
  // BOTH actions, but the promote branch called the writer with only { id, promotedBy } —
  // so a note given with action:'promote' validated and was then SILENTLY DROPPED. No test
  // covered it because the only promote assertion used the no-reason call.
  it('passes a promotion reason through to the writer as the note, TRIMMED', async () => {
    h.promoteOwnerDirective.mockResolvedValue({ ok: true, row: { id: 17 } });

    const result = await call({ id: 17, action: 'promote', reason: '  acting on this now  ' });

    expect(result.isError).toBeUndefined();
    expect(h.promoteOwnerDirective).toHaveBeenCalledWith({
      id: 17,
      promotedBy: 'su-test-owner',
      note: '  acting on this now  ',
    });
    expect(h.dismissOwnerDirective).not.toHaveBeenCalled();
  });

  it('surfaces a writer refusal as isError instead of reporting a false success', async () => {
    // not_pending is the real race: two agents resolving the same row.
    h.dismissOwnerDirective.mockResolvedValue({ ok: false, error: 'not_pending' });

    const result = await call({ id: 17, action: 'dismiss', reason: 'already handled elsewhere' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toMatchObject({ ok: false, error: 'not_pending' });
  });
});

describe('orders:resolve-pending — schema layer (AUTO-BAR-R-5-P-001)', () => {
  it('rejects a reason shorter than the minimum before the handler runs', () => {
    expect(tool.args.safeParse({ id: 17, action: 'dismiss', reason: '' }).success).toBe(false);
    expect(tool.args.safeParse({ id: 17, action: 'dismiss', reason: 'ok' }).success).toBe(false);
  });

  it('CALIBRATION: the schema alone does NOT enforce this rule', () => {
    // If this ever starts failing, the schema has been tightened and the
    // handler's trim check may look redundant — it is not: read the four-space
    // case above before deleting it.
    expect(tool.args.safeParse({ id: 17, action: 'dismiss', reason: '    ' }).success).toBe(true);
  });

  it('accepts a well-formed dismissal', () => {
    expect(tool.args.safeParse({ id: 17, action: 'dismiss', reason: 'a real reason' }).success).toBe(true);
  });
});
