import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ActiveLockRow,
  WaiterRow,
  QueueResult,
} from './agent-tools/locks/su-lock-store';
import type { HandoffWithAcceptance } from './agent-tools/coordination/handoffs';
import type { EscalationRecord } from './agent-tools/coordination/escalations';
import type { CoordEnvelope } from '@papercusp/coordination/core';

// EI-18694403367371331: getAgentSignals' six health reads are each best-effort
// (`.catch(() => <empty>)`) so no single broken source can crash the whole
// dossier — mock every one of them so the tests below can force a throw on
// exactly ONE leg and assert it renders as "unavailable", never the same
// shape as a legitimate empty/none state. `importOriginal` PARTIAL-mocks each
// module (only the one function used by getAgentSignals is replaced) — these
// modules are also imported transitively by unrelated code in this same test
// process (e.g. presence.ts's PRESENCE_STALE_MS), so a blanket mock without
// spreading the original exports breaks those importers with a confusing
// "no export defined on the mock" error.
const getLoopStatus = vi.fn();
vi.mock('./harness/routines/loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harness/routines/loop')>()),
  getLoopStatus: (...a: unknown[]) => getLoopStatus(...a),
}));
const readHeldWorkItems = vi.fn();
vi.mock('./carry-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./carry-brief')>()),
  readHeldWorkItems: (...a: unknown[]) => readHeldWorkItems(...a),
}));
const getPresence = vi.fn();
vi.mock('./agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
const fetchUnansweredDirected = vi.fn();
vi.mock('./agent-tools/coordination/unanswered-directed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/unanswered-directed')>()),
  fetchUnansweredDirected: (...a: unknown[]) => fetchUnansweredDirected(...a),
}));
const lastToolCallAtByOwner = vi.fn();
vi.mock('./fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet/assignments')>()),
  lastToolCallAtByOwner: (...a: unknown[]) => lastToolCallAtByOwner(...a),
}));
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-registry')>()),
  activeWorkspaceId: () => 'ws-1',
}));

const { deriveAgentLocks, deriveCoordState, getAgentSignals } = await import('./adv-agent-detail');
// The shared cursor rule, asserted alongside the counter it now feeds so the
// two cannot drift (unread-count-truthfulness-2026-07-27 P-002/P-003).
const { pickUnreadCursor } = await import('./agent-tools/coordination/watermarks');

const NOW = 1_700_000_000_000;
const isoMs = (ms: number): string => new Date(ms).toISOString();
const date = (ms: number): Date => new Date(ms);

/** The two real, coexisting lock domains on this box (WI-5979): the release
 *  checkout :3070 serves from, and the staging tree the Tauri desktop's :3270
 *  serves from. Every live lock row was recorded under the former. */
const DOMAIN_RELEASE = '/ws/papercup-release';
const DOMAIN_STAGING = '/ws/papercusp';

function lock(overrides: Partial<ActiveLockRow> = {}): ActiveLockRow {
  return {
    path: 'a.ts',
    owner: 'su-1',
    owner_label: 'su · su-1',
    intent: 'editing a',
    acquired_ts: date(NOW - 60_000),
    expires_ts: date(NOW + 600_000),
    coordination_domain: DOMAIN_RELEASE,
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
    coordination_domain: DOMAIN_RELEASE,
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

  // ── WI-5979: cross-domain reads ────────────────────────────────────────────
  // getAgentLocks now reads EVERY lock domain (coordinationDomain: null) because
  // the domain is a property of the READER's checkout, not of the lock: the
  // dossier used to key on its own repo root, so a desktop operator serving from
  // the staging tree matched none of the locks recorded under the release root
  // and rendered "No locks held or waiting." for every agent — silently, since an
  // empty read raises no error. Reading across domains is what makes that work;
  // these two tests pin the halves of it that could regress.

  it('surfaces a held lock recorded in a domain other than the reader’s own', () => {
    const queue: QueueResult = {
      // Recorded by the :3070 operator (release root) — the reader here is the
      // desktop operator, whose own domain is DOMAIN_STAGING.
      active_locks: [lock({ path: 'a.ts', owner: 'su-1', coordination_domain: DOMAIN_RELEASE })],
      waiting: [],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ path: 'a.ts' });
  });

  it('never attributes a blocker across lock domains (same path, different checkout)', () => {
    const queue: QueueResult = {
      // Same repo-relative path, two different physical checkouts — these are two
      // different files and must not be reported as blocking each other.
      active_locks: [
        lock({ path: 'a.ts', owner: 'su-2', owner_label: 'peer', coordination_domain: DOMAIN_RELEASE }),
      ],
      waiting: [waiter({ owner: 'su-1', paths: ['a.ts'], coordination_domain: DOMAIN_STAGING })],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0].blockedBy).toEqual([]);
  });

  it('still attributes a blocker within the same lock domain', () => {
    const queue: QueueResult = {
      active_locks: [
        lock({ path: 'a.ts', owner: 'su-2', owner_label: 'peer', coordination_domain: DOMAIN_STAGING }),
      ],
      waiting: [waiter({ owner: 'su-1', paths: ['a.ts'], coordination_domain: DOMAIN_STAGING })],
    };
    const out = deriveAgentLocks(queue, 'su-1');
    expect(out.waiting[0].blockedBy).toEqual([
      expect.objectContaining({ path: 'a.ts', holder: 'su-2' }),
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
    const out = deriveCoordState(messages, new Set(), [], [], 'su-1', null);
    expect(out.lastMessage?.msgId).toBe('m-2');
    expect(out.lastMessage?.direction).toBe('outbound');
    expect(out.lastMessage?.summary).toBe('newest outbound');
  });

  // Owner-reported regression 2026-07-26: the dossier's whole Coord section
  // rendered "Cannot read properties of undefined (reading 'includes')".
  // getAgentCoordState CASTS raw append-only log lines to CoordEnvelope[], so a
  // single historical row with no `to` threw inside these filters, escaped to
  // that function's try/catch, and blanked the section for EVERY agent. The
  // degradation must be proportionate: skip the bad row, keep the panel.
  it('survives a malformed row with no recipients instead of blanking the whole section', () => {
    const messages = [
      msg({ msg_id: 'm-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'real inbound' }),
      // The shape the log can actually hold, which the type promises it cannot:
      { ...msg({ msg_id: 'm-bad', ts: isoMs(NOW - 2_000), from: 'su-9' }), to: undefined },
      { ...msg({ msg_id: 'm-null', ts: isoMs(NOW - 1_500), from: 'su-9' }), to: null },
    ] as unknown as CoordEnvelope[];

    const out = deriveCoordState(messages, new Set(), [], [], 'su-1', null);

    // No throw, and the good row still resolves — the malformed rows simply
    // match no owner rather than taking the panel down with them.
    expect(out.lastMessage?.msgId).toBe('m-1');
    expect(out.unreadCount).toBe(1);
  });

  it('excludes pure broadcasts the agent is not explicitly named in from lastMessage', () => {
    const messages: CoordEnvelope[] = [
      msg({ msg_id: 'm-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'to me' }),
      msg({ msg_id: 'm-2', ts: isoMs(NOW - 1_000), from: 'su-3', to: ['*'], summary: 'broadcast' }),
    ];
    const out = deriveCoordState(messages, new Set(), [], [], 'su-1', null);
    expect(out.lastMessage?.msgId).toBe('m-1');
  });

  it('counts unread = unacked inbound messages (incl broadcast), excluding self-sent', () => {
    const messages: CoordEnvelope[] = [
      msg({ msg_id: 'm-1', from: 'su-2', to: ['su-1'] }),
      msg({ msg_id: 'm-2', from: 'su-3', to: ['*'] }),
      msg({ msg_id: 'm-3', from: 'su-1', to: ['su-2'] }), // self-sent → not unread
      msg({ msg_id: 'm-4', from: 'su-2', to: ['su-1'] }), // acked below
    ];
    const out = deriveCoordState(messages, new Set(['m-4']), [], [], 'su-1', null);
    expect(out.unreadCount).toBe(2);
  });

  // unread-count-truthfulness-2026-07-27 P-003.
  //
  // The bug these pin: this counter had NO read cursor at all, so it reported
  // every message ever addressed-or-broadcast to an agent minus the handful it
  // explicitly ACKed — and agents essentially never send an explicit ack. On a
  // real agent that was 19,391 (19,390 of them broadcasts), which is the ~19k
  // the owner reported. `readCursor` is resolved by readUnreadCursor() from the
  // LATER of messages_since_ts / messages_shown_ts / the last recorded
  // coord:inbox|orient call, so an empty (never-settled) since_ts no longer
  // means "epoch".
  describe('unread respects the read cursor', () => {
    // The exact live shape: messages_since_ts is '' (detached session, the
    // attached-only onTurnEnd never persisted it) but messages_shown_ts is
    // recent — so the resolved cursor is the shown_ts, and only what landed
    // after it counts.
    it('reports a SMALL count for an empty since_ts with a recent shown_ts, not the whole log', () => {
      const shownTs = isoMs(NOW - 60_000);
      const messages: CoordEnvelope[] = [
        // A long backlog the agent demonstrably HAS been shown.
        ...Array.from({ length: 200 }, (_, i) =>
          msg({ msg_id: `old-${i}`, ts: isoMs(NOW - 3_600_000 + i * 1_000), from: 'su-9', to: ['*'] }),
        ),
        // Two that arrived after the receipt — the honest unread.
        msg({ msg_id: 'new-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'new-2', ts: isoMs(NOW - 10_000), from: 'su-3', to: ['*'] }),
      ];

      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', shownTs).unreadCount).toBe(2);
      // Same input with no cursor is the OLD behaviour — proving the cursor,
      // not the fixture, is what shrinks the number.
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null).unreadCount).toBe(202);
    });

    it('still reports a real number for an agent that is genuinely behind', () => {
      const messages: CoordEnvelope[] = Array.from({ length: 40 }, (_, i) =>
        msg({ msg_id: `m-${i}`, ts: isoMs(NOW - 40_000 + i * 1_000), from: 'su-2', to: ['su-1'] }),
      );
      // Read receipt predates all of it: the agent really has not read these.
      const out = deriveCoordState(messages, new Set(), [], [], 'su-1', isoMs(NOW - 90_000));
      expect(out.unreadCount).toBe(40);
    });

    it('is unchanged for an agent with both cursors set (cursor === the later one)', () => {
      const sinceTs = isoMs(NOW - 90_000);
      const shownTs = isoMs(NOW - 45_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'before-both', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'between', ts: isoMs(NOW - 60_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'after-both', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'] }),
      ];
      // pickUnreadCursor takes the LATER of the two, so only 'after-both' counts.
      expect(pickUnreadCursor(sinceTs, shownTs)).toBe(shownTs);
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', shownTs).unreadCount).toBe(1);
    });

    it('treats an empty-string cursor as "no receipt", never as an epoch comparison', () => {
      const messages: CoordEnvelope[] = [msg({ msg_id: 'm-1', from: 'su-2', to: ['su-1'] })];
      expect(pickUnreadCursor('', null)).toBeNull();
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', '').unreadCount).toBe(1);
    });

    it('still excludes explicitly-acked messages that arrived after the cursor', () => {
      const cursor = isoMs(NOW - 60_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'new-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'new-2', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'] }),
      ];
      const out = deriveCoordState(messages, new Set(['new-2']), [], [], 'su-1', cursor);
      expect(out.unreadCount).toBe(1);
    });
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
    const out = deriveCoordState([], new Set(), handoffs, [], 'su-1', null);
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
    const out = deriveCoordState([], new Set(), [], escalations, 'su-1', null);
    expect(out.openEscalations).toHaveLength(1);
    expect(out.openEscalations[0]).toMatchObject({ msgId: 'e-1', severity: 'blocker' });
  });
});

// EI-18694403367371331: a live agent (su-ae6cbc84) held WI-5993 but its
// dossier rendered "CLAIM: none held" — the underlying readHeldWorkItems
// threw and getAgentSignals silently collapsed that into the SAME shape as
// "holds nothing", which a leader reads as "this agent is idle" — precisely
// the wrong conclusion when deciding whether to reclaim work.
describe('getAgentSignals', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getLoopStatus.mockResolvedValue(null);
    readHeldWorkItems.mockResolvedValue([]);
    getPresence.mockResolvedValue(null);
    fetchUnansweredDirected.mockResolvedValue(new Map());
    lastToolCallAtByOwner.mockResolvedValue(new Map());
    // getAgentSignals deliberately console.warns each signal that throws
    // (EI-18694403367371331 — a swallowed failure must be VISIBLE in logs,
    // not just in the returned DTO); spy + swallow it here so these
    // intentional-failure tests don't trip vitest-fail-on-console.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('a genuinely empty agent (every read resolves, nothing held) reports NO unavailable signals', async () => {
    const out = await getAgentSignals('su-1');
    expect(out.currentClaim).toBeNull();
    expect(out.loop).toBeNull();
    expect(out.unavailableSignals).toEqual([]);
  });

  it('readHeldWorkItems THROWING is distinguishable from genuinely holding nothing — the regression this item exists to prevent', async () => {
    readHeldWorkItems.mockRejectedValue(new Error('workspace mismatch'));
    const out = await getAgentSignals('su-ae6cbc84');
    // Same null VALUE as the genuinely-empty case above...
    expect(out.currentClaim).toBeNull();
    // ...but the tri-state flag tells them apart, which is the whole fix.
    expect(out.unavailableSignals).toEqual(['currentClaim']);
    // A sibling signal (loop) that resolved fine is NOT marked unavailable —
    // one broken leg must not taint the others.
    expect(out.unavailableSignals).not.toContain('loop');
  });

  it('a real held claim + checkpoint still surfaces correctly (control — the fix must not break the happy path)', async () => {
    readHeldWorkItems.mockResolvedValue([
      { id: 'WI-5993', title: 'do the thing', harness: 'papercusp', checkpoint: 'in progress', checkpointUpdatedAtMs: NOW },
    ]);
    const out = await getAgentSignals('su-ae6cbc84');
    expect(out.currentClaim).toEqual({ id: 'WI-5993', title: 'do the thing', harness: 'papercusp' });
    expect(out.lastCheckpoint).toEqual({ text: 'in progress', updatedAtMs: NOW });
    expect(out.unavailableSignals).toEqual([]);
  });

  it('getLoopStatus throwing marks ONLY `loop` unavailable, independent of the other five signals', async () => {
    getLoopStatus.mockRejectedValue(new Error('routine lookup failed'));
    readHeldWorkItems.mockResolvedValue([{ id: 'WI-1', title: 't', harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null }]);
    const out = await getAgentSignals('su-1');
    expect(out.loop).toBeNull();
    expect(out.unavailableSignals).toEqual(['loop']);
    expect(out.currentClaim).toEqual({ id: 'WI-1', title: 't', harness: 'papercusp' });
  });

  it('every one of the six signals can throw independently and all are reported, not just the first', async () => {
    getLoopStatus.mockRejectedValue(new Error('a'));
    readHeldWorkItems.mockRejectedValue(new Error('b'));
    getPresence.mockRejectedValue(new Error('c'));
    fetchUnansweredDirected.mockRejectedValue(new Error('d'));
    lastToolCallAtByOwner.mockRejectedValue(new Error('e'));
    const out = await getAgentSignals('su-1');
    expect(new Set(out.unavailableSignals)).toEqual(
      new Set(['loop', 'currentClaim', 'context', 'unanswered', 'lastToolCall']),
    );
  });
});
