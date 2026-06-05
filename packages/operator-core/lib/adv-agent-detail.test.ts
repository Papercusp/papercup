import { describe, it, expect } from 'vitest';
import { deriveAgentLocks, deriveCoordState } from './adv-agent-detail';
import type {
  ActiveLockRow,
  WaiterRow,
  QueueResult,
} from './agent-tools/locks/su-lock-store';
import type { HandoffWithAcceptance } from './agent-tools/coordination/handoffs';
import type { EscalationRecord } from './agent-tools/coordination/escalations';
import type { CoordEnvelope } from '@papercusp/coordination/core';

const NOW = 1_700_000_000_000;
const isoMs = (ms: number): string => new Date(ms).toISOString();
const date = (ms: number): Date => new Date(ms);

function lock(overrides: Partial<ActiveLockRow> = {}): ActiveLockRow {
  return {
    path: 'a.ts',
    owner: 'su-1',
    owner_label: 'su · su-1',
    intent: 'editing a',
    acquired_ts: date(NOW - 60_000),
    expires_ts: date(NOW + 600_000),
    ...overrides,
  };
}

function waiter(overrides: Partial<WaiterRow> = {}): WaiterRow {
  return {
    ticket_id: 't-1',
    owner: 'su-1',
    owner_label: 'su · su-1',
    paths: ['a.ts'],
    intent: 'want a',
    queued_ts: date(NOW - 5_000),
    wait_until: date(NOW + 120_000),
    status: 'waiting',
    ahead_count: 0,
    ...overrides,
  };
}

describe('deriveAgentLocks', () => {
  it('returns only the target owner’s held locks, mapped to ISO', () => {
    const queue: QueueResult = {
      active_locks: [lock({ path: 'a.ts', owner: 'su-1' }), lock({ path: 'b.ts', owner: 'su-2' })],
      waiting: [],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ path: 'a.ts', intent: 'editing a' });
    expect(out.held[0].acquiredAt).toBe(isoMs(NOW - 60_000));
    expect(out.held[0].expiresAt).toBe(isoMs(NOW + 600_000));
    expect(out.error).toBeNull();
  });

  it('attributes each waiting ticket to the lock(s) blocking it (other owner)', () => {
    const queue: QueueResult = {
      active_locks: [lock({ path: 'a.ts', owner: 'su-2', owner_label: 'peer' })],
      waiting: [waiter({ owner: 'su-1', paths: ['a.ts'], ahead_count: 2 })],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0].aheadCount).toBe(2);
    expect(out.waiting[0].blockedBy).toEqual([
      expect.objectContaining({ path: 'a.ts', holder: 'su-2', holderLabel: 'peer' }),
    ]);
  });

  it('does not list the agent’s own held lock as a blocker of its own wait', () => {
    const queue: QueueResult = {
      active_locks: [lock({ path: 'a.ts', owner: 'su-1' })],
      waiting: [waiter({ owner: 'su-1', paths: ['a.ts'] })],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.waiting[0].blockedBy).toEqual([]);
  });

  it('is empty for an owner with no locks', () => {
    const queue: QueueResult = { active_locks: [lock({ owner: 'su-2' })], waiting: [] };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.held).toEqual([]);
    expect(out.waiting).toEqual([]);
  });
});

function msg(overrides: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: isoMs(NOW - 10_000),
    msg_id: 'm-1',
    from: 'su-2',
    to: ['su-1'],
    kind: 'message',
    summary: 'hi',
    ...overrides,
  };
}

describe('deriveCoordState', () => {
  it('picks the most recent message involving the agent (in or out) as lastMessage', () => {
    const messages: CoordEnvelope[] = [
      msg({ msg_id: 'm-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'older inbound' }),
      msg({ msg_id: 'm-2', ts: isoMs(NOW - 5_000), from: 'su-1', to: ['su-2'], summary: 'newest outbound' }),
      msg({ msg_id: 'm-3', ts: isoMs(NOW - 1_000), from: 'su-3', to: ['su-9'], summary: 'unrelated' }),
    ];
    const out = deriveCoordState(messages, new Set(), [], [], 'su-1');
    expect(out.lastMessage?.msgId).toBe('m-2');
    expect(out.lastMessage?.direction).toBe('outbound');
    expect(out.lastMessage?.summary).toBe('newest outbound');
  });

  it('excludes pure broadcasts the agent is not explicitly named in from lastMessage', () => {
    const messages: CoordEnvelope[] = [
      msg({ msg_id: 'm-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'to me' }),
      msg({ msg_id: 'm-2', ts: isoMs(NOW - 1_000), from: 'su-3', to: ['*'], summary: 'broadcast' }),
    ];
    const out = deriveCoordState(messages, new Set(), [], [], 'su-1');
    expect(out.lastMessage?.msgId).toBe('m-1');
  });

  it('counts unread = unacked inbound messages (incl broadcast), excluding self-sent', () => {
    const messages: CoordEnvelope[] = [
      msg({ msg_id: 'm-1', from: 'su-2', to: ['su-1'] }),
      msg({ msg_id: 'm-2', from: 'su-3', to: ['*'] }),
      msg({ msg_id: 'm-3', from: 'su-1', to: ['su-2'] }), // self-sent → not unread
      msg({ msg_id: 'm-4', from: 'su-2', to: ['su-1'] }), // acked below
    ];
    const out = deriveCoordState(messages, new Set(['m-4']), [], [], 'su-1');
    expect(out.unreadCount).toBe(2);
  });

  it('lists open handoffs in/out with direction + accepted flag', () => {
    const handoffs: HandoffWithAcceptance[] = [
      {
        record: {
          ts: isoMs(NOW - 9_000),
          msg_id: 'h-1',
          from: 'su-1',
          to: ['su-2'],
          kind: 'handoff',
          summary: 'mine outbound',
          plan_slug: 'p',
          next_action: 'do thing',
        },
      },
      {
        record: {
          ts: isoMs(NOW - 8_000),
          msg_id: 'h-2',
          from: 'su-3',
          to: ['su-9'],
          kind: 'handoff',
          summary: 'unrelated',
        },
      },
    ];
    const out = deriveCoordState([], new Set(), handoffs, [], 'su-1');
    expect(out.openHandoffs).toHaveLength(1);
    expect(out.openHandoffs[0]).toMatchObject({
      msgId: 'h-1',
      direction: 'outbound',
      accepted: false,
      planSlug: 'p',
      nextAction: 'do thing',
    });
  });

  it('lists only escalations the agent raised', () => {
    const escalations = [
      { ts: isoMs(NOW), msg_id: 'e-1', from: 'su-1', to: ['human'], kind: 'escalation', severity: 'blocker', summary: 'stuck', resolved: null },
      { ts: isoMs(NOW), msg_id: 'e-2', from: 'su-2', to: ['human'], kind: 'escalation', severity: 'question', summary: 'other', resolved: null },
    ] as unknown as EscalationRecord[];
    const out = deriveCoordState([], new Set(), [], escalations, 'su-1');
    expect(out.openEscalations).toHaveLength(1);
    expect(out.openEscalations[0]).toMatchObject({ msgId: 'e-1', severity: 'blocker' });
  });
});
