/**
 * stop-owner-directive-check (P-007 of owner-directive-delivery-redesign-2026-09-22).
 *
 * The hook is a relay: it must block with the operator's reason, and it must
 * never block when it cannot know — a continuation of its own block, a non-psu
 * session, or an operator that errors or answers nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { evaluateStop } from '../stop-owner-directive-check.mjs';

const env = {
  PAPERCUSP_SID: 'su-abc',
  PAPERCUSP_WORKSPACE: 'papercusp-workspace',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/',
} as NodeJS.ProcessEnv;

function answering(body: unknown, ok = true) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({ ok, json: async () => body }) as Response);
}

describe('evaluateStop', () => {
  it("relays the operator's reason for this session and workspace", async () => {
    const fetchImpl = answering({ ok: true, reason: 'You replied to owner directive #7, still open.' });
    const reason = await evaluateStop({ hook: {}, env, fetchImpl });
    expect(reason).toBe('You replied to owner directive #7, still open.');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://127.0.0.1:3070/api/agent-mcp/turn-end-directive-check?owner=su-abc&workspace=papercusp-workspace',
    );
    expect(init?.method).toBe('POST');
  });

  it('never re-blocks the continuation its own block caused', async () => {
    const fetchImpl = answering({ ok: true, reason: 'x' });
    expect(await evaluateStop({ hook: { stop_hook_active: true }, env, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing outside a psu session', async () => {
    const fetchImpl = answering({ ok: true, reason: 'x' });
    expect(await evaluateStop({ hook: {}, env: {}, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets the turn end on no reason, a blank reason, or an error status', async () => {
    expect(await evaluateStop({ hook: {}, env, fetchImpl: answering({ ok: true, reason: null }) })).toBeNull();
    expect(await evaluateStop({ hook: {}, env, fetchImpl: answering({ ok: true, reason: '  ' }) })).toBeNull();
    expect(await evaluateStop({ hook: {}, env, fetchImpl: answering({ reason: 'x' }, false) })).toBeNull();
  });
});
