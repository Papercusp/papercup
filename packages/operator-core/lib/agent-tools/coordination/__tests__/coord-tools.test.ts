/**
 * coord-tools.test.ts — plan harness-test-coverage-for-launch P-026.
 *
 * The coord TOOL handlers wrap the (already-tested) channel library + identity.
 * This pins the handler envelopes for whoami / thread / ack over an in-memory
 * coordLog with a mocked identity — the layer that had no coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { InMemoryWatermarkStore } from '@papercusp/coordination/watermark-store';
import { configureCoordLog, resetCoordLog } from '../log';
import {
  configureWatermarkStore,
  resetWatermarkStore,
  readWatermark,
  writeWatermark,
  emptyWatermark,
} from '../watermarks';
import { sendMessage } from '../messages';
import type { AgentIdentity } from '../identity';

const ME: AgentIdentity = {
  ownerId: 'me',
  ownerLabel: 'Me',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};
// whoami also reads named-fleet membership from `../identity` (P-005); mock the
// full module surface it consumes — no fleet env in the unit harness ⇒ no fleet.
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ME,
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));

// The handoff handler resolves short ownerId prefixes against the live presence
// roster (a PG read). For these in-memory handler tests the resolver is a
// deterministic pass-through — its own roster matching is covered elsewhere, and
// we only assert the handler wiring (open → accept → list).
//
// EI-10011: this is a FULL-module mock (no importOriginal), so every export
// `../inbox-wake.ts` pulls from `../recipient-resolve` must be present here too,
// not just the one this suite's own assertions touch — coord:handoff's
// fire-and-forget wake-on-open calls into inbox-wake.ts's wakeRecipients(),
// which imports `isSelectorOrWildcard` and `knownOwnerIdSet` alongside
// `resolveBestEffortAgainstRoster`. EI-9971 added `knownOwnerIdSet` to the real
// module and wired it into inbox-wake.ts without this mock being updated to
// match — the missing export threw ("No 'knownOwnerIdSet' export..."), caught
// by handoff.ts's fail-soft try/catch, which console.warn'd and tripped
// vitest-fail-on-console (the actual observed failure had nothing to do with
// the warn itself). `isSelectorOrWildcard` is pure and stable — reused verbatim
// rather than re-implemented; `knownOwnerIdSet` mocks to `null` (the
// "roster check unavailable/skip" default — mirrors inbox-wake.test.ts's own
// `vi.fn(async () => null)` convention).
vi.mock('../recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (to: string[]) => [...to],
  isSelectorOrWildcard: (id: string) => id === '*' || id === 'human' || id === '' || id.startsWith('@'),
  knownOwnerIdSet: async () => null,
}));

// coord:handoff opens a durable handoff and then fire-and-forget wakes the
// recipient through the event-await engine. This suite exercises handler
// envelopes against in-memory coordination stores; keep the PG-backed wake
// engine at its unit-test seam (the dedicated handoff suite tests that wiring).
vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async ({ key }: { key: string }) => ({
    ok: true,
    key,
    woken: 1,
    notified: [],
    msgId: null,
  })),
}));

import whoamiTool from '../tools/whoami';
import { boundInboxEntries } from '../tools/inbox';
import ackTool from '../tools/ack';
import threadTool from '../tools/thread';
import watermarkTool from '../tools/watermark';
import escalateTool from '../tools/escalate';
import escalationsTool from '../tools/escalations';
import resolveTool from '../tools/resolve';
import handoffTool from '../tools/handoff';
import handoffsTool from '../tools/handoffs';

const id = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: ownerId,
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, args: Record<string, unknown> = {}) => tool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => (res.data ?? JSON.parse(res.content[0].text));

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  configureWatermarkStore(new InMemoryWatermarkStore());
});
afterEach(() => {
  resetCoordLog();
  resetWatermarkStore();
});

describe('coord:whoami', () => {
  it('returns the server-resolved coordination identity', async () => {
    expect(parse(await run(whoamiTool))).toMatchObject({ ownerId: 'me', source: 'omp-hook-session' });
  });
  // EI-1748 graceful-degrade path (resolveAgentIdentity throws → whoami returns
  // {resolved:false,...} instead of a structural error) is verified by inspection;
  // a unit test needs a throw-injecting identity mock (this suite mocks it to a
  // fixed ME), so it's left as a follow-up rather than restructuring the shared mock.
});

describe('boundInboxEntries (EI-1752)', () => {
  it('truncates long summary/body to maxChars + flags them; leaves short fields', () => {
    const long = 'x'.repeat(1000);
    const [e] = boundInboxEntries([{ summary: long, body: 'short', kind: 'message' }], 600);
    expect((e.summary as string).length).toBe(600);
    expect(e.summary_truncated).toBe(true);
    expect(e.summary_full_chars).toBe(1000);
    expect(e.body).toBe('short');
    expect(e.body_truncated).toBeUndefined();
  });
  it('maxChars<=0 disables truncation (full passthrough)', () => {
    const long = 'y'.repeat(1000);
    const [e] = boundInboxEntries([{ summary: long, kind: 'message' }], 0);
    expect((e.summary as string).length).toBe(1000);
    expect(e.summary_truncated).toBeUndefined();
  });
});

describe('coord:thread', () => {
  it('reconstructs the thread rooted at a message (root + its ack)', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'heads up' });
    await sendMessage(id('bob'), { to: ['alice'], kind: 'ack', related_msg_id: m.msg_id });

    const body = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(body.root).toBe(m.msg_id);
    const ids = body.entries.map((e: { msg_id: string }) => e.msg_id);
    expect(ids).toContain(m.msg_id);
    expect(body.entries.some((e: { kind: string }) => e.kind === 'ack')).toBe(true);
  });
});

describe('coord:ack', () => {
  it('acks a real message back to its sender', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'please review' });
    const body = parse(await run(ackTool, { msg_id: m.msg_id }));
    // Bulk envelope (bulk-endpoint-standardization-2026-06-21): one ack is n=1 of
    // the batch; the per-message result self-describes under results[0].
    expect(body.ok).toBe(true);
    expect(body.results[0].acked).toBe(m.msg_id);
    expect(body.results[0].acked_from).toBe('alice'); // addressed back at the sender
    expect(body.results[0].ack_msg_id).toBeTruthy();

    // The ack is now in the thread.
    const thread = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(thread.entries.some((e: { kind: string; from: string }) => e.kind === 'ack' && e.from === 'me')).toBe(true);
  });

  it('returns a per-item unknown_msg_id for a msg_id that does not exist', async () => {
    const res = await run(ackTool, { msg_id: 'never' });
    // Bulk verbs never set top-level isError; a bad item surfaces under results[i].
    expect(parse(res)).toMatchObject({ ok: true, results: [{ ok: false, error: 'unknown_msg_id' }] });
  });
});

// ── C3: the watermark HANDLERS (the store watermarks.ts is tested separately;
// these pin the tool wrappers — identity resolution + the partial-patch path +
// the envelope shape). Run over an InMemoryWatermarkStore.
// ── `coord:watermark-set` RETIRED — plan fleet-deltas-leader-primitives-2026-07-10,
// D-014. It was the client-REPORTED cursor write, with exactly one caller (the OMP
// hook's `onTurnEnd`), which meant no Claude/Codex session ever wrote the cursor at
// all. Both pointers it carried now settle SERVER-side from the authoritative read
// receipt: `messages_since_ts` at `journal:record-turn` (turn-end-tracking-io.ts,
// which fires on every CLI), and plan-events via the server-side read cursors.
//
// Its two cases here tested the tool's ARG ROUTING and its partial-patch behaviour.
// Arg routing died with the args. The partial-patch property belongs to
// `writeWatermark` itself, not to the deleted wrapper, so it is pinned directly —
// otherwise retiring the verb would silently drop a real invariant, which is how a
// deletion quietly widens the blast radius of the NEXT change.
describe('writeWatermark — partial patch (survives the coord:watermark-set retirement)', () => {
  it('is a partial patch — omitted fields keep their prior value', async () => {
    await writeWatermark('me', {
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      escalations_since_ts: '2026-06-16T11:00:00.000Z',
    });
    // A second write carrying ONLY messages_since_ts must not clobber escalations.
    await writeWatermark('me', { messages_since_ts: '2026-06-16T20:00:00.000Z' });
    const wm = await readWatermark('me');
    expect(wm.messages_since_ts).toBe('2026-06-16T20:00:00.000Z'); // advanced
    expect(wm.escalations_since_ts).toBe('2026-06-16T11:00:00.000Z'); // preserved
  });
});

describe('coord:watermark (the turn-start read handler)', () => {
  it('reads the caller\'s persisted watermark + carries owner_id in the envelope', async () => {
    await writeWatermark('me', { messages_since_ts: '2026-06-16T09:00:00.000Z' });
    const body = parse(await run(watermarkTool));
    expect(body.owner_id).toBe('me');
    expect(body.watermark.messages_since_ts).toBe('2026-06-16T09:00:00.000Z');
  });

  it('a never-written owner reads an empty watermark', async () => {
    const body = parse(await run(watermarkTool));
    expect(body.owner_id).toBe('me');
    expect(body.watermark).toEqual(emptyWatermark());
  });
});

// ── C4: the escalate / escalations / handoff / handoffs HANDLERS (the lib
// escalations.ts / handoffs.ts is tested separately; these pin the tool
// wrappers over an InMemoryCoordLog). The spawn-gate routing case is the
// security-relevant one (P1).
describe('coord:escalate handler', () => {
  it('maps severity / options / plan_slug onto an open escalation record', async () => {
    const body = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'need a human call',
        body: 'detail',
        plan_slug: 'plan-x-2026-06-16',
        options: [
          { id: 'go', label: 'Go' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.msg_id).toBeTruthy();

    const open = parse(await run(escalationsTool, { status: 'open' }));
    const rec = open.escalations.find((e: { msg_id: string }) => e.msg_id === body.msg_id);
    expect(rec).toBeTruthy();
    expect(rec.severity).toBe('blocker');
    expect(rec.summary).toBe('need a human call');
    expect(rec.plan_slug).toBe('plan-x-2026-06-16');
    expect(rec.options).toHaveLength(2);
    expect(rec.to).toEqual(['human']); // the channel always addresses the human
    expect(rec.resolved).toBeNull();
  });

  // The escalation-flood fix: a watchdog re-checking the SAME condition on a cadence
  // writes a summary carrying a live count/duration, so the summary-derived dedup
  // signature never repeats and every wake used to leak a new permanently-open row.
  // A stable conditionKey must collapse those firings onto ONE open escalation.
  it('coalesces re-fires of the same conditionKey onto one open row, even as the summary changes', async () => {
    const first = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled ~7h — 8 auto-eligible items stuck',
        conditionKey: 'mug-placement-stall',
      }),
    );
    const second = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled ~10h — 12 auto-eligible items stuck',
        conditionKey: 'mug-placement-stall',
      }),
    );
    expect(second.msg_id).toBe(first.msg_id); // same row, bumped — not a new one

    // Exactly one open row survives both firings — the leak this key exists to stop.
    // (repeatCount/lastSeenTs are asserted only here as "not a second row": the bump is
    // PERSISTED by the PG projection path, while the append-only in-memory fold this
    // double exercises can only return a bumped view — it must not rewrite a past event.)
    const open = parse(await run(escalationsTool, { status: 'open' }));
    const mine = open.escalations.filter(
      (e: { msg_id: string }) => e.msg_id === first.msg_id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].summary).toBe('Mug stalled ~7h — 8 auto-eligible items stuck');
  });

  it('still opens distinct rows for distinct conditionKeys', async () => {
    const a = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled',
        conditionKey: 'mug-placement-stall',
      }),
    );
    const b = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Work feed dead',
        conditionKey: 'work-feed-dead',
      }),
    );
    expect(b.msg_id).not.toBe(a.msg_id);
  });

  // Without a key the old behavior stands: two differently-worded escalations are
  // two rows. This is what makes the key necessary — it is not a regression.
  it('without a conditionKey, differently-worded re-fires still open separate rows', async () => {
    const a = parse(
      await run(escalateTool, { severity: 'blocker', summary: 'Mug stalled ~7h' }),
    );
    const b = parse(
      await run(escalateTool, { severity: 'blocker', summary: 'Mug stalled ~10h' }),
    );
    expect(b.msg_id).not.toBe(a.msg_id);
  });
});

describe('coord:escalations handler status filter', () => {
  it('filters open vs resolved', async () => {
    const e1 = parse(await run(escalateTool, { severity: 'advisory', summary: 'a' }));
    await run(escalateTool, { severity: 'question', summary: 'b' });
    // Resolve the first via the resolve handler.
    const resolved = parse(await run(resolveTool, { msg_id: e1.msg_id, choice: 'ok' }));
    expect(resolved.ok).toBe(true);

    const open = parse(await run(escalationsTool, { status: 'open' }));
    expect(open.escalations.map((e: { summary: string }) => e.summary)).toEqual(['b']);
    const done = parse(await run(escalationsTool, { status: 'resolved' }));
    expect(done.escalations.map((e: { summary: string }) => e.summary)).toEqual(['a']);
  });
});

describe('coord:handoff + coord:handoffs handlers (open → accept → list filter)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Opening a handoff to a concrete addressee fires the wake-on-open fanout,
    // which has no wake infra under the InMemoryCoordLog and fail-softs with a
    // `[coord:handoff] wake-on-open … failed` warn — expected noise, not a failure.
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('opens a handoff, accepts it, and the listing filters by status', async () => {
    const opened = parse(
      await run(handoffTool, {
        to: ['B'],
        plan_slug: 'plan-h-2026-06-16',
        summary: 'phase 1 done',
        next_action: 'pick up phase 2',
        files_modified: ['lib/foo.ts'],
      }),
    );
    expect(opened.ok).toBe(true);
    expect(opened.msg_id).toBeTruthy();

    // Open before acceptance.
    const openList = parse(await run(handoffsTool, { status: 'open' }));
    expect(openList.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id)).toContain(
      opened.msg_id,
    );

    // Accept via the same tool with accept_msg_id (takes the accept branch).
    const accepted = parse(await run(handoffTool, { accept_msg_id: opened.msg_id, note: 'on it' }));
    expect(accepted.ok).toBe(true);
    expect(accepted.accepted.kind).toBe('handoff_accepted');
    expect(accepted.accepted.related_msg_id).toBe(opened.msg_id);

    // Now it lists as accepted and no longer as open.
    const acceptedList = parse(await run(handoffsTool, { status: 'accepted' }));
    expect(
      acceptedList.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id),
    ).toContain(opened.msg_id);
    const openAfter = parse(await run(handoffsTool, { status: 'open' }));
    expect(
      openAfter.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id),
    ).not.toContain(opened.msg_id);
  });

  it('open-handoff missing required fields → missing_fields (isError)', async () => {
    const res = await run(handoffTool, { summary: 'incomplete' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: 'missing_fields' });
  });

  it('accept of an unknown msg_id → not_found (isError)', async () => {
    const res = await run(handoffTool, { accept_msg_id: 'never' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: 'not_found' });
  });
});
