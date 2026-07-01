/**
 * send.test.ts — the coord:send HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins:
 *   • single { to, summary } → one result self-describing its `to` + msg_id;
 *   • items:[…] sends N DISTINCT messages (one sendMessage per item);
 *   • an unknown-recipient on ONE message fails only that item (its { ok:false,
 *     error:'unknown_recipient' }) — top-level ok stays true, the other lands.
 * `to` here is the multi-RECIPIENT list of ONE message; `items` is the
 * many-distinct-messages axis.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/send.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', workspaceId: 'ws1' })) }));
vi.mock('../messages', () => ({ sendMessage: vi.fn(), getMessageById: vi.fn(async () => null) }));
vi.mock('../recipient-liveness', () => ({ describeMissedRecipients: vi.fn(async () => []) }));
vi.mock('../inbox-wake', () => ({
  wakeRecipients: vi.fn(async () => ({ targets: [], woken: 0, staged: 0 })),
  reportIdleRecipients: vi.fn(async () => ({ idle: [] })),
}));
vi.mock('../recipient-resolve', () => ({
  isSelectorOrWildcard: vi.fn((id: string) => id === '*' || id === 'human'),
  resolveRecipients: vi.fn(),
  // P-007: remote session ids empty by default (single-box behavior unchanged)
  remoteSessionOwnerIds: vi.fn(async () => new Set<string>()),
}));
vi.mock('../../turn/interrupt', () => ({ forceEndTurn: vi.fn(async () => ({ ok: true })) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
// P-001 (cross-machine-coord-parity): the workspace shared-Hive scope resolver.
// Default 'none' = today's local-only behavior for un-scoped senders.
vi.mock('../federation-scope', () => ({
  resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
}));

import { sendMessage, getMessageById } from '../messages';
import { resolveRecipients, remoteSessionOwnerIds } from '../recipient-resolve';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { describeMissedRecipients } from '../recipient-liveness';
import { resolveWorkspaceHiveScope } from '../federation-scope';
import { getFlag } from '@papercusp/flags/server';
const sendM = vi.mocked(sendMessage);
const getByIdM = vi.mocked(getMessageById);
const resolveM = vi.mocked(resolveRecipients);
const remoteIdsM = vi.mocked(remoteSessionOwnerIds);
const wakeM = vi.mocked(wakeRecipients);
const idleM = vi.mocked(reportIdleRecipients);
const livenessM = vi.mocked(describeMissedRecipients);
const fedScopeM = vi.mocked(resolveWorkspaceHiveScope);
const flagM = vi.mocked(getFlag);
const tool = (await import('./send')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);
const bodyWithCtx = async (args: unknown, ctx: unknown) =>
  (((await tool.handler(args as never, ctx as never)) as Out).data);

let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  n = 0;
  // each send mints a fresh msg_id; echo the resolved `to` back on the envelope
  sendM.mockImplementation(async (_id, opts: { to: string[] }) => ({ to: opts.to, msg_id: `m${++n}`, ts: `t${n}` }) as never);
  // recipients resolve 1:1 by default (no unknowns)
  resolveM.mockImplementation(async (to: readonly string[]) => ({ resolved: to, unknown: [], ambiguous: [] }) as never);
  // wake-on-reply flag ON by default; no original message by default
  flagM.mockResolvedValue(true as never);
  getByIdM.mockResolvedValue(null as never);
  // P-001: no shared Hive in the workspace by default (un-scoped sends stay local)
  fedScopeM.mockResolvedValue({ kind: 'none' } as never);
  // P-007: no remote sessions by default
  remoteIdsM.mockResolvedValue(new Set<string>() as never);
});

describe('coord:send handler (bulk keyed-array)', () => {
  it('single { to, summary } → one result self-describing its `to` + msg_id', async () => {
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, to: ['bee-1'], msg_id: 'm1' });
    expect(sendM).toHaveBeenCalledTimes(1);
  });

  it('one message to MANY recipients stays the single form (to:[…])', async () => {
    const b = await body({ to: ['bee-1', 'bee-2'], summary: 'broadcast-ish' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(sendM).toHaveBeenCalledTimes(1); // ONE message, two addressees
    expect(b.results[0].to).toEqual(['bee-1', 'bee-2']);
  });

  it('items:[…] sends N DISTINCT messages — one sendMessage per item', async () => {
    const b = await body({
      items: [
        { to: ['bee-1'], summary: 'first' },
        { to: ['bee-2'], summary: 'second' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(sendM).toHaveBeenCalledTimes(2);
    expect(b.results.map((r: { to: string[] }) => r.to)).toEqual([['bee-1'], ['bee-2']]);
    expect(b.results.map((r: { msg_id: string }) => r.msg_id)).toEqual(['m1', 'm2']);
  });

  it('an unknown recipient on ONE message fails only that item; the rest land', async () => {
    resolveM.mockImplementation(async (to: readonly string[]) =>
      to.includes('ghost')
        ? ({ resolved: [], unknown: ['ghost'], ambiguous: [] } as never)
        : ({ resolved: to, unknown: [], ambiguous: [] } as never),
    );
    const b = await body({
      items: [
        { to: ['bee-1'], summary: 'ok' },
        { to: ['ghost'], summary: 'bad' },
      ],
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, to: ['bee-1'], msg_id: 'm1' });
    expect(b.results[1]).toMatchObject({ ok: false, to: ['ghost'], error: 'unknown_recipient', unknown_recipients: ['ghost'] });
    // the bad message was NOT sent (the good one was)
    expect(sendM).toHaveBeenCalledTimes(1);
  });

  it("wake:'required' miss on a DEAD recipient → recipient_dead + truthful black-hole note (WI-574)", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['dead-bee'], keys: [], woken: 0, staged: 0 } as never);
    idleM.mockResolvedValueOnce({ idle: ['dead-bee'] } as never);
    const b = await body({ to: ['dead-bee'], summary: 'pick this up', wake: 'required' });
    expect(b.results[0].wake).toMatchObject({ recipient_absent: true, recipient_dead: ['dead-bee'] });
    expect(b.results[0].wake.note).toMatch(/NOT be seen|black-hole|not running/i);
  });

  it("wake:'required' miss on a PAUSED-but-alive recipient → recipient_absent, NO recipient_dead (WI-574)", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['paused-bee'], keys: [], woken: 0, staged: 0 } as never);
    idleM.mockResolvedValueOnce({ idle: [] } as never);
    const b = await body({ to: ['paused-bee'], summary: 'hi', wake: 'required' });
    expect(b.results[0].wake.recipient_absent).toBe(true);
    expect(b.results[0].wake.recipient_dead).toBeUndefined();
    expect(b.results[0].wake.note).toMatch(/next turn|actually running/i);
  });

  it("FF#1: wake:'optimistic' miss with NO backstop → LOUD recipient_absent (same as required)", async () => {
    // The incident: an optimistic transfer to a now-dead agent woke nobody and was read
    // as "fine, the backstop will get it" — when there was no backstop. Now: no declared
    // backstop ⇒ the miss is as loud as a required miss.
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0 } as never);
    idleM.mockResolvedValueOnce({ idle: ['ghost-bee'] } as never);
    const b = await body({ to: ['ghost-bee'], summary: 'deploy this', wake: 'optimistic' });
    expect(b.results[0].wake).toMatchObject({
      mode: 'optimistic',
      woken: 0,
      recipient_absent: true,
      recipient_dead: ['ghost-bee'],
    });
    expect(b.results[0].wake.note).toMatch(/NO declared backstop|black-hole|NOT be seen/i);
  });

  it("FF#1: wake:'optimistic' miss WITH a declared backstop → soft note naming it, NO recipient_absent", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0 } as never);
    const b = await body({
      to: ['ghost-bee'],
      summary: 'survey will re-place',
      wake: 'optimistic',
      backstop: 'queen-survey re-dispatches',
    });
    expect(b.results[0].wake).toMatchObject({ mode: 'optimistic', woken: 0 });
    expect(b.results[0].wake.recipient_absent).toBeUndefined();
    expect(b.results[0].wake.note).toMatch(/declared backstop|queen-survey/i);
  });

  it('FF#3: a miss forces the missed addressee\'s FRESH sessionState into the result', async () => {
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0 } as never);
    livenessM.mockResolvedValueOnce([
      { ownerId: 'ghost-bee', sessionState: 'ended', wakeable: false },
    ] as never);
    const b = await body({ to: ['ghost-bee'], summary: 'x', wake: 'required' });
    expect(b.results[0].wake.recipient_liveness).toEqual([
      { ownerId: 'ghost-bee', sessionState: 'ended', wakeable: false },
    ]);
  });

  it("wake:'optimistic' that WOKE someone (woken:1) carries no miss note", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['live-bee'], keys: [], woken: 1, staged: 0 } as never);
    const b = await body({ to: ['live-bee'], summary: 'fyi', wake: 'optimistic' });
    expect(b.results[0].wake).toMatchObject({ mode: 'optimistic', woken: 1 });
    expect(b.results[0].wake.note).toBeUndefined();
  });
});

describe('coord:send wake-on-reply (coord-wake-on-reply)', () => {
  it('a DIRECTED send persists wakeOnReply:true in the envelope extra (default ON)', async () => {
    await body({ to: ['bee-1'], summary: 'hi' });
    expect(sendM).toHaveBeenCalledTimes(1);
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra).toMatchObject({ wakeOnReply: true });
  });

  it('a BROADCAST send (to:["*"]) does NOT default wakeOnReply on (no extra persisted)', async () => {
    await body({ to: ['*'], summary: 'all hands' });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.wakeOnReply).toBeUndefined();
  });

  it('wakeOnReply:false on a directed send opts out — no persist, and a reply does NOT wake', async () => {
    await body({ to: ['bee-1'], summary: 'hi', wakeOnReply: false });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.wakeOnReply).toBeUndefined();

    // a reply pointing at an original that DID NOT opt in must not wake
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'peer', to: ['me'] } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(wakeM).not.toHaveBeenCalled();
    expect(b.results[0].replyWake).toBeUndefined();
  });

  it('a reply to an opted-in directed message fires an optimistic wake to the ORIGINAL sender', async () => {
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'peer', to: ['me'], wakeOnReply: true } as never);
    wakeM.mockResolvedValueOnce({ targets: ['peer'], keys: [], woken: 1, staged: 0 } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(wakeM).toHaveBeenCalledTimes(1);
    expect(wakeM.mock.calls[0][0]).toEqual(['peer']);
    expect(b.results[0].replyWake).toMatchObject({ target: 'peer', woken: 1 });
  });

  it('a reply whose sender IS the original sender does NOT self-wake', async () => {
    // original was sent BY 'me' (the current identity) → never self-wake
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'me', to: ['peer'], wakeOnReply: true } as never);
    const b = await body({ to: ['peer'], summary: 'reply to my own', related_msg_id: 'orig' });
    expect(wakeM).not.toHaveBeenCalled();
    expect(b.results[0].replyWake).toBeUndefined();
  });

  it('flag OFF → no wakeOnReply persisted and no reply-wake (behaves as today)', async () => {
    flagM.mockResolvedValue(false as never);
    // directed send: no opt-in persisted
    await body({ to: ['bee-1'], summary: 'hi' });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.wakeOnReply).toBeUndefined();
    // reply to an opted-in original: still no wake while the flag is OFF
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'peer', to: ['me'], wakeOnReply: true } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(wakeM).not.toHaveBeenCalled();
    expect(b.results[0].replyWake).toBeUndefined();
  });
});

describe('coord:send federation scope (cross-machine-coord-parity P-001)', () => {
  it('un-scoped sender + exactly one shared Hive → auto-stamps the home slug; result federated:true', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBe('my-hive');
    expect(b.results[0]).toMatchObject({ ok: true, federated: true, federationScope: 'my-hive' });
  });

  it('un-scoped sender + no shared Hive → stays local; result federated:false (never mistaken for delivery)', async () => {
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBeUndefined();
    expect(b.results[0]).toMatchObject({ ok: true, federated: false });
    expect(b.results[0].federationScope).toBeUndefined();
  });

  it('harness-scoped sender (ctx.harnessSlug) stamps its own harness WITHOUT consulting the resolver', async () => {
    const b = await bodyWithCtx({ to: ['bee-1'], summary: 'hi' }, { harnessSlug: 'h1' });
    expect(fedScopeM).not.toHaveBeenCalled();
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBe('h1');
    expect(b.results[0]).toMatchObject({ federated: true, federationScope: 'h1' });
  });

  it("scope:'local' keeps even a harness-scoped sender machine-local", async () => {
    const b = await bodyWithCtx({ to: ['bee-1'], summary: 'hi', scope: 'local' }, { harnessSlug: 'h1' });
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBeUndefined();
    expect(b.results[0]).toMatchObject({ federated: false });
  });

  it("scope:'hive' with NO shared Hive → loud no_hive_scope, nothing sent", async () => {
    const b = await body({ to: ['bee-1'], summary: 'hi', scope: 'hive' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, to: ['bee-1'], error: 'no_hive_scope' });
    expect(sendM).not.toHaveBeenCalled();
  });

  it("scope:'hive' with SEVERAL shared Hives → loud ambiguous_hive_scope naming candidates, nothing sent", async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi', scope: 'hive' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'ambiguous_hive_scope',
      candidates: ['hive-a', 'hive-b'],
    });
    expect(sendM).not.toHaveBeenCalled();
  });

  it('auto mode with SEVERAL shared Hives → ambiguity is never guessed; stays local, federated:false', async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    expect(b.results[0]).toMatchObject({ ok: true, federated: false });
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBeUndefined();
  });

  it('per-item scope: one item local, one auto-federated, in a single items:[…] call', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    const b = await body({
      items: [
        { to: ['bee-1'], summary: 'federate me' },
        { to: ['bee-2'], summary: 'keep me local', scope: 'local' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results[0]).toMatchObject({ federated: true, federationScope: 'my-hive' });
    expect(b.results[1]).toMatchObject({ federated: false });
    const first = sendM.mock.calls[0][1] as { harnessSlug?: string };
    const second = sendM.mock.calls[1][1] as { harnessSlug?: string };
    expect(first.harnessSlug).toBe('my-hive');
    expect(second.harnessSlug).toBeUndefined();
  });
});

describe('coord:send delivery receipts (P-008)', () => {
  it('a FEDERATED directed required-wake send persists receipt:true and returns receiptEvent', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-r'], keys: [], woken: 0, staged: 0 } as never);
    const b = await body({ to: ['su-r'], summary: 'do it now', wake: 'required' });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.receipt).toBe(true);
    expect(b.results[0].receiptEvent).toBe('coord:receipt:m1');
  });

  it('no receipt on: local-only send, broadcast, or inject-only', async () => {
    // local-only (no hive scope): required wake but federated:false
    wakeM.mockResolvedValueOnce({ targets: ['su-r'], keys: [], woken: 1, staged: 0 } as never);
    let b = await body({ to: ['su-r'], summary: 'x', wake: 'required' });
    expect((sendM.mock.calls[0][1] as { extra?: Record<string, unknown> }).extra?.receipt).toBeUndefined();
    expect(b.results[0].receiptEvent).toBeUndefined();
    // federated broadcast: no receipt (receipt is directed-only — a broadcast
    // receipt storm would be its own amplification bomb)
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    b = await body({ to: ['*'], summary: 'x', wake: true });
    expect((sendM.mock.calls[1][1] as { extra?: Record<string, unknown> }).extra?.receipt).toBeUndefined();
    // federated directed INJECT (no wake): no receipt
    b = await body({ to: ['su-r'], summary: 'x' });
    expect((sendM.mock.calls[2][1] as { extra?: Record<string, unknown> }).extra?.receipt).toBeUndefined();
  });
});

describe('coord:send remote-homed wake misses (P-007)', () => {
  it('a required-wake miss on a REMOTE-homed recipient reports recipient_remote (not dead) with the federation note', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    remoteIdsM.mockResolvedValue(new Set(['su-remote-1']) as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-remote-1'], keys: [], woken: 0, staged: 0 } as never);
    idleM.mockResolvedValueOnce({ idle: ['su-remote-1'] } as never); // no local watcher — but it is REMOTE
    const b = await body({ to: ['su-remote-1'], summary: 'cross-machine ping', wake: 'required' });
    expect(b.results[0].wake.recipient_remote).toEqual(['su-remote-1']);
    expect(b.results[0].wake.recipient_dead).toBeUndefined();
    expect(b.results[0].wake.note).toMatch(/REMOTE machine|federates|EI-279/i);
    expect(b.results[0].federated).toBe(true);
  });

  it('a remote-homed recipient on a NON-federated send gets the loud scope hint (it will never arrive)', async () => {
    // no shared hive → the send stays local, but the recipient is remote-only
    remoteIdsM.mockResolvedValue(new Set(['su-remote-1']) as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-remote-1'], keys: [], woken: 0, staged: 0 } as never);
    idleM.mockResolvedValueOnce({ idle: ['su-remote-1'] } as never);
    const b = await body({ to: ['su-remote-1'], summary: 'ping', wake: 'required' });
    expect(b.results[0].federated).toBe(false);
    expect(b.results[0].wake.note).toMatch(/did NOT federate|scope:'hive'/i);
  });
});
