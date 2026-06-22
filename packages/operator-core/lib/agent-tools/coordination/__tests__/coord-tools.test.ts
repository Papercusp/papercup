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
vi.mock('../identity', () => ({ resolveAgentIdentity: () => ME }));

// The handoff handler resolves short ownerId prefixes against the live presence
// roster (a PG read). For these in-memory handler tests the resolver is a
// deterministic pass-through — its own roster matching is covered elsewhere, and
// we only assert the handler wiring (open → accept → list).
vi.mock('../recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (to: string[]) => [...to],
}));

import whoamiTool from '../tools/whoami';
import { boundInboxEntries } from '../tools/inbox';
import ackTool from '../tools/ack';
import threadTool from '../tools/thread';
import watermarkTool from '../tools/watermark';
import watermarkSetTool from '../tools/watermark-set';
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
const parse = (res: any) => JSON.parse(res.content[0].text);

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
describe('coord:watermark-set (the turn-end advance handler)', () => {
  it('routes each *_since_ts arg + subscriptions_fired into writeWatermark under the right key', async () => {
    const res = await run(watermarkSetTool, {
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      escalations_since_ts: '2026-06-16T11:00:00.000Z',
      plan_events_since_ts: '2026-06-16T12:00:00.000Z',
      subscriptions_fired: ['m1', 'm2'],
    });
    const body = parse(res);
    expect(body.ok).toBe(true);
    expect(body.owner_id).toBe('me'); // from the mocked identity
    // The handler's envelope carries the persisted watermark…
    expect(body.watermark).toMatchObject({
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      escalations_since_ts: '2026-06-16T11:00:00.000Z',
      plan_events_since_ts: '2026-06-16T12:00:00.000Z',
      subscriptions_fired: ['m1', 'm2'],
    });
    // …and it actually reached the store under the caller's owner id.
    expect(await readWatermark('me')).toMatchObject({
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      subscriptions_fired: ['m1', 'm2'],
    });
  });

  it('is a partial patch — omitted fields are absent from the write, keeping their prior value', async () => {
    // Seed two cursors.
    await run(watermarkSetTool, {
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      escalations_since_ts: '2026-06-16T11:00:00.000Z',
    });
    // A second call carrying ONLY messages_since_ts must not clobber escalations.
    await run(watermarkSetTool, { messages_since_ts: '2026-06-16T20:00:00.000Z' });
    const wm = await readWatermark('me');
    expect(wm.messages_since_ts).toBe('2026-06-16T20:00:00.000Z'); // advanced
    expect(wm.escalations_since_ts).toBe('2026-06-16T11:00:00.000Z'); // preserved
  });
});

describe('coord:watermark (the turn-start read handler)', () => {
  it('reads the caller\'s persisted watermark + carries owner_id in the envelope', async () => {
    await run(watermarkSetTool, { messages_since_ts: '2026-06-16T09:00:00.000Z' });
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
