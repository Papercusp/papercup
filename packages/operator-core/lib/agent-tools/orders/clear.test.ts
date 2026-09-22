/**
 * orders:clear — the per-session agenda action that survived the removal of the
 * promote/dismiss triage (owner-directive-delivery-redesign-2026-09-22, P-002).
 *
 * Clearing a FOREIGN directive off your own banner is the correct operation, so
 * the verb is deliberately UNGUARDED: the cases assert `directiveActionVerdict`
 * was NEVER CALLED rather than merely that the call succeeded — a version that
 * consulted the verdict and happened to allow this fixture would pass the
 * weaker assertion while re-creating the strand the rail exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clearDirectiveFromAgenda: vi.fn(),
  directiveActionVerdict: vi.fn(),
  dispositionOwnerDirective: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, dispositionOwnerDirective: h.dispositionOwnerDirective };
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

const tool = (await import('./clear')).default;

const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

function envelopeOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }>; isError?: boolean };
}

beforeEach(() => {
  h.clearDirectiveFromAgenda.mockReset();
  h.directiveActionVerdict.mockReset();
  h.dispositionOwnerDirective.mockReset();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-mine' });
  h.activeWorkspaceId.mockReturnValue('papercusp-workspace');
});

describe('orders:clear — per-session and deliberately UNGUARDED', () => {
  it('clears a FOREIGN directive without ever consulting ownership', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });
    // Armed to REFUSE: if the handler ever consults it, this test fails loudly.
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: [] });

    const result = await call({ id: 96, reason: 'addressed to another session' });

    expect(result.isError).toBeUndefined();
    expect(h.directiveActionVerdict).not.toHaveBeenCalled();
    expect(h.clearDirectiveFromAgenda).toHaveBeenCalledWith(
      { directiveId: 96, ownerId: 'su-mine', workspaceId: 'papercusp-workspace', reason: 'addressed to another session' },
      undefined,
    );
  });

  it('reports the blast radius on the envelope, so a caller cannot mistake it for closing the directive', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });

    const envelope = envelopeOf(await call({ id: 96, reason: 'not my lane' }));

    expect(envelope).toEqual({ ok: true, state: 'dismissed', scope: 'this-session-only' });
  });

  it('never touches the GLOBAL directive writer', async () => {
    h.clearDirectiveFromAgenda.mockResolvedValue({ ok: true, state: 'dismissed' });

    await call({ id: 96, reason: 'not my lane' });

    expect(h.dispositionOwnerDirective).not.toHaveBeenCalled();
  });

  it('requires a real reason, and writes nothing without one', async () => {
    const result = await call({ id: 96, reason: '    ' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error).toBe('reason_required');
    expect(h.clearDirectiveFromAgenda).not.toHaveBeenCalled();
  });

  it('CALIBRATION: the schema alone accepts that four-space reason', () => {
    // So the handler's own trim() is what enforces the rule above.
    expect(tool.args.safeParse({ id: 96, reason: '    ' }).success).toBe(true);
  });
});
