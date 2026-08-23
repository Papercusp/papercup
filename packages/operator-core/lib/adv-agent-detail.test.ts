import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const resolveSessionStates = vi.fn();
vi.mock('./agent-tools/coordination/liveness-oracle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/liveness-oracle')>()),
  resolveSessionStates: (...a: unknown[]) => resolveSessionStates(...a),
}));
const fetchUnansweredDirected = vi.fn();
vi.mock('./agent-tools/coordination/unanswered-directed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/unanswered-directed')>()),
  fetchUnansweredDirected: (...a: unknown[]) => fetchUnansweredDirected(...a),
}));
// P-009 legs (a) lane / (b) announced gates / (d) fleet control. The lane, gate
// and fleet reads are DYNAMIC imports inside adv-agent-detail (its static module
// graph is deliberately unchanged — the plans tree and events store are large
// and the dossier is cold-path); `vi.mock` intercepts a dynamic import exactly
// as it does a static one, so they mock identically to the five legs above.
const fetchPresenceFleet = vi.fn();
vi.mock('./agent-tools/coordination/presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/presence-fleet')>()),
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...a),
}));
const listActiveAnnouncements = vi.fn();
const listActiveAwaits = vi.fn();
vi.mock('./events/await/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./events/await/store')>()),
  listActiveAnnouncements: (...a: unknown[]) => listActiveAnnouncements(...a),
  listActiveAwaits: (...a: unknown[]) => listActiveAwaits(...a),
}));
const readPlanBySlug = vi.fn();
vi.mock('./agent-tools/plans/source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/plans/source')>()),
  readPlanBySlug: (...a: unknown[]) => readPlanBySlug(...a),
}));
const getFleet = vi.fn();
vi.mock('./agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-fleets-store')>()),
  getFleet: (...a: unknown[]) => getFleet(...a),
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

const {
  deriveAgentLocks,
  deriveCoordState,
  getAgentSignals,
  deriveClaimProgress,
  deriveLane,
  deriveAnnouncedGates,
  derivePushedContext,
  legRan,
  classifyPushedRef,
  applyPushedRefTitles,
  resolutionFromBody,
  resolvePushedRefTitles,
} = await import('./adv-agent-detail');

// The funnel's OWN stage vocabulary. Asserting the shaper's `why` against this
// rather than against literal prose is the point: a gloss re-typed in the test
// would pass while the shipped text drifted from the write path's meaning.
const { ADMISSION_STAGE_SHORT_WHY } = await import('./memory/recall-stats');
const advAgentDetailSource = readFileSync(join(__dirname, 'adv-agent-detail.ts'), 'utf8');
type PushedContextRow = import('./adv-agent-detail').PushedContextRow;
type PushedContextRefDetailRow = import('./adv-agent-detail').PushedContextRefDetailRow;
type PushedContextRef = import('./adv-agent-detail').PushedContextRef;
type PushedRefSqlTag = import('./adv-agent-detail').PushedRefSqlTag;
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

describe('adv-agent-detail import boundary', () => {
  it('reads Codex diagnostics without linking the role spawn/TOML builder', () => {
    expect(advAgentDetailSource).toContain("from './codex-home-diagnostics'");
    expect(advAgentDetailSource).not.toContain("from './role-codex-home'");
  });
});

function lock(overrides: Partial<ActiveLockRow> = {}): ActiveLockRow {
  return {
    lock_id: '11111111-1111-1111-1111-111111111111',
    path: 'a.ts',
    owner: 'su-1',
    owner_label: 'su · su-1',
    goal_ref: null,
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
    goal_ref: null,
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

  // unread-count-truthfulness-2026-07-27 D-012 — the BIRTH FLOOR.
  //
  // The bug these pin (owner-reported 2026-07-27): a BRAND-NEW session showed
  // 1031 unread. A newborn has all three RECEIPT legs empty by construction —
  // no watermark row, and it has not yet called coord:inbox/coord:orient — so
  // the resolved cursor was null and the count fell back to the whole visible
  // log. Reproduced through the real getAgentCoordState against the live log:
  // two newborn owners both returned exactly 1031; after the floor, 0.
  //
  // D-007 measured this same no-cursor branch but reasoned about it ONLY as a
  // REAPED agent (where a historical backlog is defensible). The newborn is the
  // other end of that branch and is not: every counted message PREDATES the
  // agent. The floor is the owner's session-birth ts folded in as a fourth leg
  // of the same pickUnreadCursor max — so it can only ever move the cursor
  // later, never raise a count.
  describe('unread respects the birth floor (D-012)', () => {
    it('counts nothing that predates a newborn agent, where receipts are all empty', () => {
      const bornAt = isoMs(NOW - 5_000);
      // The backlog the fleet accumulated long before this agent existed.
      const messages: CoordEnvelope[] = Array.from({ length: 1031 }, (_, i) =>
        msg({ msg_id: `pre-birth-${i}`, ts: isoMs(NOW - 3_600_000 + i * 1_000), from: 'su-9', to: ['*'] }),
      );

      // No receipts at all → the floor is the only thing bounding the count.
      expect(pickUnreadCursor(pickUnreadCursor('', ''), null)).toBeNull();
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null).unreadCount).toBe(1031);
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null, bornAt).unreadCount).toBe(
        0,
      );
    });

    it('still counts mail that arrived AFTER birth — the floor is not a blanket zero', () => {
      const bornAt = isoMs(NOW - 60_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'pre-birth', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['*'] }),
        msg({ msg_id: 'post-birth-1', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'post-birth-2', ts: isoMs(NOW - 10_000), from: 'su-3', to: ['su-1'] }),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null, bornAt).unreadCount).toBe(
        2,
      );
    });

    it('lets a LATER read receipt win over the birth floor (the floor never un-reads mail)', () => {
      const bornAt = isoMs(NOW - 300_000);
      const shownTs = isoMs(NOW - 60_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'read-since-birth', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'genuinely-unread', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'] }),
      ];
      // The fold takes the LATER of the two, so the receipt governs.
      expect(pickUnreadCursor(shownTs, bornAt)).toBe(shownTs);
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', shownTs).unreadCount).toBe(1);
    });

    // The respawn trap (WI-6589). This test USED to seed the three messages as
    // TARGETED mail and assert that flooring at the latest respawn drops one of
    // them — encoding the very conflation that turned out to be the bug. It is
    // re-pointed at broadcasts, which is the only thing the floor governs now;
    // the targeted case is covered by its own describe below, where the answer
    // is stronger (the floor never applies at all).
    //
    // A coord owner id OUTLIVES any one session row, so the floor must come from
    // the owner's EARLIEST session, not its latest. `first_seen_at` (migration
    // 707) is what makes that possible — `started_at` is bumped in place on
    // every resume, so the MIN over it could never engage.
    it('floors at the EARLIEST session start, so a respawn cannot hide broadcasts', () => {
      const firstStart = isoMs(NOW - 600_000);
      const respawnedAt = isoMs(NOW - 60_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'before-owner-existed', ts: isoMs(NOW - 900_000), from: 'su-2', to: ['*'] }),
        msg({ msg_id: 'during-first-leg', ts: isoMs(NOW - 300_000), from: 'su-2', to: ['*'] }),
        msg({ msg_id: 'after-respawn', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['*'] }),
      ];
      // Correct: the pre-existence one drops, both in-life ones survive.
      expect(
        deriveCoordState(messages, new Set(), [], [], 'su-1', null, firstStart).unreadCount,
      ).toBe(2);
      // What flooring at the LATEST session does — a broadcast from the earlier
      // leg is lost. This is the behaviour migration 707 removes at the source.
      expect(
        deriveCoordState(messages, new Set(), [], [], 'su-1', null, respawnedAt).unreadCount,
      ).toBe(1);
    });
  });

  // WI-6589 — the floor governs BROADCASTS ONLY.
  //
  // D-012 folded the birth floor into the same pickUnreadCursor max as the read
  // receipts, so it bounded EVERY candidate. Its own justification never reached
  // that far: a `to:['*']` broadcast is a fan-out to the population alive at send
  // time, so an agent born later was never in it. A message that NAMES the owner
  // is the opposite — a peer addressed this exact agent id.
  //
  // Measured on the live log before the fix (papercusp-workspace, 7d): 8,954
  // targeted non-self messages to 153 owners, 6,957 of them (78%) below their
  // recipient's computed floor, across 78 of 153 owners.
  describe('the birth floor governs broadcasts only (WI-6589)', () => {
    const bornAt = isoMs(NOW - 60_000);

    it('never floors a message that names the owner, however far it predates birth', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'targeted-long-before', ts: isoMs(NOW - 86_400_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'targeted-just-before', ts: isoMs(NOW - 120_000), from: 'su-3', to: ['su-1'] }),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null, bornAt).unreadCount).toBe(
        2,
      );
    });

    it('still floors a broadcast from the same instant, in the same call', () => {
      const ts = isoMs(NOW - 120_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'targeted', ts, from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'broadcast', ts, from: 'su-2', to: ['*'] }),
      ];
      const out = deriveCoordState(messages, new Set(), [], [], 'su-1', null, bornAt);
      expect(out.unreadCount).toBe(1);
      expect(out.unread.map((u) => u.msgId)).toEqual(['targeted']);
    });

    it('treats a fan-out that lists the owner alongside "*" as addressed, not broadcast', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'named-in-fanout', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['*', 'su-1'] }),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null, bornAt).unreadCount).toBe(
        1,
      );
    });

    it('leaves the READ-RECEIPT cursor governing every kind of message', () => {
      // The receipt leg is untouched by this change: a message the agent has
      // already been shown stays read whether it was addressed or broadcast.
      const shownTs = isoMs(NOW - 90_000);
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'targeted-read', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'broadcast-read', ts: isoMs(NOW - 120_000), from: 'su-2', to: ['*'] }),
        msg({ msg_id: 'targeted-unread', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'] }),
      ];
      const out = deriveCoordState(messages, new Set(), [], [], 'su-1', shownTs, bornAt);
      expect(out.unreadCount).toBe(1);
      expect(out.unread.map((u) => u.msgId)).toEqual(['targeted-unread']);
    });

    it('is inert when the owner has no birth on record (D-007 reaped-agent path)', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'old-broadcast', ts: isoMs(NOW - 86_400_000), from: 'su-2', to: ['*'] }),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', null, null).unreadCount).toBe(1);
    });
  });

  // unread-count-truthfulness-2026-07-27 Phase 2 (P-006), rule = D-006.
  //
  // Phase 1 gave the counter a read cursor. These pin the SECOND half: of what
  // survives the cursor, count only what a DEFAULT `coord:inbox` read would
  // actually SHOW the agent. Anything the agent is never shown cannot honestly
  // be "unread". The predicates are coord:inbox's own (relocated to
  // agent-tools/coordination/inbox-visibility.ts and imported, never copied),
  // so these tests fail if the two ever drift apart.
  describe('unread counts only what coord:inbox actually shows (D-006)', () => {
    const cursor = isoMs(NOW - 600_000);

    it('excludes ambient system broadcasts, which are broadcast-only', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'real', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'a real ask' }),
        ...(['service-health', 'agent-governor', 'doc-drift'] as const).map((category, i) =>
          msg({
            msg_id: `ambient-${i}`,
            ts: isoMs(NOW - 20_000 + i * 100),
            from: 'system',
            to: ['*'],
            summary: `ambient ${i}`,
            category,
          } as Partial<CoordEnvelope>),
        ),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    it('keeps a same-category message addressed DIRECTLY to the agent (suppression is broadcast-only)', () => {
      // The guard that stops the ambient rule from hiding addressed work: a
      // category label describes content, not delivery importance.
      const messages: CoordEnvelope[] = [
        msg({
          msg_id: 'directed-health',
          ts: isoMs(NOW - 30_000),
          from: 'system',
          to: ['su-1'],
          summary: 'your service is down',
          category: 'service-health',
        } as Partial<CoordEnvelope>),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    // The leg the plan's own premise missed: intent declares are NOT broadcasts.
    // They fan out ADDRESSED to each @plan/@fleet subscriber, so the recipient
    // predicate counts every one. Measured live 2026-07-27: 506 in 24h, and up
    // to 68% of a single agent's counted messages over 12h — the LARGER of the
    // two Phase-2 legs, not ambient.
    it("excludes peers' auto `now working on:` intent declares", () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'real', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], summary: 'a real ask' }),
        ...Array.from({ length: 20 }, (_, i) =>
          msg({
            msg_id: `intent-${i}`,
            ts: isoMs(NOW - 25_000 + i * 100),
            from: `su-peer-${i}`,
            to: ['su-1'],
            summary: 'now working on: something',
            lifecycle: 'intent',
            auto: true,
          } as Partial<CoordEnvelope>),
        ),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    it('keeps a HUMAN-authored message that merely carries the intent lifecycle label', () => {
      // `auto:true` is the authoritative projection stamp — a directed,
      // contextual message must not vanish because a producer reused the label.
      const messages: CoordEnvelope[] = [
        msg({
          msg_id: 'manual-intent',
          ts: isoMs(NOW - 30_000),
          from: 'su-2',
          to: ['su-1'],
          summary: 'I am taking P-004',
          lifecycle: 'intent',
        } as Partial<CoordEnvelope>),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    it('counts a coalesced repeat group ONCE — it is one row in the reader', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'real', ts: isoMs(NOW - 40_000), from: 'su-2', to: ['su-1'], summary: 'a real ask' }),
        // Same sender + kind + category + verbatim summary, broadcast: exactly
        // the watchdog firehose shape coord:inbox folds into one row.
        ...Array.from({ length: 12 }, (_, i) =>
          msg({
            msg_id: `repeat-${i}`,
            ts: isoMs(NOW - 30_000 + i * 100),
            from: 'watchdog',
            to: ['*'],
            summary: 'red gate on papercusp',
            category: 'gate',
          } as Partial<CoordEnvelope>),
        ),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(2);
    });

    it('excludes a retracted message even when the retraction notice predates the cursor', () => {
      // Retraction ids are collected from the FULL raw window, not the unread
      // slice — the "disregard that" marker can sit either side of the cursor.
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'kept', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'] }),
        msg({ msg_id: 'withdrawn', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'] }),
        msg({
          msg_id: 'notice',
          ts: isoMs(NOW - 900_000),
          from: 'su-2',
          to: ['su-1'],
          summary: 'disregard that',
          retracts: 'withdrawn',
        } as Partial<CoordEnvelope>),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    // The rule is an INTERSECTION, so it can only ever REDUCE the number.
    // Reading "agree with coord:inbox" literally would ADD acks/handoffs and
    // RAISE it, which is the opposite of this plan's purpose (D-006).
    it('never counts a non-message kind, even though a default coord:inbox read shows them', () => {
      const messages: CoordEnvelope[] = [
        msg({ msg_id: 'm', ts: isoMs(NOW - 30_000), from: 'su-2', to: ['su-1'], kind: 'message' }),
        msg({ msg_id: 'a', ts: isoMs(NOW - 25_000), from: 'su-2', to: ['su-1'], kind: 'ack' }),
        msg({ msg_id: 'h', ts: isoMs(NOW - 20_000), from: 'su-2', to: ['su-1'], kind: 'handoff' }),
        msg({ msg_id: 'p', ts: isoMs(NOW - 15_000), from: 'su-2', to: ['su-1'], kind: 'plan_event' }),
      ];
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(1);
    });

    it('does NOT cap at a display page size — a genuinely-behind agent still gets the real number', () => {
      // D-003 forbade capping, and a badge capped at coord:inbox's 50-entry
      // page would be a new lie. 120 distinct directed messages => 120.
      const messages: CoordEnvelope[] = Array.from({ length: 120 }, (_, i) =>
        msg({ msg_id: `m-${i}`, ts: isoMs(NOW - 300_000 + i * 100), from: 'su-2', to: ['su-1'], summary: `ask ${i}` }),
      );
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(120);
    });

    // The end-to-end shape, in the proportions the live 12–24h measurement
    // found: mostly intent declares + ambient broadcasts, a few real asks.
    it('reduces a realistic mixed window to just the messages the agent is shown', () => {
      const messages: CoordEnvelope[] = [
        ...Array.from({ length: 21 }, (_, i) =>
          msg({
            msg_id: `intent-${i}`, ts: isoMs(NOW - 300_000 + i * 100), from: `su-peer-${i}`, to: ['su-1'],
            summary: 'now working on: x', lifecycle: 'intent', auto: true,
          } as Partial<CoordEnvelope>),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          msg({
            msg_id: `ambient-${i}`, ts: isoMs(NOW - 200_000 + i * 100), from: 'system', to: ['*'],
            summary: `service check ${i}`, category: 'service-health',
          } as Partial<CoordEnvelope>),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          msg({
            msg_id: `dupe-${i}`, ts: isoMs(NOW - 100_000 + i * 100), from: 'watchdog', to: ['*'],
            summary: 'main is behind staging', category: 'pipeline',
          } as Partial<CoordEnvelope>),
        ),
        msg({ msg_id: 'ask-1', ts: isoMs(NOW - 50_000), from: 'su-2', to: ['su-1'], summary: 'can you review P-005?' }),
        msg({ msg_id: 'ask-2', ts: isoMs(NOW - 40_000), from: 'su-3', to: ['su-1'], summary: 'blocked on your lane' }),
      ];
      // 21 intents + 8 ambient dropped; 5 identical broadcasts fold to 1; 2 real
      // asks remain => 3. The same window with the OLD (cursor-only) rule was 36.
      expect(deriveCoordState(messages, new Set(), [], [], 'su-1', cursor).unreadCount).toBe(3);
      expect(messages.filter((m) => m.kind === 'message' && m.ts > cursor).length).toBe(36);
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
    resolveSessionStates.mockImplementation(
      async (subjects: Array<{ ownerId: string }>) =>
        new Map(
          subjects.map((subject) => [
            subject.ownerId,
            { ownerId: subject.ownerId, sessionState: 'parked', liveTurn: false },
          ]),
        ),
    );
    fetchUnansweredDirected.mockResolvedValue(new Map());
    lastToolCallAtByOwner.mockResolvedValue(new Map());
    // P-009 defaults: no fleet, no gates declared, no awaits. The lane + fleet
    // legs short-circuit BEFORE their dynamic import when the agent declared no
    // plan / belongs to no fleet, so `readPlanBySlug`/`getFleet` stay unused on
    // this path — a test that needs them sets presence/fleet membership first.
    fetchPresenceFleet.mockResolvedValue(new Map());
    listActiveAnnouncements.mockResolvedValue([]);
    listActiveAwaits.mockResolvedValue([]);
    readPlanBySlug.mockResolvedValue(null);
    getFleet.mockResolvedValue(null);
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
    expect(out.liveness).toEqual({ sessionState: 'parked', liveTurn: false });
    expect(out.unavailableSignals).toEqual([]);
  });

  it('projects one shared-oracle verdict from the already-read presence and held-claim state', async () => {
    getPresence.mockResolvedValue({
      heartbeatAt: '2026-08-23T17:00:00.000Z',
      stale: false,
      host: 'devbox',
      pid: 4242,
      source: 'psu',
      agentRole: 'su',
      lastActiveAt: null,
      currentPlanSlug: null,
    });
    readHeldWorkItems.mockResolvedValue([
      { id: 'WI-6747', title: 'dossier rail', harness: 'papercusp', checkpoint: null },
    ]);
    resolveSessionStates.mockResolvedValue(
      new Map([['su-1', { ownerId: 'su-1', sessionState: 'live', liveTurn: true }]]),
    );

    const out = await getAgentSignals('su-1');

    expect(out.liveness).toEqual({ sessionState: 'live', liveTurn: true });
    expect(resolveSessionStates).toHaveBeenCalledTimes(1);
    expect(resolveSessionStates).toHaveBeenCalledWith([
      {
        ownerId: 'su-1',
        heartbeatAt: '2026-08-23T17:00:00.000Z',
        stale: false,
        host: 'devbox',
        pid: 4242,
        source: 'psu',
        agentRole: 'su',
        claimsHeld: true,
      },
    ]);
    expect(out.unavailableSignals).not.toContain('liveness');
  });

  it('marks liveness unavailable when the shared oracle returns no verdict', async () => {
    resolveSessionStates.mockResolvedValue(new Map());
    const out = await getAgentSignals('su-1');
    expect(out.liveness).toBeNull();
    expect(out.unavailableSignals).toEqual(['liveness']);
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
    // presence resolves to null here, so there is no activity timestamp to judge
    // progress from — 'unknown', NOT a guessed 'stalled' (P-009 leg c).
    expect(out.currentClaim).toEqual({
      id: 'WI-5993',
      title: 'do the thing',
      harness: 'papercusp',
      progress: 'unknown',
      idleSec: null,
    });
    expect(out.lastCheckpoint).toEqual({ text: 'in progress', updatedAtMs: NOW });
    expect(out.unavailableSignals).toEqual([]);
  });

  it('getLoopStatus throwing marks ONLY `loop` unavailable, independent of the other five signals', async () => {
    getLoopStatus.mockRejectedValue(new Error('routine lookup failed'));
    readHeldWorkItems.mockResolvedValue([{ id: 'WI-1', title: 't', harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null }]);
    const out = await getAgentSignals('su-1');
    expect(out.loop).toBeNull();
    expect(out.unavailableSignals).toEqual(['loop']);
    expect(out.currentClaim).toMatchObject({ id: 'WI-1', title: 't', harness: 'papercusp' });
  });

  it('every one of the signals can throw independently and all are reported, not just the first', async () => {
    getLoopStatus.mockRejectedValue(new Error('a'));
    readHeldWorkItems.mockRejectedValue(new Error('b'));
    getPresence.mockRejectedValue(new Error('c'));
    fetchUnansweredDirected.mockRejectedValue(new Error('d'));
    lastToolCallAtByOwner.mockRejectedValue(new Error('e'));
    fetchPresenceFleet.mockRejectedValue(new Error('f'));
    listActiveAnnouncements.mockRejectedValue(new Error('g'));
    resolveSessionStates.mockRejectedValue(new Error('h'));
    const out = await getAgentSignals('su-1');
    expect(new Set(out.unavailableSignals)).toEqual(
      new Set([
        'loop',
        'liveness',
        'currentClaim',
        'context',
        'unanswered',
        'lastToolCall',
        'fleetControl',
        'announcedGates',
      ]),
    );
  });

  // ── P-009 wiring: the three new legs on the SAME best-effort contract ──────

  it('a declared plan produces a lane; the plan read THROWING is distinguishable from having no plan', async () => {
    getPresence.mockResolvedValue({ currentPlanSlug: 'hud-redesign', lastActiveAt: null });
    readPlanBySlug.mockResolvedValue({
      parsed: {
        now: { state: 'Rail density', next: 'P-004' },
        items: [
          { id: 'P-001', text: 'done one', storedStatus: 'done', blockedBy: [] },
          { id: 'P-002', text: 'pick me', storedStatus: 'todo', blockedBy: [], phase: 'Phase 2' },
        ],
      },
      archived: false,
      row: {},
    });
    const out = await getAgentSignals('su-1');
    expect(out.lane).toMatchObject({
      planSlug: 'hud-redesign',
      nowState: 'Rail density',
      nextActionable: { id: 'P-002', title: 'pick me', phase: 'Phase 2' },
      claimableCount: 1,
    });
    expect(out.unavailableSignals).toEqual([]);

    // ...and a THROWN plan read reports itself rather than looking lane-less.
    readPlanBySlug.mockRejectedValue(new Error('plan store down'));
    const broken = await getAgentSignals('su-1');
    expect(broken.lane).toBeNull();
    expect(broken.unavailableSignals).toEqual(['lane']);
  });

  it('an agent with no declared plan reports lane:null WITHOUT marking it unavailable (and never reads the plan store)', async () => {
    const out = await getAgentSignals('su-1');
    expect(out.lane).toBeNull();
    expect(out.unavailableSignals).not.toContain('lane');
    expect(readPlanBySlug).not.toHaveBeenCalled();
  });

  it('surfaces a visible gate the agent is NOT awaiting, and marks the one it is', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-1', { fleetSlug: 'atlas', fleetRole: 'bee' }]]));
    listActiveAnnouncements.mockResolvedValue([
      { eventKey: 'fleet:atlas:gate-green', note: 'suite', scopeKind: 'fleet', scopeRef: 'atlas', subscriberId: 'su-lead' },
      { eventKey: 'fleet:other:nope', note: null, scopeKind: 'fleet', scopeRef: 'other', subscriberId: 'su-x' },
    ]);
    listActiveAwaits.mockResolvedValue([{ eventKey: 'fleet:atlas:gate-green' }]);
    const out = await getAgentSignals('su-1');
    // Another fleet's gate is not visible to this agent at all.
    expect(out.announcedGates.map((g) => g.event)).toEqual(['fleet:atlas:gate-green']);
    expect(out.announcedGates[0]).toMatchObject({ awaited: true, scope: 'fleet:atlas' });
  });

  it('fleetControl is null for an ACTIVE fleet — its presence is the news, so an active fleet says nothing', async () => {
    fetchPresenceFleet.mockResolvedValue(new Map([['su-1', { fleetSlug: 'atlas', fleetRole: 'bee' }]]));
    getFleet.mockResolvedValue({ controlState: 'active', controlReason: null, controlBy: null, controlAt: null });
    expect((await getAgentSignals('su-1')).fleetControl).toBeNull();

    getFleet.mockResolvedValue({
      controlState: 'winding-down',
      controlReason: 'plan complete',
      controlBy: 'su-lead',
      controlAt: NOW,
    });
    expect((await getAgentSignals('su-1')).fleetControl).toEqual({
      fleet: 'atlas',
      state: 'winding-down',
      reason: 'plan complete',
      by: 'su-lead',
      since: NOW,
    });
  });
});

// ─────────────────── P-009 pure derivations (no mocks needed) ───────────────

describe('deriveClaimProgress (P-009 leg c)', () => {
  const T = 1_700_000_000_000;

  it('reads fresh activity as progressing and stale activity as stalled, at the SHARED threshold', () => {
    // INTENT_STALE_SEC defaults to 30m — the same threshold coord:presence and
    // the leader-brief judge a stalled lane with. Bracket it on both sides
    // rather than testing one arbitrary point.
    expect(deriveClaimProgress(new Date(T - 60_000).toISOString(), T)).toEqual({
      progress: 'progressing',
      idleSec: 60,
    });
    expect(deriveClaimProgress(new Date(T - 40 * 60_000).toISOString(), T)).toEqual({
      progress: 'stalled',
      idleSec: 2400,
    });
  });

  it('returns unknown — never a guessed stall — when there is no activity timestamp to judge', () => {
    // The distinction that matters: "we cannot tell" must not render as
    // "this agent has stopped", which is an accusation the data does not support.
    expect(deriveClaimProgress(null, T)).toEqual({ progress: 'unknown', idleSec: null });
    expect(deriveClaimProgress(undefined, T)).toEqual({ progress: 'unknown', idleSec: null });
    expect(deriveClaimProgress('not-a-date', T)).toEqual({ progress: 'unknown', idleSec: null });
  });

  it('clamps a future timestamp to 0 rather than emitting negative idle', () => {
    // Clock skew across hosts is real here; a "-12s idle" reads as corruption.
    expect(deriveClaimProgress(new Date(T + 12_000).toISOString(), T)).toEqual({
      progress: 'progressing',
      idleSec: 0,
    });
  });
});

describe('deriveLane (P-009 leg a)', () => {
  const items = [
    { id: 'P-001', text: 'shipped', effectiveStatus: 'done', unresolvedBlockers: [], needsHuman: false },
    { id: 'P-002', text: 'blocked one', effectiveStatus: 'todo', unresolvedBlockers: ['P-001'], needsHuman: false },
    { id: 'P-003', text: 'owner must ratify', effectiveStatus: 'todo', unresolvedBlockers: [], needsHuman: true },
    { id: 'P-004', text: 'first pickable', effectiveStatus: 'todo', unresolvedBlockers: [], needsHuman: false, phase: 'Phase 3' },
    { id: 'P-005', text: 'also pickable', effectiveStatus: 'todo', unresolvedBlockers: [], needsHuman: false },
  ];

  it('counts ONLY genuinely actionable items — blocked and needs-human are not claimable', () => {
    const lane = deriveLane('hud-redesign', { state: 'S', next: 'N' }, items);
    expect(lane.nextActionable).toEqual({ id: 'P-004', title: 'first pickable', phase: 'Phase 3' });
    // 2, not 4: P-002 has an unresolved blocker and P-003 needs a human. Counting
    // raw `todo` here is the exact over-count the shared resolver prevents.
    expect(lane.claimableCount).toBe(2);
  });

  it('a live plan with nothing pickable reports count 0 WITH its Now block — the state a lone nextActionable cannot express', () => {
    const lane = deriveLane('p', { state: 'Blocked on review', next: null }, [items[0], items[1]]);
    expect(lane.nextActionable).toBeNull();
    expect(lane.claimableCount).toBe(0);
    expect(lane.nowState).toBe('Blocked on review');
  });

  it('normalizes blank/whitespace Now lines to null so the UI never renders a labelled blank', () => {
    const lane = deriveLane('p', { state: '   ', next: '' }, []);
    expect(lane.nowState).toBeNull();
    expect(lane.nowNext).toBeNull();
    expect(deriveLane('p', null, []).nowState).toBeNull();
  });

  // P-010 / D-006: the dossier now accepts a plan from the LAUNCH RECORD when
  // the agent never declared one (matching the roster's own
  // `currentPlanSlug ?? adv.planSlug` chain). The two legs are not equally
  // strong — a launch plan is fixed at spawn and can be stale — so the lane
  // carries which one answered rather than presenting them identically.
  it('reports where the plan came from, defaulting to declared', () => {
    expect(deriveLane('p', null, []).source).toBe('declared');
    expect(deriveLane('p', null, [], 'declared').source).toBe('declared');
    expect(deriveLane('p', null, [], 'launch').source).toBe('launch');
  });
});

describe('deriveAnnouncedGates (P-009 leg b)', () => {
  const gate = (eventKey: string, scopeKind: string | null = null, scopeRef: string | null = null) => ({
    eventKey,
    note: null,
    scopeKind,
    scopeRef,
    subscriberId: 'su-lead',
  });

  it('flags a declared gate the agent is not listening for, and sorts it AHEAD of awaited ones', () => {
    const out = deriveAnnouncedGates([gate('awaited-one'), gate('nobody-listening')], ['awaited-one']);
    // The actionable half reads first — a gate nobody awaits is the finding.
    expect(out.map((g) => [g.event, g.awaited])).toEqual([
      ['nobody-listening', false],
      ['awaited-one', true],
    ]);
  });

  it('matches keys EXACTLY — a near-miss key must surface as not-awaited, because it will not rendezvous at runtime', () => {
    // `phase3_ready` vs `phase-3-ready` never fires for the waiter. Collapsing
    // them here (as normalizeEventKey would) hides precisely the bug this split
    // exists to expose, so the strict comparison is deliberate.
    const out = deriveAnnouncedGates([gate('phase-3-ready')], ['phase3_ready']);
    expect(out[0].awaited).toBe(false);
  });

  it('renders scope as kind:ref, and a scope-less announcement as global', () => {
    const out = deriveAnnouncedGates([gate('a', 'plan', 'my-plan'), gate('b')], []);
    expect(out.map((g) => g.scope)).toEqual(['plan:my-plan', 'global']);
  });
});

// ── Dynamically pushed context (P-011/P-012) ────────────────────────────────
// The shaping is pure by design so it tests without PG, per this module's
// contract. The tri-state leg assertions below are CONTROLS, not coverage
// padding: `null` (never recorded) and `false` (recorded, did not run) are
// opposite conclusions about retrieval health, and collapsing them is the
// specific defect this section was built to expose.
describe('legRan (P-013 tri-state)', () => {
  it('reports a leg that RAN', () => {
    expect(legRan({ cosine: { ran: true } }, 'cosine')).toBe(true);
  });

  it('reports a leg that was recorded and did NOT run', () => {
    expect(legRan({ lexical: { ran: false } }, 'lexical')).toBe(false);
  });

  it('returns null — NOT false — when the leg was never recorded', () => {
    // A pre-P-002 row. `false` here would report a degradation nobody observed.
    expect(legRan({ cosine: { ran: true } }, 'lexical')).toBeNull();
    expect(legRan(null, 'cosine')).toBeNull();
    expect(legRan(undefined, 'cosine')).toBeNull();
  });

  it('returns null for a non-boolean `ran`, rather than coercing it', () => {
    expect(legRan({ cosine: { ran: 'yes' } }, 'cosine')).toBeNull();
    expect(legRan({ cosine: 'ran' }, 'cosine')).toBeNull();
  });
});

describe('derivePushedContext', () => {
  const row = (over: Partial<PushedContextRow> = {}): PushedContextRow => ({
    created_at: '2026-08-09T09:20:27.665Z',
    surface: 'mid-turn',
    legs: { cosine: { ran: true }, lexical: { ran: false } },
    admission: { returned: 12, admitted: 1, truncated: true },
    ...over,
  });

  it('shapes the admission funnel and both leg marks', () => {
    const out = derivePushedContext({ rows: [row()], refRows: [], total: 1 });
    expect(out.events).toEqual([
      {
        at: '2026-08-09T09:20:27.665Z',
        surface: 'mid-turn',
        returned: 12,
        admitted: 1,
        truncated: true,
        semanticRan: true,
        lexicalRan: false,
      },
    ]);
  });

  it('keeps `count` the TRUE window total, not the carried slice', () => {
    // The Coord lesson [owner 2026-07-28]: a count must never name rows the
    // list cannot show — here it must name MORE, so the cap can say so.
    const out = derivePushedContext({ rows: [row(), row()], refRows: [], total: 57 });
    expect(out.count).toBe(57);
    expect(out.events).toHaveLength(2);
  });

  it('never lets `count` under-report the rows it is handed', () => {
    // A total that disagrees with the slice (a racing write) must not render
    // "showing 3 of 0" — the slice is the floor.
    expect(derivePushedContext({ rows: [row(), row(), row()], refRows: [], total: 0 }).count).toBe(3);
  });

  it('treats a missing admission blob as zeros rather than throwing', () => {
    const out = derivePushedContext({ rows: [row({ admission: null })], refRows: [], total: 1 });
    expect(out.events[0]).toMatchObject({ returned: 0, admitted: 0, truncated: false });
  });

  describe('detail block (WI-37549 — the funnel behind the summary counts)', () => {
    // The shape measured live 2026-08-09 on a real mid-turn row: this is the
    // row the dossier renders as "1 of 12 admitted · truncated · sem ✓ lex ✓".
    const rich = () =>
      row({
        admission: {
          returned: 12,
          admitted: 1,
          truncated: true,
          spent: 1009,
          budgetChars: 350,
          dropped: { dedup: 3, budget: 8, pack: 0, feedback: 0, workspace: 0, nearDuplicate: 0 },
          byLeg: { both: 0, cosineOnly: 1, lexicalOnly: 0 },
        },
        legs: {
          mode: 'cosine-gated',
          fused: 25,
          cosine: { ran: true, depth: 12, candidates: 25, qualifying: 25 },
          lexical: { ran: true, depth: 36, candidates: 108, qualifying: 0 },
        },
      });

    it('emits ONLY the stages that dropped something, in funnel order', () => {
      // A real row is four zeros and two numbers. Rendering all six buries the
      // two that explain where the rows went behind four that say nothing
      // happened — so the zeros never reach the wire.
      const out = derivePushedContext({ rows: [rich()], refRows: [], total: 1 });
      expect(out.events[0].detail?.dropped).toEqual([
        { stage: 'dedup', count: 3, why: ADMISSION_STAGE_SHORT_WHY.dedup },
        { stage: 'budget', count: 8, why: ADMISSION_STAGE_SHORT_WHY.budget },
      ]);
    });

    it('resolves each stage `why` from the funnel vocabulary, never a re-typed gloss', () => {
      const out = derivePushedContext({ rows: [rich()], refRows: [], total: 1 });
      for (const s of out.events[0].detail?.dropped ?? []) {
        expect(s.why).toBe(ADMISSION_STAGE_SHORT_WHY[s.stage as keyof typeof ADMISSION_STAGE_SHORT_WHY]);
        expect(s.why.length).toBeGreaterThan(0);
      }
    });

    it('carries the budget pair and per-leg counts the summary fields cannot say', () => {
      const out = derivePushedContext({ rows: [rich()], refRows: [], total: 1 });
      expect(out.events[0].detail).toMatchObject({
        spent: 1009,
        budgetChars: 350,
        mode: 'cosine-gated',
        fused: 25,
        byLeg: { both: 0, cosineOnly: 1, lexicalOnly: 0 },
        cosine: { candidates: 25, qualifying: 25, depth: 12 },
        lexical: { candidates: 108, qualifying: 0, depth: 36 },
      });
    });

    it('keeps a qualifying:0 leg as a REAL zero rather than dropping the key', () => {
      // The lexical leg ran, supplied 108 candidates and qualified none. That
      // zero is the whole reason the row's bare "lex ✓" misleads, so it must
      // survive to the UI — `optNumAt` must not treat 0 as absent.
      const out = derivePushedContext({ rows: [rich()], refRows: [], total: 1 });
      expect(out.events[0].detail?.lexical?.qualifying).toBe(0);
      expect(out.events[0].detail?.byLeg?.lexicalOnly).toBe(0);
    });

    it('gives a LEGACY row no detail block at all — never a block of zeros', () => {
      // The emission rule. A pre-P-002 row never measured the funnel, and
      // rendering "0 dropped by dedup, 0 by budget" would present a measurement
      // we never took as a measurement of nothing — the same conflation the
      // null-vs-false leg tri-state exists to prevent.
      const out = derivePushedContext({
        rows: [row({ admission: null, legs: null })],
        refRows: [],
        total: 1,
      });
      expect(out.events[0].detail).toBeUndefined();
      expect('detail' in out.events[0]).toBe(false);
    });

    it('gives a row carrying ONLY `ran` flags no detail block either', () => {
      // `semanticRan`/`lexicalRan` already say this. A block here would be pure
      // duplication on the wire and an empty panel in the UI.
      const out = derivePushedContext({ rows: [row()], refRows: [], total: 1 });
      expect(out.events[0].detail).toBeUndefined();
    });

    it('emits a block when the funnel recorded a REAL zero spend', () => {
      // `spent: 0` ("nothing was spent") and an absent `spent` ("we never
      // measured it") are different claims — the first must reach the panel.
      const out = derivePushedContext({
        rows: [row({ admission: { returned: 0, admitted: 0, spent: 0, budgetChars: 350 } })],
        refRows: [],
        total: 1,
      });
      expect(out.events[0].detail).toMatchObject({ spent: 0, budgetChars: 350 });
    });

    it('ignores a malformed dropped blob rather than throwing', () => {
      const out = derivePushedContext({
        rows: [row({ admission: { returned: 1, admitted: 1, dropped: 'nope' } })],
        refRows: [],
        total: 1,
      });
      expect(out.events[0].detail?.dropped).toBeUndefined();
    });
  });

  it('carries per-port ref COUNTS and drops empty ports', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [
        { port: 'mid-turn', refs: '30', kind: 'memory' },
        { port: 'turn-start', refs: 12, kind: 'memory' },
        { port: 'wake-brief', refs: '0', kind: 'memory' },
      ],
      total: 0,
    });
    expect(out.refsByPort).toEqual([
      { port: 'mid-turn', refs: 30, kind: 'memory' },
      { port: 'turn-start', refs: 12, kind: 'memory' },
    ]);
  });

  it('keeps the two ledgers COUNTABLE APART when they share a port label', () => {
    // Measured 2026-08-09: all 6 corpus ports also exist as memory ports, so
    // this collision is the normal case. Summing would report mem0 memories
    // and corpus pointers as one number — two different kinds of thing.
    const out = derivePushedContext({
      rows: [],
      refRows: [
        { port: 'mid-turn', refs: 30, kind: 'memory' },
        { port: 'mid-turn', refs: 8, kind: 'corpus' },
      ],
      total: 0,
    });
    expect(out.refsByPort).toEqual([
      { port: 'mid-turn', refs: 30, kind: 'memory' },
      { port: 'mid-turn', refs: 8, kind: 'corpus' },
    ]);
    // The guarantee in one line: no row absorbed another.
    expect(out.refsByPort.reduce((n, r) => n + r.refs, 0)).toBe(38);
    expect(out.refsByPort).toHaveLength(2);
  });

  it('orders merged ledger rows totally, so the row sequence cannot depend on which query resolved first', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [
        { port: 'claim', refs: 5, kind: 'corpus' },
        { port: 'turn-start', refs: 5, kind: 'memory' },
        { port: 'mid-turn', refs: 9, kind: 'corpus' },
        { port: 'claim', refs: 5, kind: 'memory' },
      ],
      total: 0,
    });
    expect(out.refsByPort).toEqual([
      { port: 'mid-turn', refs: 9, kind: 'corpus' },
      // refs tie → kind, then port. 'corpus' < 'memory', so claim/corpus leads.
      { port: 'claim', refs: 5, kind: 'corpus' },
      { port: 'claim', refs: 5, kind: 'memory' },
      { port: 'turn-start', refs: 5, kind: 'memory' },
    ]);
  });

  it('reports an UNREADABLE ledger instead of letting it read as "surfaced nothing"', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [{ port: 'mid-turn', refs: 30, kind: 'memory' }],
      total: 0,
      unavailable: ['corpus-surfaced-refs'],
    });
    // The sources that DID answer survive — a partial failure must not blank
    // the section the way `error` deliberately does for a total one.
    expect(out.refsByPort).toEqual([{ port: 'mid-turn', refs: 30, kind: 'memory' }]);
    expect(out.unavailable).toEqual(['corpus-surfaced-refs']);
    expect(out.error).toBeUndefined();
  });

  it('omits `unavailable` entirely when every ledger answered', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [{ port: 'mid-turn', refs: 1, kind: 'corpus' }],
      total: 0,
    });
    expect(out.unavailable).toBeUndefined();
  });

  it('normalises a Date created_at to ISO', () => {
    const out = derivePushedContext({ rows: [row({ created_at: new Date(0) })], refRows: [], total: 1 });
    expect(out.events[0].at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('normalises a raw PG timestamptz STRING to ISO, on both row kinds', () => {
    // Measured live 2026-08-09: these reads hand back `2026-08-09 09:12:26.944435-04`
    // — no T, no Z. The old passthrough shipped that as an "ISO" field, and it
    // hid because `new Date()` parses it, so the UI looked right.
    const out = derivePushedContext({
      rows: [row({ created_at: '2026-08-09 09:12:26.944435-04' })],
      refRows: [],
      total: 1,
      refDetail: [refRow({ surfaced_at: '2026-08-09 09:12:26.955934-04' })],
    });
    expect(out.events[0].at).toBe('2026-08-09T13:12:26.944Z');
    expect(out.refs[0].at).toBe('2026-08-09T13:12:26.955Z');
  });

  it('orders correctly even when one source hands back a Date and the other a PG string', () => {
    // The reason the fix above is load-bearing rather than cosmetic: this list
    // merges two result sets and compares `at` LEXICALLY, and 'T' > ' ', so an
    // unnormalised mix sorts the NEWER row last while looking perfectly sane.
    const out = derivePushedContext({
      rows: [],
      refRows: [],
      total: 0,
      refDetail: [
        refRow({ ref: 'older', surfaced_at: '2026-08-09 09:00:00.000000-04' }),
        refRow({ ref: 'newer', surfaced_at: new Date('2026-08-09T13:30:00.000Z') }),
      ],
    });
    expect(out.refs.map((r) => r.ref)).toEqual(['newer', 'older']);
  });

  it('leaves an UNPARSEABLE timestamp alone rather than rendering "Invalid Date"', () => {
    const out = derivePushedContext({ rows: [row({ created_at: 'not-a-timestamp' })], refRows: [], total: 1 });
    expect(out.events[0].at).toBe('not-a-timestamp');
  });

  // ── P-013: the per-ref rows ───────────────────────────────────────────────
  const refRow = (
    over: Partial<PushedContextRefDetailRow> = {},
  ): PushedContextRefDetailRow => ({
    ref: 'WI-6512',
    port: 'mid-turn',
    epoch: 3,
    surfaced_at: '2026-08-09T09:20:27.665Z',
    kind: 'corpus',
    ...over,
  });

  it('carries the HANDLE per row, with its port, epoch and moment', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [],
      total: 0,
      refDetail: [refRow({ surfaced_at: new Date(0) })],
    });
    expect(out.refs).toEqual([
      {
        ref: 'WI-6512',
        kind: 'corpus',
        port: 'mid-turn',
        at: '1970-01-01T00:00:00.000Z',
        epoch: 3,
      },
    ]);
  });

  it('orders merged ref rows totally, newest first', () => {
    // Same argument as refsByPort: two independently-sorted result sets. A
    // partial order would make the list depend on which query resolved first.
    const out = derivePushedContext({
      rows: [],
      refRows: [],
      total: 0,
      refDetail: [
        refRow({ ref: 'WI-2', surfaced_at: '2026-08-09T09:00:00.000Z' }),
        refRow({ ref: 'b', kind: 'memory', surfaced_at: '2026-08-09T10:00:00.000Z' }),
        refRow({ ref: 'WI-1', surfaced_at: '2026-08-09T10:00:00.000Z' }),
      ],
    });
    // Newest first; the tie breaks on kind ('corpus' < 'memory') then ref.
    expect(out.refs.map((r) => r.ref)).toEqual(['WI-1', 'b', 'WI-2']);
  });

  it('caps the carried refs while `refsTotal` still names the true total', () => {
    const out = derivePushedContext({
      rows: [],
      refRows: [{ port: 'mid-turn', refs: 200, rows: 200, kind: 'corpus' }],
      total: 0,
      refDetail: Array.from({ length: 60 }, (_, i) => refRow({ ref: `WI-${i}` })),
    });
    expect(out.refs).toHaveLength(40);
    expect(out.refsTotal).toBe(200);
  });

  it('sums `refsTotal` from RAW rows, never from the distinct-per-port counts', () => {
    // A ref surfaced at two ports is one DISTINCT ref in each group, so adding
    // the per-port distinct counts double-counts it. The raw row count is the
    // only summable one — this is the guard that keeps them from being swapped.
    const out = derivePushedContext({
      rows: [],
      refRows: [
        { port: 'mid-turn', refs: 9, rows: 11, kind: 'memory' },
        { port: 'turn-start', refs: 9, rows: 12, kind: 'memory' },
      ],
      total: 0,
    });
    expect(out.refsTotal).toBe(23);
  });

  it('never lets `refsTotal` under-report the refs it is handed', () => {
    // Same floor rule as `count` above: "showing 2 of 0" is not a thing.
    const out = derivePushedContext({
      rows: [],
      refRows: [],
      total: 0,
      refDetail: [refRow({ ref: 'WI-1' }), refRow({ ref: 'WI-2' })],
    });
    expect(out.refsTotal).toBe(2);
  });

  it('renders an UNRECORDED port as such, never as a port named "null"', () => {
    // corpus_session_surfaced.port is nullable. Measured 2026-08-09: 0 of
    // 33,485 rows in 24h were NULL — but the column permits it, and "we did not
    // record where this arrived" must not read as a real port label.
    const out = derivePushedContext({
      rows: [],
      refRows: [{ port: null, refs: 2, rows: 2, kind: 'corpus' }],
      total: 0,
      refDetail: [refRow({ port: null })],
    });
    expect(out.refs[0].port).toBe('(unrecorded)');
    expect(out.refsByPort[0].port).toBe('(unrecorded)');
  });

  it('leaves `refs` empty — never fabricated — when the ledgers hand over nothing', () => {
    const out = derivePushedContext({ rows: [row()], refRows: [], total: 1 });
    expect(out.refs).toEqual([]);
    expect(out.refsTotal).toBe(0);
  });
});

// ── Ref → title resolution ────────────────────────────────────────────────────
// [owner 2026-08-09] "the user doesn't care about the ids, it should show a
// title". The ledgers store handles, so titles resolve at READ time — these
// cover the pure halves plus the batched query's shape against a fake tag.

describe('classifyPushedRef', () => {
  it('trusts the LEDGER over the ref shape for memory rows', () => {
    // The ledger of origin is authoritative: a memory row is a memory even if
    // its key somehow looked like something else. Only corpus refs are free-form.
    expect(classifyPushedRef('0f8c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', 'memory')).toBe('memory');
    expect(classifyPushedRef('WI-6512', 'memory')).toBe('unknown');
  });

  it('recognises the work-item and session shapes the corpus ledger actually holds', () => {
    // Measured against harness_shared.corpus_session_surfaced 2026-08-09: both
    // the short and the 17-digit id families are live, and a fixed prefix list
    // would have to be edited every time a new one appears.
    expect(classifyPushedRef('WI-7005', 'corpus')).toBe('work-item');
    expect(classifyPushedRef('EI-19310032174584195', 'corpus')).toBe('work-item');
    expect(classifyPushedRef('claude:addaa2ae-bf06-4aeb-9e9f-8a8b30d1cebc', 'corpus')).toBe('session');
    expect(classifyPushedRef('codex:019f4520-8093-7e42-bfbf-638bf154dbdf', 'corpus')).toBe('session');
  });

  it('answers `unknown` rather than guessing, so an unrecognised ref still renders', () => {
    expect(classifyPushedRef('a bare sentence', 'corpus')).toBe('unknown');
    expect(classifyPushedRef('', 'corpus')).toBe('unknown');
  });
});

describe('applyPushedRefTitles', () => {
  const ref = (over: Partial<PushedContextRef> = {}): PushedContextRef => ({
    ref: 'WI-1',
    kind: 'corpus',
    port: 'mid-turn',
    at: '2026-08-09T00:00:00.000Z',
    epoch: 0,
    ...over,
  });

  it('leaves titleState UNDEFINED when resolution never ran', () => {
    // Distinct from "we looked and found nothing" — the pure-shaper path and any
    // pre-field payload must not report a finding they never measured.
    const out = applyPushedRefTitles([ref()], new Map(), { ran: false });
    expect(out[0].titleState).toBeUndefined();
    expect(out[0].title).toBeUndefined();
  });

  it('marks a ref UNRESOLVED when the lookup ran and matched nothing', () => {
    const out = applyPushedRefTitles([ref()], new Map(), { ran: true });
    expect(out[0].titleState).toBe('unresolved');
  });

  it('marks every ref UNAVAILABLE when the lookup itself failed', () => {
    // The two must not collapse: `unresolved` is a finding about the pointer,
    // `unavailable` is a gap in our own read and says nothing about the row.
    const out = applyPushedRefTitles([ref()], new Map(), { ran: true, failed: true });
    expect(out[0].titleState).toBe('unavailable');
    expect(out[0].title).toBeUndefined();
  });

  it('keys on kind+ref, so the two ledgers cannot answer for each other', () => {
    const resolved = new Map([['corpus:WI-1', { title: 'the corpus one' }]]);
    const out = applyPushedRefTitles([ref(), ref({ kind: 'memory' })], resolved, { ran: true });
    expect(out[0].title).toBe('the corpus one');
    expect(out[1].titleState).toBe('unresolved');
  });
});

describe('resolutionFromBody', () => {
  it('takes the first NON-EMPTY line as the title', () => {
    const res = resolutionFromBody('\n\nThe real first line\nand more below');
    expect(res?.title).toBe('The real first line');
    expect(res?.detail).toContain('and more below');
  });

  it('clamps with a VISIBLE ellipsis so a cut value cannot read as complete', () => {
    const res = resolutionFromBody('x'.repeat(400));
    expect(res?.title.endsWith('…')).toBe(true);
    expect(res?.title.length).toBeLessThanOrEqual(110);
  });

  it('returns null for an empty body rather than an empty title', () => {
    expect(resolutionFromBody('   \n  ')).toBeNull();
  });
});

describe('resolvePushedRefTitles', () => {
  /** A fake postgres tag that answers by which table the query names, so the
   *  test asserts the ROUTING (which store each ref class is asked of) without
   *  a database. */
  function fakeTag(answers: Record<string, unknown[]>) {
    const seen: string[] = [];
    const tag = (async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      seen.push(sql);
      for (const [table, rows] of Object.entries(answers)) {
        if (sql.includes(table)) return rows;
      }
      return [];
    }) as unknown as PushedRefSqlTag;
    return { tag, seen };
  }

  const refs: PushedContextRef[] = [
    { ref: 'WI-7005', kind: 'corpus', port: 'turn-start', at: 'a', epoch: 0 },
    { ref: 'claude:abc12345-0000-0000-0000-000000000000', kind: 'corpus', port: 'mid-turn', at: 'b', epoch: 1 },
    { ref: '0f8c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', kind: 'memory', port: 'mid-turn', at: 'c', epoch: 1 },
  ];

  it('resolves all three ref classes from their own stores', async () => {
    const { tag } = fakeTag({
      /* Column names as the LIVE relation has them — `status` not `state`,
         `item_kind` not `kind`. A fixture that mirrors the DTO instead of the
         table makes this suite green against SQL that cannot run (measured:
         all three names were wrong and every unit test still passed). */
      work_items: [{ feature_id: 'WI-7005', title: 'Gate red: skip-guard', item_kind: 'bug', status: 'open', summary: 'body' }],
      session_turns: [{ session_id: 'abc12345-0000-0000-0000-000000000000', text: 'For our public release I want…' }],
      memory_canonical: [{ id: '0f8c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', body: 'Papercusp host map\nmore', kind: 'reference' }],
    });
    const out = await resolvePushedRefTitles(tag, refs);
    expect(out.get('corpus:WI-7005')?.title).toBe('Gate red: skip-guard');
    // The work-item DETAIL carries the id + kind/state badge the row no longer
    // shows, which is what makes hiding it from the row safe.
    expect(out.get('corpus:WI-7005')?.detail).toContain('WI-7005');
    expect(out.get('corpus:WI-7005')?.detail).toContain('bug · open');
    expect(out.get('corpus:claude:abc12345-0000-0000-0000-000000000000')?.title).toContain('For our public release');
    expect(out.get('memory:0f8c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f')?.title).toBe('Papercusp host map');
  });

  it('uses the owner-visibility allow-list and neutralizes all-machine sessions', async () => {
    const ownerSession = 'a0ce0000-0000-0000-0000-000000000000';
    const machineSession = 'bace0000-0000-0000-0000-000000000000';
    const hookSession = 'c0de0000-0000-0000-0000-000000000000';
    const sessionRefs: PushedContextRef[] = [
      { ref: `claude:${ownerSession}`, kind: 'corpus', port: 'p', at: 'a', epoch: 0 },
      { ref: `claude:${machineSession}`, kind: 'corpus', port: 'p', at: 'a', epoch: 0 },
      { ref: `claude:${hookSession}`, kind: 'corpus', port: 'p', at: 'a', epoch: 0 },
    ];
    const { tag, seen } = fakeTag({
      session_turns: [
        {
          session_id: ownerSession,
          text: '⟦turn-origin:coord-inject:owner nonce:abcdef12⟧\nI asked for this title.\n\n⟦owner-chat⟧ machine note',
        },
        {
          session_id: machineSession,
          text: '⟦turn-origin:loop-fire nonce:abcdef12⟧\nAUTO mode wake instructions',
        },
        { session_id: hookSession, text: '  Stop hook feedback: retry the command' },
      ],
    });

    const out = await resolvePushedRefTitles(tag, sessionRefs);
    expect(out.get(`corpus:claude:${ownerSession}`)?.title).toBe('↳ I asked for this title.');
    expect(out.get(`corpus:claude:${ownerSession}`)?.detail).not.toContain('machine note');
    expect(out.get(`corpus:claude:${machineSession}`)?.title).toBe('machine-driven session');
    expect(out.get(`corpus:claude:${machineSession}`)?.detail).not.toContain('AUTO mode');
    expect(out.get(`corpus:claude:${hookSession}`)?.title).toBe('machine-driven session');

    const sessionQuery = seen.find((sql) => sql.includes('session_turns'));
    expect(sessionQuery).toContain('ORDER BY session_id');
    expect(sessionQuery).toContain('turn-origin:coord-inject:owner');
    expect(sessionQuery).toContain('Stop hook feedback:');
  });

  it('asks NOTHING when there is nothing of that class to ask about', async () => {
    // A batch of 40 memory refs must not fire an empty work-item query — and an
    // `= ANY('{}')` is not free on a table this size.
    const { tag, seen } = fakeTag({});
    await resolvePushedRefTitles(tag, [refs[2]]);
    expect(seen.some((s) => s.includes('work_items'))).toBe(false);
    expect(seen.some((s) => s.includes('session_turns'))).toBe(false);
    expect(seen.some((s) => s.includes('memory_canonical'))).toBe(true);
  });

  it('skips a row whose body is NULL instead of emitting an empty title', async () => {
    const { tag } = fakeTag({
      memory_canonical: [{ id: '0f8c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', body: null, kind: null }],
    });
    const out = await resolvePushedRefTitles(tag, [refs[2]]);
    // Absent from the map → `applyPushedRefTitles` marks it `unresolved`, which
    // is the honest reading: the row exists but carries nothing to show.
    expect(out.size).toBe(0);
  });

  it('does not resolve a ref shape it does not recognise', async () => {
    const { tag, seen } = fakeTag({});
    const out = await resolvePushedRefTitles(tag, [
      { ref: 'not a handle', kind: 'corpus', port: 'p', at: 'a', epoch: 0 },
    ]);
    expect(out.size).toBe(0);
    expect(seen.length).toBe(0);
  });
});
