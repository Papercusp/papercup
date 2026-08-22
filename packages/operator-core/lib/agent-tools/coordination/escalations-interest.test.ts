import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

const h = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    reconcileInterestEventAwaits: vi.fn(async () => ({
      event_keys: ['escalation:resolved:esc-1'],
      await_ids: [71],
      cancel: { tool: 'events:cancel' as const, args: { await_ids: [71] } },
      handle_note: 'captured requester wake handle',
    })),
    emitAwaitedEvent: vi.fn(async () => {
      order.push('emit');
    }),
    retireInterestEventAwaits: vi.fn(async () => {
      order.push('retire');
    }),
  };
});

vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: h.emitAwaitedEvent }));
vi.mock('../../interest-auto-arm', () => ({
  reconcileInterestEventAwaits: h.reconcileInterestEventAwaits,
  retireInterestEventAwaits: h.retireInterestEventAwaits,
}));

import { configureCoordLog, resetCoordLog } from './log';
import {
  armEscalationRequesterInterest,
  openEscalation,
  resolveEscalation,
  resolveEscalationsBatch,
} from './escalations';

const identity = {
  ownerId: 'requester-1',
  ownerLabel: 'Requester 1',
  source: 'static-client' as const,
  workspaceId: 'ws-test',
  userId: null,
};

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  h.order.length = 0;
  h.reconcileInterestEventAwaits.mockClear();
  h.emitAwaitedEvent.mockClear();
  h.retireInterestEventAwaits.mockClear();
});
afterEach(() => resetCoordLog());

describe('central escalation requester-interest lifecycle (P-024)', () => {
  it('arms the singular concrete resolution edge with an exact lifecycle binding', async () => {
    const handle = await armEscalationRequesterInterest('requester-1', 'esc-1');
    expect(h.reconcileInterestEventAwaits).toHaveBeenCalledWith({
      ownerId: 'requester-1',
      eventKeys: ['escalation:resolved:esc-1'],
      boundTo: { kind: 'escalation-request', ref: 'esc-1' },
      note: 'escalation-requester auto-arm for esc-1',
    });
    expect(handle?.cancel).toEqual({ tool: 'events:cancel', args: { await_ids: [71] } });
  });

  it('the single resolver emits before retiring the requester binding', async () => {
    const opened = await openEscalation(identity, { severity: 'question', summary: 'single' });
    await resolveEscalation({ msg_id: opened.msg_id, choice: 'resolved', resolver: 'resolver-1' });
    expect(h.emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      key: `escalation:resolved:${opened.msg_id}`,
      to: ['requester-1'],
      source: 'resolver-1',
    }));
    expect(h.retireInterestEventAwaits).toHaveBeenCalledWith({
      kind: 'escalation-request',
      ref: opened.msg_id,
    });
    expect(h.order).toEqual(['emit', 'retire']);
  });

  it('the batch resolver owns the same emit-before-retire lifecycle', async () => {
    const opened = await openEscalation(identity, { severity: 'question', summary: 'batch' });
    await resolveEscalationsBatch([{ msg_id: opened.msg_id, choice: 'resolved', resolver: 'resolver-2' }]);
    expect(h.emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      key: `escalation:resolved:${opened.msg_id}`,
      to: ['requester-1'],
      source: 'resolver-2',
    }));
    expect(h.retireInterestEventAwaits).toHaveBeenCalledWith({
      kind: 'escalation-request',
      ref: opened.msg_id,
    });
    expect(h.order).toEqual(['emit', 'retire']);
  });
});
