/**
 * resolve-pending-foreign-directive.test.ts — acceptance proof for the
 * WRITE-SIDE RAIL of P-008 (plan `directive-visibility-and-ownership-2026-09-22`,
 * re-scoped by D-008). Sibling of `resolve-pending.test.ts`, which proves the
 * separate reason-required rule and is deliberately left alone.
 *
 * THE RAIL HAS TWO HALVES THAT PULL IN OPPOSITE DIRECTIONS, and only testing
 * both proves either:
 *
 *   promote / dismiss  — assert something GLOBAL about the owner's order
 *                        ("this really is a directive" / "this is not one at
 *                        all"). Doing that to a peer's directive erases their
 *                        live order, so a foreign one is REFUSED.
 *   clear              — takes the row off THIS session's banner and nothing
 *                        else. Doing it to a foreign directive is the CORRECT
 *                        and expected operation, so it is deliberately
 *                        UNGUARDED and must never consult ownership at all.
 *
 * A guard bolted onto `clear` would look like a tightening and would in fact
 * re-create defect B: every foreign directive stranded in every agent's
 * Orientation banner forever, with no legitimate way to discharge it. That is
 * why the clear cases assert `directiveActionVerdict` was NEVER CALLED rather
 * than merely that the call succeeded — a version that consulted the verdict
 * and happened to allow this fixture would pass the weaker assertion.
 *
 * REFUSALS ALSO ASSERT THE ABSENCE OF THE WRITE. An error envelope is not
 * evidence that nothing was written: a handler that dismissed the row and then
 * reported an error would satisfy an error-only assertion while being exactly
 * the regression that matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  promoteOwnerDirective: vi.fn(),
  dismissOwnerDirective: vi.fn(),
  clearDirectiveFromAgenda: vi.fn(),
  directiveActionVerdict: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, promoteOwnerDirective: h.promoteOwnerDirective, dismissOwnerDirective: h.dismissOwnerDirective };
});

vi.mock('../../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directive-agenda')>();
  return { ...actual, clearDirectiveFromAgenda: h.clearDirectiveFromAgenda, directiveActionVerdict: h.directiveActionVerdict };
});

vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});

vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: h.activeWorkspaceId };
});

const tool = (await import('./resolve-pending')).default;

const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

function envelopeOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }>; isError?: boolean };
}

/** Every write the handler can perform. Used to assert a refusal wrote NOTHING. */
function expectNoWrites() {
  expect(h.promoteOwnerDirective).not.toHaveBeenCalled();
  expect(h.dismissOwnerDirective).not.toHaveBeenCalled();
  expect(h.clearDirectiveFromAgenda).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.promoteOwnerDirective.mockReset();
  h.dismissOwnerDirective.mockReset();
  h.clearDirectiveFromAgenda.mockReset();
  h.directiveActionVerdict.mockReset();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-mine' });
  h.activeWorkspaceId.mockReturnValue('papercusp-workspace');
});

describe("orders:resolve-pending — a FOREIGN directive refuses promote/dismiss (P-008 / D-008)", () => {
  it.each(['promote', 'dismiss'] as const)('refuses %s and writes nothing', async (action) => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: ['su-peer'] });

    const result = await call({ id: 96, action, reason: 'this is not my lane at all' });

    expect(result.isError).toBe(true);
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe('foreign_directive');
    // The refusal must NAME the peer and the holders: a bare "not allowed"
    // leaves the caller with no route except to try again or give up, which is
    // how the erase-a-peer's-order behaviour got normalised in the first place.
    expect(envelope.addressedTo).toBe('su-theirs');
    expect(envelope.holders).toEqual(['su-peer']);
    expectNoWrites();
  });

  it("the refusal REDIRECTS to action:'clear' rather than dead-ending", async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: [] });

    const envelope = envelopeOf(await call({ id: 96, action: 'dismiss', reason: 'not my lane, clearing' }));

    // Without this sentence the guard IS defect B with better manners: the
    // agent is told it may not act and never learns the legitimate exit.
    expect(String(envelope.hint)).toContain("action:'clear'");
    expect(String(envelope.hint)).toContain('#96');
  });

  it('a directive id that does not exist refuses as not_found, not as foreign', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, notFound: true });

    const result = await call({ id: 404, action: 'dismiss', reason: 'no such directive' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error).toBe('not_found');
    expectNoWrites();
  });
});

describe('orders:resolve-pending — an AUTHORISED caller still reaches the global writer', () => {
  it('the addressee may dismiss', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });
    h.dismissOwnerDirective.mockResolvedValue({ ok: true });

    const result = await call({ id: 96, action: 'dismiss', reason: 'not a directive, just a greeting' });

    expect(result.isError).toBeUndefined();
    expect(h.dismissOwnerDirective).toHaveBeenCalledWith({
      id: 96,
      reason: 'not a directive, just a greeting',
      dismissedBy: 'su-mine',
    });
  });

  it('a holder of a linking non-terminal work-item may promote', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'holds-linking-work-item' });
    h.promoteOwnerDirective.mockResolvedValue({ ok: true, row: { id: 96 } });

    const result = await call({ id: 96, action: 'promote' });

    expect(result.isError).toBeUndefined();
    expect(h.promoteOwnerDirective).toHaveBeenCalledWith({ id: 96, promotedBy: 'su-mine', note: null });
    // The pass-through exists so work that ALREADY links the directive is not
    // blocked on its addressee being awake; it is not a general bypass.
    expect(h.clearDirectiveFromAgenda).not.toHaveBeenCalled();
  });
});

describe("orders:resolve-pending — action:'clear' is per-session and deliberately UNGUARDED", () => {
  it('clears a FOREIGN directive without ever consulting ownership', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });
    // Armed to REFUSE. If the handler ever consults it, the envelope below
    // becomes a foreign_directive error and this test fails loudly — which is
    // the only way to prove the absence of a guard rather than assume it.
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: [] });

    const result = await call({ id: 96, action: 'clear', reason: 'addressed to another session' });

    expect(result.isError).toBeUndefined();
    expect(h.directiveActionVerdict).not.toHaveBeenCalled();
    expect(h.clearDirectiveFromAgenda).toHaveBeenCalledWith(
      { directiveId: 96, ownerId: 'su-mine', workspaceId: 'papercusp-workspace', reason: 'addressed to another session' },
      undefined,
    );
  });

  it('reports the blast radius on the envelope, so a caller cannot mistake it for a dismissal', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });

    const envelope = envelopeOf(await call({ id: 96, action: 'clear', reason: 'not my lane' }));

    expect(envelope).toEqual({ ok: true, state: 'dismissed', scope: 'this-session-only' });
  });

  it('never touches the GLOBAL directive writers', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });

    await call({ id: 96, action: 'clear', reason: 'not my lane' });

    expect(h.promoteOwnerDirective).not.toHaveBeenCalled();
    expect(h.dismissOwnerDirective).not.toHaveBeenCalled();
  });

  it('still requires a reason — a cleared row without one is indistinguishable from the old defect', async () => {
    const result = await call({ id: 96, action: 'clear', reason: '    ' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error).toBe('reason_required');
    expectNoWrites();
  });

  it('CALIBRATION: the schema alone accepts that four-space reason', () => {
    // So the handler's own trim() is what enforces the rule above; deleting it
    // would leave a green schema and a broken rail.
    expect(tool.args.safeParse({ id: 96, action: 'clear', reason: '    ' }).success).toBe(true);
  });
});
