/**
 * handoff.test.ts — coord:handoff wake-on-open (coord-dispatch-reliability P-003).
 *
 * The OPEN path was asymmetric: opening a handoff only INJECTED to the recipient's
 * inbox; an IDLE recipient never woke, never accepted, so the offerer's own
 * accept-wake (`handoff:accepted:<id>`) never fired → a silent stall. P-003 wakes
 * the resolved recipient(s) on open so a sleeping addressee gets a turn to accept,
 * starting the accept→wake-offerer chain. This pins:
 *   - wake-on-open fires the recipients' inbox-wake keys (one per concrete ownerId),
 *   - FAIL-SOFT: a wake throw never fails the open (the handoff is already recorded),
 *   - selectors/wildcards ('*'/'human') are skipped (no thunder-herd),
 *   - liveness is surfaced in the result (woken / recipient_absent), parallel to the
 *     coord:send notWoken signal, so the offerer learns if nobody was re-invoked.
 *
 * The wake pump + roster are mocked at the module seam (we assert WHICH keys fire,
 * not the live pump — that substrate is tested by deliver-and-wake/unify-watch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';

// ── Mock the wake pump seam: capture every emit key, default woken:1 per emit. ──
const emitAwaitedEvent = vi.fn(async ({ key }: { key: string }) => ({
  ok: true as const,
  key,
  woken: 1,
  notified: [] as string[],
  msgId: null,
}));
vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: (args: { key: string }) => emitAwaitedEvent(args),
}));
// The roster: resolveBestEffortAgainstRoster (open path) + wakeRecipients both read
// it. Return the concrete addressees so prefix-resolution is a passthrough.
const listPresence = vi.fn(async () => [
  { ownerId: 'su-bee-1' },
  { ownerId: 'su-bee-2' },
]);
vi.mock('../presence', () => ({
  listPresence: () => listPresence(),
}));
// Pin wake-mode to `auto` + stub staging so the unit test never touches live PG /
// depends on the box's hive-pause state (the EI-275 lesson from deliver-and-wake).
vi.mock('../wake-mode', () => ({
  resolveWakeMode: vi.fn(async () => 'auto'),
}));
vi.mock('../pending-wakes', () => ({
  stagePendingWake: vi.fn(async () => ({ id: 1 })),
}));

import handoff from './handoff';
import { inboxWakeKey } from '../inbox-wake';

const ctx = { uiClientId: 'su-offerer', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = <T>(tool: { args: { parse: (x: unknown) => unknown } }, x: unknown): T =>
  tool.args.parse(x) as T;
const out = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

const openArgs = (over: Record<string, unknown> = {}) => ({
  to: ['su-bee-1'],
  plan_slug: 'plan-x',
  summary: 'pick up the registry work',
  ...over,
});

describe('coord:handoff — wake-on-open (P-003)', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    emitAwaitedEvent.mockClear();
    emitAwaitedEvent.mockResolvedValue({ ok: true, key: 'k', woken: 1, notified: [], msgId: null });
    listPresence.mockReset();
    listPresence.mockResolvedValue([{ ownerId: 'su-bee-1' }, { ownerId: 'su-bee-2' }]);
  });
  afterEach(() => resetCoordLog());

  it('records the handoff AND fires the recipient inbox-wake key(s) on open', async () => {
    const res = await handoff.handler(parse(handoff, openArgs({ to: ['su-bee-1', 'su-bee-2'] })), ctx);
    // the handoff is durably recorded
    const recs = await log.readEvents('handoffs');
    expect(recs.filter((r) => r.kind === 'handoff')).toHaveLength(1);
    // wake half: one emit per concrete recipient, each on that recipient's OWN key.
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1'), inboxWakeKey('su-bee-2')]);
    const body = out(res);
    expect(body.ok).toBe(true);
    expect(typeof body.msg_id).toBe('string');
    expect(body.wake).toMatchObject({ targets: ['su-bee-1', 'su-bee-2'], woken: 2 });
  });

  it('is FAIL-SOFT: a wake throw never fails the open (the handoff is still recorded)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitAwaitedEvent.mockReset();
    emitAwaitedEvent.mockRejectedValue(new Error('wake pump down'));
    const res = await handoff.handler(parse(handoff, openArgs()), ctx);
    const body = out(res);
    // open SUCCEEDS regardless — the handoff is the durable truth.
    expect(body.ok).toBe(true);
    expect(typeof body.msg_id).toBe('string');
    expect((await log.readEvents('handoffs')).filter((r) => r.kind === 'handoff')).toHaveLength(1);
    warn.mockRestore();
  });

  it('NEVER wakes a wildcard/human selector — only concrete addressees (no thunder-herd)', async () => {
    const res = await handoff.handler(
      parse(handoff, openArgs({ to: ['*', 'human', 'su-bee-2'] })),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-2')]); // '*'/'human' skipped
    expect(keys.some((k) => k.includes('*') || k.includes('human'))).toBe(false);
    expect(out(res).wake).toMatchObject({ targets: ['su-bee-2'] });
  });

  it('a handoff to ONLY "*" fires no wake at all (broadcast is never a wake target)', async () => {
    const res = await handoff.handler(parse(handoff, openArgs({ to: ['*'] })), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    const body = out(res);
    expect(body.ok).toBe(true);
    expect(body.wake).toMatchObject({ targets: [], woken: 0 });
    expect(body.wake.recipient_absent).toBeUndefined(); // a broadcast that wakes no one is by design
  });

  it('surfaces recipient_absent when a concrete addressee woke NOBODY (the loud miss)', async () => {
    emitAwaitedEvent.mockReset();
    emitAwaitedEvent.mockResolvedValue({ ok: true, key: inboxWakeKey('su-bee-1'), woken: 0, notified: [], msgId: null });
    const res = await handoff.handler(parse(handoff, openArgs()), ctx);
    const { wake } = out(res);
    expect(wake.targets).toEqual(['su-bee-1']);
    expect(wake.woken).toBe(0);
    expect(wake.recipient_absent).toBe(true);
    expect(typeof wake.note).toBe('string');
  });

  it('does NOT surface recipient_absent when the wake DID wake someone (woken>0 control)', async () => {
    const res = await handoff.handler(parse(handoff, openArgs()), ctx); // default emit → woken:1
    const { wake } = out(res);
    expect(wake.woken).toBe(1);
    expect(wake.recipient_absent).toBeUndefined();
  });

  it('FF#2: an opened handoff is PENDING, not done — accepted:false / pending_acceptance:true even when it woke someone', async () => {
    const body = out(await handoff.handler(parse(handoff, openArgs()), ctx)); // woken:1
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(false);
    expect(body.pending_acceptance).toBe(true);
  });

  it('the ACCEPT path still emits handoff:accepted:<id> and does not run wake-on-open', async () => {
    // First open a handoff so accept has a target.
    const opened = out(await handoff.handler(parse(handoff, openArgs()), ctx));
    emitAwaitedEvent.mockClear();
    const res = await handoff.handler(parse(handoff, { accept_msg_id: opened.msg_id }), ctx);
    const body = out(res);
    expect(body.ok).toBe(true);
    expect(body.accepted).toBeTruthy();
    // the accept path fires the offerer's accept-wake (async import) — give the
    // microtask a tick; either way it must NOT fire the open-path recipient keys.
    await new Promise((r) => setTimeout(r, 0));
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys.every((k) => !k.startsWith('coord:inbox-wake:'))).toBe(true);
  });
});

describe('coord:handoff — harness_slug federation (WI-1375)', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    listPresence.mockReset();
    listPresence.mockResolvedValue([{ ownerId: 'su-bee-1' }]);
    emitAwaitedEvent.mockClear();
    emitAwaitedEvent.mockResolvedValue({ ok: true, key: 'k', woken: 1, notified: [], msgId: null });
  });
  afterEach(() => resetCoordLog());

  // A ctx carrying an explicit harness scope — the write-path input that decides
  // whether the handoff record federates (openHandoff → coord_event_log.harness_slug).
  const harnessCtx = (harnessSlug: unknown) =>
    ({ uiClientId: 'su-offerer', isSuperuser: true, workspaceId: 'ws', harnessSlug }) as never;
  const openedHandoff = async () =>
    (await log.readEvents('handoffs')).find((r) => r.kind === 'handoff')!;

  it('a harness-scoped handoff stamps the record harness_slug → coord_event_log.harness_slug NOT NULL (capture enqueues)', async () => {
    await handoff.handler(parse(handoff, openArgs()), harnessCtx('shared-hive'));
    expect((await openedHandoff()).harness_slug).toBe('shared-hive');
  });

  it("does NOT stamp harness_slug for the '*' operator/SU wildcard (stays workspace-local)", async () => {
    await handoff.handler(parse(handoff, openArgs()), harnessCtx('*'));
    expect('harness_slug' in (await openedHandoff())).toBe(false);
  });

  it('does NOT stamp harness_slug when the session has no harness scope (operator)', async () => {
    await handoff.handler(parse(handoff, openArgs()), harnessCtx(undefined));
    expect('harness_slug' in (await openedHandoff())).toBe(false);
  });
});
