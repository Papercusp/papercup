/**
 * disposition-foreign-directive.test.ts — the other half of P-008's write-side
 * rail (plan `directive-visibility-and-ownership-2026-09-22`, D-008).
 *
 * `orders:disposition` is the higher-stakes of the two guarded verbs and was
 * the one the rail originally missed. `done` / `declined` are claims ABOUT THE
 * OWNER'S ORDER, and closing a directive stops it rendering for EVERY session
 * in the workspace — so a wrong close is indistinguishable, afterwards, from
 * the owner's order having been carried out.
 *
 * IT IS BATCHED, WHICH IS WHERE THE INTERESTING BEHAVIOUR IS. The obvious
 * implementation refuses the whole call on one foreign id; that discards up to
 * 49 legitimate closes and tells the caller nothing about WHICH id was
 * foreign, so the natural recovery is to retry the same batch and fail again.
 * The rail is therefore PER ENTRY, and the mixed-batch case below is the test
 * that distinguishes the two implementations — a single-entry test cannot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispositionOwnerDirective: vi.fn(),
  directiveActionVerdict: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, dispositionOwnerDirective: h.dispositionOwnerDirective };
});

vi.mock('../../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directive-agenda')>();
  return { ...actual, directiveActionVerdict: h.directiveActionVerdict };
});

vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});

vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: h.activeWorkspaceId };
});

const tool = (await import('./disposition')).default;

const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

function envelopeOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }>; isError?: boolean };
}

type Result = { ok: boolean; id: number; error?: string; addressedTo?: string; holders?: string[]; hint?: string };

const FOREIGN = { allowed: false, addressedTo: 'su-theirs', holders: ['su-peer'] };
const MINE = { allowed: true, because: 'addressee' as const };

beforeEach(() => {
  h.dispositionOwnerDirective.mockReset();
  h.dispositionOwnerDirective.mockResolvedValue({ ok: true, row: { id: 1 } });
  h.directiveActionVerdict.mockReset();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-mine' });
  h.activeWorkspaceId.mockReturnValue('papercusp-workspace');
});

describe('orders:disposition — closing a FOREIGN directive is refused (P-008 / D-008)', () => {
  it.each(['done', 'declined'] as const)('refuses %s and never reaches the writer', async (status) => {
    h.directiveActionVerdict.mockResolvedValue(FOREIGN);

    const result = await call({ id: 96, status, note: 'this is not my lane' });

    expect(result.isError).toBe(true);
    const [row] = envelopeOf(result).results as Result[];
    expect(row!.error).toBe('foreign_directive');
    expect(row!.addressedTo).toBe('su-theirs');
    expect(row!.holders).toEqual(['su-peer']);
    // The absence of the write is the real assertion: an error envelope beside
    // a completed close would satisfy an error-only test while being exactly
    // the regression — and a close is not observably reversible afterwards.
    expect(h.dispositionOwnerDirective).not.toHaveBeenCalled();
  });

  it("redirects to resolve-pending's clear, NOT to a clear action this verb does not have", async () => {
    h.directiveActionVerdict.mockResolvedValue(FOREIGN);

    const [row] = envelopeOf(await call({ id: 96, status: 'done', note: 'not mine' })).results as Result[];

    expect(String(row!.hint)).toContain("orders:resolve-pending { action: 'clear' }");
  });

  it('a MIXED batch closes the legitimate ids and refuses only the foreign one', async () => {
    // THE case that separates a per-entry rail from a whole-batch refusal.
    h.directiveActionVerdict.mockImplementation(async ({ directiveId }: { directiveId: number }) =>
      directiveId === 96 ? FOREIGN : MINE,
    );

    const result = await call({
      items: [
        { id: 10, status: 'done', note: 'carried out, see WI-1' },
        { id: 96, status: 'done', note: 'not my lane' },
        { id: 11, status: 'declined', note: 'superseded by D-008' },
      ],
    });

    // Not isError: the call partly succeeded, and reporting it as a total
    // failure invites a retry of the whole batch — which would double-close 10
    // and 11 while failing on 96 again.
    expect(result.isError).toBeUndefined();
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.counts).toEqual({ ok: 2, failed: 1 });

    const rows = envelope.results as Result[];
    expect(rows.map((r) => [r.id, r.ok])).toEqual([
      [10, true],
      [96, false],
      [11, true],
    ]);
    expect(rows[1]!.error).toBe('foreign_directive');
    expect(h.dispositionOwnerDirective).toHaveBeenCalledTimes(2);
    expect(h.dispositionOwnerDirective.mock.calls.map((c) => (c[0] as { id: number }).id)).toEqual([10, 11]);
  });
});

describe('orders:disposition — the rail does not block legitimate closes', () => {
  it('the addressee closes normally, attributed to the caller', async () => {
    h.directiveActionVerdict.mockResolvedValue(MINE);

    const result = await call({ id: 96, status: 'done', note: 'carried out, see WI-10002432' });

    expect(result.isError).toBeUndefined();
    expect(h.dispositionOwnerDirective).toHaveBeenCalledWith({
      id: 96,
      status: 'done',
      note: 'carried out, see WI-10002432',
      dispositionedBy: 'su-mine',
    });
  });

  it('a holder of a linking non-terminal work-item closes normally', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'holds-linking-work-item' });

    await call({ id: 96, status: 'done', note: 'done under the linked work-item' });

    expect(h.dispositionOwnerDirective).toHaveBeenCalledTimes(1);
  });

  it('an UNREADABLE verdict falls through to the writer rather than blocking the close', async () => {
    // Fail-open on purpose, and stated so it is a decision rather than an
    // oversight: the pre-P-008 behaviour was an unguarded close, so a store
    // read error must not become a new way to strand a directive the caller
    // genuinely owns. The refusal requires a POSITIVE foreign verdict.
    h.directiveActionVerdict.mockRejectedValue(new Error('pg down'));

    const result = await call({ id: 96, status: 'done', note: 'carried out' });

    expect(result.isError).toBeUndefined();
    expect(h.dispositionOwnerDirective).toHaveBeenCalledTimes(1);
  });

  it('a directive that does not exist is left to the writer to report', async () => {
    // notFound is NOT a foreign refusal: the caller's repair is a wrong id,
    // and the writer already returns the not-found result for it.
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, notFound: true });
    h.dispositionOwnerDirective.mockResolvedValue({ ok: false, error: 'not_found' });

    const [row] = envelopeOf(await call({ id: 404, status: 'done', note: 'no such row' })).results as Result[];

    expect(row!.error).toBe('not_found');
    expect(h.dispositionOwnerDirective).toHaveBeenCalledTimes(1);
  });
});
