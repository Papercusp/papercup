/**
 * cross-hive-ask-send.test.ts — composing one outbound cross-Hive request.
 *
 * Reliability + security properties pinned here: (1) default-deny admission rejects an ungranted /
 * over-quota request BEFORE any side effect (no ledger row, no send); (2) crash-safe ordering — the
 * durable `queued` row is written BEFORE the send attempt, so the asking side survives a mid-send
 * crash; (3) delivery state transitions (delivered→markSent/'sent', offline→'queued'). All deps are
 * injected; the fire-and-forget SSE invalidate is mocked to a no-op.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./sync-sse', () => ({ notifySyncInvalidate: async () => {} }));

import {
  sendCrossHiveAsk,
  type SendCrossHiveAskInput,
  type SendCrossHiveAskDeps,
} from './cross-hive-ask-send';
import { crossHiveReplyEventKey } from './cross-hive-transport';
import type { CrossHiveBoundaryWiring } from './cross-hive-wiring';
import type { CrossHiveAsksStore } from './cross-hive-asks-store-port';

const INPUT: SendCrossHiveAskInput = {
  workspaceId: 'ws', potSlug: 'home', peerPubkey: 'PEER', kind: 'ask', subject: 'S', body: 'B',
};

function makeDeps(opts: { allowed?: boolean; reason?: string; boundary?: 'present' | 'missing'; delivered?: boolean } = {}) {
  const order: string[] = [];
  const insertQueued = vi.fn(async (_ws: string, _slug: string, _input: Record<string, unknown>) => { order.push('insert'); });
  const markSent = vi.fn(async () => { order.push('markSent'); });
  const send = vi.fn(async () => { order.push('send'); return { delivered: opts.delivered ?? true } as never; });
  const boundary = { send } as unknown as CrossHiveBoundaryWiring;
  const checkOutboundGrant = vi.fn(async () => ({ allowed: opts.allowed ?? true, reason: opts.reason ?? '' }));
  const resolveBoundary = vi.fn(async () => (opts.boundary === 'missing' ? undefined : boundary));
  const store = { insertQueued, markSentByCorrelationId: markSent } as unknown as CrossHiveAsksStore;
  const deps: SendCrossHiveAskDeps = { resolveBoundary, checkOutboundGrant, store, newId: () => 'corr-123' };
  return { deps, order, insertQueued, markSent, send, checkOutboundGrant, resolveBoundary };
}

describe('sendCrossHiveAsk — admission (default-deny, no side effects)', () => {
  it('rejects an ungranted request before touching the boundary or the ledger', async () => {
    const d = makeDeps({ allowed: false, reason: 'no_outbound_grant' });
    const res = await sendCrossHiveAsk(INPUT, d.deps);
    expect(res).toEqual({ ok: false, reason: 'no_outbound_grant' });
    expect(d.resolveBoundary).not.toHaveBeenCalled();
    expect(d.insertQueued).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('passes the UTF-8 byte length (not char length) to the grant size check', async () => {
    const d = makeDeps();
    await sendCrossHiveAsk({ ...INPUT, body: 'héllo' }, d.deps); // 5 chars, 6 bytes
    expect(d.checkOutboundGrant).toHaveBeenCalledWith('ws', 'home', 'PEER', 'ask', 6);
  });
});

describe('sendCrossHiveAsk — boundary resolution', () => {
  it('hard-fails when no live boundary exists, without writing a ledger row', async () => {
    const d = makeDeps({ boundary: 'missing' });
    const res = await sendCrossHiveAsk(INPUT, d.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not live/);
    expect(d.insertQueued).not.toHaveBeenCalled();
  });
});

describe('sendCrossHiveAsk — durable send', () => {
  it('records the queued row BEFORE sending (crash-safety) and marks sent on delivery', async () => {
    const d = makeDeps({ delivered: true });
    const res = await sendCrossHiveAsk(INPUT, d.deps);

    expect(d.order).toEqual(['insert', 'send', 'markSent']); // queued row persists before the send attempt
    expect(d.insertQueued).toHaveBeenCalledWith('ws', 'home', {
      peerPubkey: 'PEER', kind: 'ask', correlationId: 'corr-123', subject: 'S', body: 'B', direction: 'out',
    });
    expect(d.send).toHaveBeenCalledWith('PEER', { id: 'corr-123', kind: 'ask', subject: 'S', body: 'B' });
    expect(d.markSent).toHaveBeenCalledWith('ws', 'home', 'corr-123');
    expect(res).toEqual({
      ok: true,
      correlationId: 'corr-123',
      kind: 'ask',
      peerPubkey: 'PEER',
      state: 'sent',
      delivered: true,
      answeredEvent: crossHiveReplyEventKey('answer', 'corr-123'),
      declinedEvent: crossHiveReplyEventKey('decline', 'corr-123'),
    });
  });

  it('leaves the row queued (no markSent) when the peer is offline', async () => {
    const d = makeDeps({ delivered: false });
    const res = await sendCrossHiveAsk(INPUT, d.deps);
    expect(d.markSent).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, state: 'queued', delivered: false });
  });

  it('includes askedBy on the ledger row only when provided', async () => {
    const withAskedBy = makeDeps();
    await sendCrossHiveAsk({ ...INPUT, askedBy: 'agent-9' }, withAskedBy.deps);
    expect(withAskedBy.insertQueued.mock.calls[0][2]).toMatchObject({ askedBy: 'agent-9' });

    const without = makeDeps();
    await sendCrossHiveAsk(INPUT, without.deps);
    expect('askedBy' in (without.insertQueued.mock.calls[0][2] as object)).toBe(false);
  });
});
