/**
 * Coverage for execute-action validation:
 * 1. validateIdentityFields — the pure identity-spoof guard: a body's
 *    callingHarness must equal the bearer-derived slug, and scaffold_harness
 *    must not carry a caller-supplied parent_slug.
 * 2. executeAction — comprehensive action shape validation ensures malformed
 *    actions are rejected before dispatch so state remains clean.
 *
 * RETIRED 2026-07-26 (P-008, owner-directed): the `doSendMessage — recipient
 * harness existence (WI-385)` suite and the two `send_message`-spoof cases
 * were removed with the work-item mail surface, along with the getOrgPg `sql`
 * mock that existed only to serve them (the schema-existence probe + INSERT
 * capture). Their subjects — doSendMessage, the WI-3800 schema-exists cache,
 * and the WI-5243 workspace_id stamp on the `messages` INSERT — no longer
 * exist. See _retired/work-item-mail/RESTORE.md to restore them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ to: [], msg_id: 'msg-stub', ts: 0 }) as unknown),
}));
vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage: M.sendMessage }));

import { validateIdentityFields, executeAction } from './execute-action';

beforeEach(() => {
  vi.clearAllMocks();
  M.sendMessage.mockImplementation(
    async (..._args: unknown[]) => ({ to: ['harness-x'], msg_id: 'msg-123', ts: 111 }) as unknown,
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (over: any) => ({ actionId: 'a1', action: { op: 'noop' }, ...over }) as never;

describe('validateIdentityFields', () => {
  it('passes a clean body with no identity claims', () => {
    expect(validateIdentityFields('papercup', body({}))).toBeNull();
  });

  it('rejects a callingHarness that does not match the bearer slug', () => {
    const r = validateIdentityFields('papercup', body({ callingHarness: 'evil' }));
    expect(r).toMatchObject({ status: 403, error: 'identity_mismatch' });
  });

  it('allows a matching callingHarness', () => {
    expect(validateIdentityFields('papercup', body({ callingHarness: 'papercup' }))).toBeNull();
  });

  it('rejects a caller-supplied parent_slug on scaffold_harness', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness', parent_slug: 'x' } }));
    expect(r).toMatchObject({ status: 400, error: 'parent_slug_not_caller_controlled' });
  });

  it('allows scaffold_harness without parent_slug', () => {
    expect(validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness' } }))).toBeNull();
  });
});

/**
 * send_directive — end-to-end dispatch-contract coverage (EI-18740258166031188,
 * agent-trap-guards-2026-07-26 P-001): the OperatorPanel "Accept" button posts
 * `op:'send_directive'` to /api/agent-mcp/operator-dispatch → /api/admin/execute-
 * action → executeAction, expecting a stable `result.msg_id` back. This pins the
 * whole string-op-code contract end to end, not just the handler in isolation —
 * exactly the class of break that shipped when `send_message` was removed but the
 * panel + proxy still spoke it.
 */
describe('executeAction — send_directive (dispatch contract)', () => {
  const actionId = '11111111-1111-1111-1111-111111111111';

  it('dispatches a coord send and returns a stable msg_id in place of the retired messageId', async () => {
    const result = await executeAction('system:operator', {
      actionId,
      action: {
        op: 'send_directive',
        to: ['harness-x'],
        kind: 'Directive',
        subject: 'do the thing',
        body: 'please do the thing now',
        reason: 'operator suggestion accepted',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result?.msg_id).toBe('msg-123');
    expect(M.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = M.sendMessage.mock.calls[0] as [
      { ownerId: string },
      Record<string, unknown>,
    ];
    expect(identity.ownerId).toBe('system:operator-directive');
    expect(opts).toMatchObject({
      to: ['harness-x'],
      summary: '[Directive] do the thing',
      body: 'please do the thing now',
    });
  });

  it('rejects a missing `to` before ever calling sendMessage', async () => {
    const result = await executeAction('system:operator', {
      actionId,
      action: { op: 'send_directive', to: [], subject: 's' } as never,
    });
    expect(result).toMatchObject({ ok: false, error: 'validation_error' });
    expect(M.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects when neither subject nor body is present', async () => {
    const result = await executeAction('system:operator', {
      actionId,
      action: { op: 'send_directive', to: ['harness-x'] } as never,
    });
    expect(result).toMatchObject({ ok: false, error: 'validation_error' });
    expect(M.sendMessage).not.toHaveBeenCalled();
  });

  it('surfaces a sendMessage failure as an internal error, not a thrown exception', async () => {
    M.sendMessage.mockRejectedValueOnce(new Error('coord down'));
    const result = await executeAction('system:operator', {
      actionId,
      action: { op: 'send_directive', to: ['harness-x'], subject: 's' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('internal');
    expect(result.detail).toMatch(/coord down/);
  });

  it('never reintroduces the retired send_message op (frozen per RESTORE.md)', async () => {
    const result = await executeAction('system:operator', {
      actionId,
      action: { op: 'send_message' } as never,
    });
    expect(result).toMatchObject({ ok: false, error: 'validation_error', detail: expect.stringContaining('unknown op') });
  });
});
