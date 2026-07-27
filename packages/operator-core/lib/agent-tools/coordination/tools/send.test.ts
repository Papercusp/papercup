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
  wakeRecipients: vi.fn(async () => ({ targets: [], woken: 0, staged: 0, stagedTargets: [] })),
  reportIdleRecipients: vi.fn(async () => ({ idle: [] })),
}));
vi.mock('../recipient-resolve', () => ({
  // Match production: '*'/'human'/''/@-prefixed all bypass concrete-recipient
  // resolution (EI-6874 — audience selectors like @fleet:/@topic: must NOT be
  // treated as concrete ids to resolve against the roster).
  isSelectorOrWildcard: vi.fn(
    (id: string) => id === '*' || id === 'human' || id === '' || id.startsWith('@'),
  ),
  resolveRecipients: vi.fn(),
  // P-007: remote session ids empty by default (single-box behavior unchanged)
  remoteSessionOwnerIds: vi.fn(async () => new Set<string>()),
  remoteSessionsByOwnerId: vi.fn(async () => new Map<string, number>()),
}));
vi.mock('../../turn/interrupt', () => ({ forceEndTurn: vi.fn(async () => ({ ok: true })) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
// P-006: keep ref-hydrate-resolve's IO graph (work-items + announced-gates
// store → coord log → flags listener) OUT of this unit graph — this file mocks
// flags/server partially, so loading the real chain explodes at import. Gate
// stamping semantics are covered by ref-hydrate.test.ts; here every key just
// stamps as undeclared.
vi.mock('../ref-hydrate-resolve', () => ({
  resolveGateRefStamps: vi.fn(async (keys: string[]) =>
    keys.map((k) => ({ key: k, status: 'undeclared' })),
  ),
}));
// P-001 (cross-machine-coord-parity): the workspace shared-Hive scope resolver.
// Default 'none' = today's local-only behavior for un-scoped senders.
vi.mock('../federation-scope', async (importOriginal) => {
  // WI-5445: resolveSharedHiveDisambiguation is PURE (no I/O) — keep the real
  // implementation so scope:'hive' + explicit `hive` tests exercise the actual
  // disambiguation logic instead of a second hand-rolled fake of it.
  const actual = await importOriginal<typeof import('../federation-scope')>();
  return {
    ...actual,
    resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
  };
});
// fleet-scoped-broadcast-default: sender's fleet lookup. getPresence is now used
// only by the cue-authority resolver (P-003); the fleet SLUG for the '*' down-scope
// comes from fetchPresenceFleet (P-004 — fleetSlug is NOT on PresenceRecord).
vi.mock('../presence', () => ({ getPresence: vi.fn(async () => null) }));
// P-004: the sender's fleet membership lives on the fleet-membership JOIN
// (fetchPresenceFleet), NOT on PresenceRecord — send.ts reads it HERE to down-scope
// a fleeted sender's ['*'] to @fleet:<slug>. Default empty map = non-fleeted, so
// every existing '*' test keeps its literal broadcast. (The old tests mocked
// getPresence().fleetSlug — a field production never returns — which is exactly
// what hid the no-op bug this item fixes.)
vi.mock('../presence-fleet', () => ({ fetchPresenceFleet: vi.fn(async () => new Map()) }));

import { sendMessage, getMessageById } from '../messages';
import { resolveRecipients, remoteSessionOwnerIds, remoteSessionsByOwnerId } from '../recipient-resolve';
import { wakeRecipients, reportIdleRecipients } from '../inbox-wake';
import { describeMissedRecipients } from '../recipient-liveness';
import { resolveWorkspaceHiveScope } from '../federation-scope';
import { getPresence } from '../presence';
import { fetchPresenceFleet } from '../presence-fleet';
import { getFlag } from '@papercusp/flags/server';
const sendM = vi.mocked(sendMessage);
const getByIdM = vi.mocked(getMessageById);
const resolveM = vi.mocked(resolveRecipients);
const remoteIdsM = vi.mocked(remoteSessionOwnerIds);
const remoteMapM = vi.mocked(remoteSessionsByOwnerId);
const wakeM = vi.mocked(wakeRecipients);
const idleM = vi.mocked(reportIdleRecipients);
const livenessM = vi.mocked(describeMissedRecipients);
const fedScopeM = vi.mocked(resolveWorkspaceHiveScope);
const getPresenceM = vi.mocked(getPresence);
const fetchPresenceFleetM = vi.mocked(fetchPresenceFleet);
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
  remoteMapM.mockResolvedValue(new Map<string, number>() as never);
  // P-004: non-fleeted by default → a bare '*' stays a literal hive broadcast.
  fetchPresenceFleetM.mockResolvedValue(new Map() as never);
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
    wakeM.mockResolvedValueOnce({ targets: ['dead-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({ idle: ['dead-bee'] } as never);
    const b = await body({ to: ['dead-bee'], summary: 'pick this up', wake: 'required' });
    expect(b.results[0].wake).toMatchObject({ recipient_absent: true, recipient_dead: ['dead-bee'] });
    expect(b.results[0].wake.note).toMatch(/NOT be seen|black-hole|not running/i);
  });

  it("wake:'required' miss on a PAUSED-but-alive recipient → recipient_absent, NO recipient_dead (WI-574)", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['paused-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({ idle: [] } as never);
    const b = await body({ to: ['paused-bee'], summary: 'hi', wake: 'required' });
    expect(b.results[0].wake.recipient_absent).toBe(true);
    expect(b.results[0].wake.recipient_dead).toBeUndefined();
    expect(b.results[0].wake.note).toMatch(/next turn|actually running/i);
  });

  it("WI-5994: wake:'required' miss on a DORMANT-SCHEDULED recipient (armed loop, future fire) → NO recipient_dead, deferred-delivery note", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['loopy-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({
      idle: [],
      dormantScheduled: [{ ownerId: 'loopy-bee', parked: false, nextFireAt: '2026-07-26T06:33:29.794Z' }],
    } as never);
    const b = await body({ to: ['loopy-bee'], summary: 'pick this up', wake: 'required' });
    expect(b.results[0].wake.recipient_dead).toBeUndefined();
    expect(b.results[0].wake.recipient_dormant_scheduled).toEqual([
      { ownerId: 'loopy-bee', parked: false, nextFireAt: '2026-07-26T06:33:29.794Z' },
    ]);
    expect(b.results[0].wake.note).toMatch(/DORMANT BETWEEN LOOP FIRES/i);
    expect(b.results[0].wake.note).not.toMatch(/not running|re-spawned/i);
  });

  it("WI-5994: a MIXED miss (one dead, one dormant-scheduled) reports both truthfully, never conflated", async () => {
    wakeM.mockResolvedValueOnce({
      targets: ['dead-bee', 'loopy-bee'],
      keys: [],
      woken: 0,
      staged: 0,
      stagedTargets: [],
    } as never);
    idleM.mockResolvedValueOnce({
      idle: ['dead-bee'],
      dormantScheduled: [{ ownerId: 'loopy-bee', parked: true, nextFireAt: null }],
    } as never);
    const b = await body({ to: ['dead-bee', 'loopy-bee'], summary: 'pick this up', wake: 'required' });
    expect(b.results[0].wake.recipient_dead).toEqual(['dead-bee']);
    expect(b.results[0].wake.recipient_dormant_scheduled).toEqual([
      { ownerId: 'loopy-bee', parked: true, nextFireAt: null },
    ]);
    expect(b.results[0].wake.note).toMatch(/dead-bee/);
    expect(b.results[0].wake.note).toMatch(/loopy-bee \(mid-turn right now\)/);
  });

  it("FF#1: wake:'optimistic' miss with NO backstop → LOUD recipient_absent (same as required)", async () => {
    // The incident: an optimistic transfer to a now-dead agent woke nobody and was read
    // as "fine, the backstop will get it" — when there was no backstop. Now: no declared
    // backstop ⇒ the miss is as loud as a required miss.
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
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
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
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
    wakeM.mockResolvedValueOnce({ targets: ['ghost-bee'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    livenessM.mockResolvedValueOnce([
      { ownerId: 'ghost-bee', sessionState: 'ended', wakeable: false },
    ] as never);
    const b = await body({ to: ['ghost-bee'], summary: 'x', wake: 'required' });
    expect(b.results[0].wake.recipient_liveness).toEqual([
      { ownerId: 'ghost-bee', sessionState: 'ended', wakeable: false },
    ]);
  });

  it("wake:'optimistic' that WOKE someone (woken:1) carries no miss note", async () => {
    wakeM.mockResolvedValueOnce({ targets: ['live-bee'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['live-bee'], summary: 'fyi', wake: 'optimistic' });
    expect(b.results[0].wake).toMatchObject({ mode: 'optimistic', woken: 1 });
    expect(b.results[0].wake.note).toBeUndefined();
  });
});

describe('coord:send wake-on-reply (coord-wake-on-reply)', () => {
  // D-048: `expectsReply` is DERIVED from the required `expects` — the caller no longer
  // passes it, and nothing infers it. These three replace the pre-D-048 trio (which
  // asserted the old opt-in boolean and the wake+deadline derivation).
  it('derives expectsReply from `expects` — persisted for ack/answer/action, absent for none', async () => {
    for (const expects of ['ack', 'answer', 'action'] as const) {
      sendM.mockClear();
      await body({ to: ['bee-1'], summary: 'question', expects });
      const opts = sendM.mock.calls[0][1] as { expectsReply?: boolean };
      expect(opts.expectsReply, `expects:'${expects}' must set expectsReply`).toBe(true);
    }

    sendM.mockClear();
    await body({ to: ['bee-1'], summary: 'FYI', expects: 'none' });
    const fyi = sendM.mock.calls[0][1] as { expectsReply?: boolean };
    expect(fyi.expectsReply).toBeUndefined();
  });

  it('stamps the 4-valued `expects` itself on the envelope extra (the richer signal consumers graduate to)', async () => {
    await body({ to: ['bee-1'], summary: 'please confirm', expects: 'ack' });
    const opts = sendM.mock.calls[0][1] as { extra?: { expects?: string } };
    expect(opts.extra?.expects).toBe('ack');
  });

  // The property the deleted 'derives from wake+replyDeadlineSec' test asserted is now
  // INVERTED: that derivation was D-016's "a default is how a field dies" in live code,
  // so wake/replyDeadlineSec/wakeOnReply must NOT move expectsReply at all.
  it('D-048: nothing infers expectsReply — wake:"required" + replyDeadlineSec on an `expects:none` send stays false', async () => {
    await body({
      to: ['bee-1'],
      summary: 'status, no reply wanted',
      expects: 'none',
      wake: 'required',
      replyDeadlineSec: 60,
      wakeOnReply: true,
    });
    const opts = sendM.mock.calls[0][1] as { expectsReply?: boolean };
    expect(opts.expectsReply).toBeUndefined();
  });

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
    wakeM.mockResolvedValueOnce({ targets: ['peer'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
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

  it('EI-14760: a wake:true reply whose recipient IS the original sender does NOT double-wake — reply-wake folds into the directed wake', async () => {
    // The A→B, then B replies-to-A-with-wake back-and-forth: `to:[peer]` (the directed
    // wake target) is ALSO the original sender of the message being replied to (the
    // wake-on-reply target). BOTH fans used to fire peer's inbox-wake key → two wake
    // deliveries → two wasted wake-pump turns for ONE message (EI-14760: deliveries
    // #22831/#22832 on the same await, ~31ms apart, for one send). Now the redundant
    // reply-wake folds into the authoritative deliver-and-wake fan (env.to).
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'peer', to: ['me'], wakeOnReply: true } as never);
    wakeM.mockResolvedValue({ targets: ['peer'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig', wake: 'required' });
    // Exactly ONE inbox-wake fan — the deliver-and-wake fan for env.to. The reply-wake
    // did NOT fire a second emit for the same recipient.
    expect(wakeM).toHaveBeenCalledTimes(1);
    expect(wakeM.mock.calls[0][0]).toEqual(['peer']);
    // Reported as folded (observable dedup), not fired.
    expect(b.results[0].replyWake).toMatchObject({ target: 'peer', woken: 0, foldedIntoDirectedWake: true });
    expect(b.results[0].wake).toMatchObject({ woken: 1 });
  });

  it('EI-14760: a wake:true reply whose original sender is a THIRD party still fires the reply-wake (two distinct fans)', async () => {
    // reply directed to `peer`, but the ORIGINAL message came from a third party `asker`
    // who is NOT in `to` — the reply-wake to `asker` is genuinely needed and must still
    // fire alongside the directed wake to `peer` (the fold must not over-apply).
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'asker', to: ['me'], wakeOnReply: true } as never);
    wakeM.mockResolvedValue({ targets: ['x'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig', wake: 'required' });
    expect(wakeM).toHaveBeenCalledTimes(2);
    const fannedSets = wakeM.mock.calls.map((c) => c[0]);
    expect(fannedSets).toContainEqual(['asker']); // reply-wake
    expect(fannedSets).toContainEqual(['peer']); // directed deliver-and-wake
    expect(b.results[0].replyWake).toMatchObject({ target: 'asker' });
    expect(b.results[0].replyWake?.foldedIntoDirectedWake).toBeUndefined();
  });

  it('EI-18663224517726594: a directed wake:true send carries the new message\'s OWN msg_id in the wake payload — a woken recipient can thread its reply without a separate coord:inbox round-trip', async () => {
    wakeM.mockResolvedValueOnce({ targets: ['bee-1'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['bee-1'], summary: 'please review X', wake: 'required' });
    expect(wakeM).toHaveBeenCalledTimes(1);
    const opts = wakeM.mock.calls[0][1] as { payload?: unknown };
    expect(opts.payload).toEqual({ msg_id: b.results[0].msg_id });
  });

  it('EI-18663224517726594: the reply-wake fan (waking the ORIGINAL sender when a third party replies) also carries the reply\'s own msg_id', async () => {
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'asker', to: ['me'], wakeOnReply: true } as never);
    wakeM.mockResolvedValueOnce({ targets: ['asker'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(wakeM).toHaveBeenCalledTimes(1);
    const opts = wakeM.mock.calls[0][1] as { payload?: unknown };
    expect(opts.payload).toEqual({ msg_id: b.results[0].msg_id });
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

  // WI-5072: reply-threading honesty — a dangling related_msg_id used to be
  // silently swallowed (the reply sent ok, the asker's wake-on-reply never
  // fired, and NEITHER side learned; live incident 2026-07-16 threaded a reply
  // to the literal id 'mrnyt8k4-0000-placeholder'). Now it mirrors relayOf:
  // clean miss = loud per-message refusal; infra error = fail-soft delivery.
  it('WI-5072: a DANGLING related_msg_id refuses the send loudly (related_msg_not_found, nothing persisted)', async () => {
    // default getMessageById mock resolves null = a clean lookup miss
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'mrn-0000-placeholder' });
    expect(b.results[0].ok).toBe(false);
    expect((b.results[0] as { error?: string }).error).toBe('related_msg_not_found');
    expect(sendM).not.toHaveBeenCalled(); // nothing was persisted
    expect(wakeM).not.toHaveBeenCalled();
  });

  it('WI-5072: a getMessageById INFRA error stays fail-soft — the reply still sends (never refuse on a read hiccup)', async () => {
    getByIdM.mockRejectedValueOnce(new Error('pg blip')); // validation lookup errors
    getByIdM.mockRejectedValueOnce(new Error('pg blip')); // reply-wake re-fetch errors too
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(b.results[0].ok).toBe(true);
    expect(sendM).toHaveBeenCalledTimes(1); // delivered despite the hiccup
    expect(b.results[0].replyWake).toBeUndefined(); // wake fail-softed, as before
  });

  it('WI-5072: a RESOLVED related_msg_id is fetched ONCE — validation result is reused by the reply-wake', async () => {
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'peer', to: ['me'], wakeOnReply: true } as never);
    wakeM.mockResolvedValueOnce({ targets: ['peer'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['peer'], summary: 'my reply', related_msg_id: 'orig' });
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].replyWake).toMatchObject({ target: 'peer', woken: 1 });
    expect(getByIdM).toHaveBeenCalledTimes(1); // one lookup, not two
  });

  // EI-18145123522199011: a reply CLOSING A LOOP with the original sender of
  // `related_msg_id` must not hard-refuse just because that sender's session has
  // since ended (reaped from the roster) — the unanswered-directed / delivery-
  // ladder alarm is satisfied by RECORDING the reply, not by live-delivering it,
  // and before this fix there was structurally no way to ever satisfy it once the
  // original sender was gone (coord:send always refused with unknown_recipient).
  it('EI-18145: replying to the original sender of related_msg_id who is now GONE from the roster still sends (closes the loop)', async () => {
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'ghost-sender', to: ['me'] } as never);
    resolveM.mockResolvedValueOnce({ resolved: [], unknown: ['ghost-sender'], ambiguous: [] } as never);
    const b = await body({ to: ['ghost-sender'], summary: 'closing this out', related_msg_id: 'orig' });
    expect(b.results[0]).toMatchObject({ ok: true, recipients_gone: ['ghost-sender'] });
    expect(b.results[0].error).toBeUndefined();
    expect(sendM).toHaveBeenCalledTimes(1); // the reply WAS recorded
    const opts = sendM.mock.calls[0][1] as { to: string[]; related_msg_id?: string };
    expect(opts.to).toEqual(['ghost-sender']);
    expect(opts.related_msg_id).toBe('orig');
  });

  it('EI-18145: an unknown recipient UNRELATED to related_msg_id.from still hard-refuses (the exemption is scoped, not blanket)', async () => {
    getByIdM.mockResolvedValueOnce({ msg_id: 'orig', from: 'ghost-sender', to: ['me'] } as never);
    resolveM.mockResolvedValueOnce({ resolved: [], unknown: ['some-other-ghost'], ambiguous: [] } as never);
    const b = await body({ to: ['some-other-ghost'], summary: 'hi', related_msg_id: 'orig' });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'unknown_recipient', unknown_recipients: ['some-other-ghost'] });
    expect(sendM).not.toHaveBeenCalled();
  });

  it('EI-18145: a genuinely unknown recipient with NO related_msg_id still hard-refuses (unchanged baseline)', async () => {
    resolveM.mockResolvedValueOnce({ resolved: [], unknown: ['ghost'], ambiguous: [] } as never);
    const b = await body({ to: ['ghost'], summary: 'hi' });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'unknown_recipient', unknown_recipients: ['ghost'] });
    expect(sendM).not.toHaveBeenCalled();
  });
});

describe('coord:send body auto-refs opt-out (coord-authority-hardening P-008)', () => {
  it('noBodyRefs:true stamps bodyRefsOptOut on the envelope extra (single form)', async () => {
    await body({ to: ['bee-1'], summary: 'historical: WI-1 was the old approach', noBodyRefs: true });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra).toMatchObject({ bodyRefsOptOut: true });
  });

  it('noBodyRefs rides per-item in the items form; default (omitted) stamps nothing', async () => {
    await body({
      items: [
        { to: ['bee-1'], summary: 'live: see WI-2' },
        { to: ['bee-2'], summary: 'stale quote of WI-3', noBodyRefs: true },
      ],
    });
    expect(sendM).toHaveBeenCalledTimes(2);
    const first = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    const second = sendM.mock.calls[1][1] as { extra?: Record<string, unknown> };
    expect(first.extra?.bodyRefsOptOut).toBeUndefined();
    expect(second.extra).toMatchObject({ bodyRefsOptOut: true });
  });
});

describe('coord:send zero-recipient audience (EI-6874)', () => {
  it("an EXPLICIT @fleet: selector resolving to ZERO live members → ok:false zero_recipients, NOT a silent ok:true", async () => {
    // The incident: a leader's drain order to @fleet:p2p-dist resolved to 0 members
    // (all launched with fleetSlug:null) and returned a silent ok:true, so the leader
    // sat ~3h awaiting acks nobody could send. sendMessage expands the selector to the
    // empty set → env.to === [].
    sendM.mockImplementationOnce(async () => ({ to: [], msg_id: 'm1', ts: 't1' }) as never);
    const b = await body({ to: ['@fleet:p2p-dist'], summary: 'DRAIN: wind down + ack' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'zero_recipients',
      recipients_resolved: 0,
      msg_id: 'm1', // the row still persisted (audience history / coord:catch-up)
    });
    expect(b.results[0].zero_recipients.selectors).toEqual(['@fleet:p2p-dist']);
    expect(b.results[0].message).toMatch(/ZERO live recipients|fleetSlug|reached NOBODY/i);
  });

  it('a @fleet: selector that DOES resolve to members → ok:true + recipients_resolved count', async () => {
    sendM.mockImplementationOnce(async () => ({ to: ['su-a', 'su-b'], msg_id: 'm1', ts: 't1' }) as never);
    const b = await body({ to: ['@fleet:p2p-dist'], summary: 'status' });
    expect(b.results[0]).toMatchObject({ ok: true, recipients_resolved: 2 });
    expect(b.results[0].zero_recipients).toBeUndefined();
  });

  it('a @topic: selector resolving to zero → ok:false zero_recipients with a catch-up hint (non-fleet)', async () => {
    sendM.mockImplementationOnce(async () => ({ to: [], msg_id: 'm1', ts: 't1' }) as never);
    const b = await body({ to: ['@topic:federation'], summary: 'anyone on this?' });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'zero_recipients', recipients_resolved: 0 });
    expect(b.results[0].message).toMatch(/catch up|coord:catch-up/i);
  });

  it("an AUTO-scoped '*'→@fleet broadcast to an empty/solo fleet → soft warning, keeps ok:true", async () => {
    // A fleeted sender's bare '*' is down-scoped to @fleet:<slug>. If that fleet has no
    // other live members the broadcast reaches nobody — but a broadcast intent is not a
    // failed directive, so it stays ok:true with a loud zero_recipients warning.
    fetchPresenceFleetM.mockResolvedValue(new Map([['me', { fleetSlug: 'solo' }]]) as never);
    sendM.mockImplementationOnce(async () => ({ to: [], msg_id: 'm1', ts: 't1' }) as never);
    const b = await body({ to: ['*'], summary: 'per-wake status' });
    expect(b.results[0]).toMatchObject({ ok: true, recipients_resolved: 0 });
    expect(b.results[0].zero_recipients.selectors).toEqual(['@fleet:solo']);
    expect(b.results[0].scopedBroadcast).toMatchObject({ from: '*', to: '@fleet:solo' });
  });

  it('a SLOT selector (@role:) that parks for a future agent is NOT flagged zero_recipients', async () => {
    // Slot selectors legitimately resolve to nobody now (they park) → env.to === [] is
    // expected, not a miss.
    sendM.mockImplementationOnce(async () => ({ to: [], msg_id: 'm1', ts: 't1' }) as never);
    const b = await body({ to: ['@role:worker'], summary: 'the next worker picks this up' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].zero_recipients).toBeUndefined();
    expect(b.results[0].recipients_resolved).toBeUndefined();
  });

  it('a concrete-recipient send is unaffected — no recipients_resolved / zero_recipients', async () => {
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    expect(b.results[0]).toMatchObject({ ok: true, to: ['bee-1'] });
    expect(b.results[0].recipients_resolved).toBeUndefined();
    expect(b.results[0].zero_recipients).toBeUndefined();
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
    // WI-3653: a resolved "stay local" decision passes null THROUGH (not undefined) —
    // undefined would re-trigger sendMessage's own AUTO-stamp default and defeat scope:'local'.
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string | null };
    expect(opts.harnessSlug).toBeNull();
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
    // WI-3653: explicit local scope passes null THROUGH, not undefined (see above).
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string | null };
    expect(opts.harnessSlug).toBeNull();
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

  it("WI-5445: scope:'hive' + explicit `hive` on SEVERAL shared Hives picks that one — closes the ambiguous_hive_scope dead end", async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi', scope: 'hive', hive: 'hive-b' });
    expect(b.results[0]).toMatchObject({ ok: true, federated: true, federationScope: 'hive-b' });
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string };
    expect(opts.harnessSlug).toBe('hive-b');
  });

  it("WI-5445: scope:'hive' + `hive` naming a hive NOT in the shared set → loud unknown_hive, nothing sent", async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi', scope: 'hive', hive: 'not-a-hive' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'unknown_hive',
      candidates: ['hive-a', 'hive-b'],
    });
    expect(sendM).not.toHaveBeenCalled();
  });

  it("WI-5445: `hive` with NO scope:'hive' has no effect (auto never guesses) — stays local", async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi', hive: 'hive-b' });
    expect(b.results[0]).toMatchObject({ ok: true, federated: false });
  });

  it("WI-5445: scope:'hive' + `hive` naming the ONLY shared Hive still resolves (redundant but harmless)", async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'solo-hive' } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi', scope: 'hive', hive: 'solo-hive' });
    expect(b.results[0]).toMatchObject({ ok: true, federated: true, federationScope: 'solo-hive' });
  });

  it('auto mode with SEVERAL shared Hives → ambiguity is never guessed; stays local, federated:false', async () => {
    fedScopeM.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] } as never);
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    expect(b.results[0]).toMatchObject({ ok: true, federated: false });
    // WI-3653: an ambiguous auto-resolve also resolves to explicit-local null (see above).
    const opts = sendM.mock.calls[0][1] as { harnessSlug?: string | null };
    expect(opts.harnessSlug).toBeNull();
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
    const first = sendM.mock.calls[0][1] as { harnessSlug?: string | null };
    const second = sendM.mock.calls[1][1] as { harnessSlug?: string | null };
    expect(first.harnessSlug).toBe('my-hive');
    // WI-3653: the local item resolves to explicit null, not undefined (see above).
    expect(second.harnessSlug).toBeNull();
  });
});

describe('coord:send delivery receipts (P-008)', () => {
  it('a FEDERATED directed required-wake send persists receipt:true and returns receiptEvent', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-r'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    const b = await body({ to: ['su-r'], summary: 'do it now', wake: 'required' });
    const opts = sendM.mock.calls[0][1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.receipt).toBe(true);
    expect(b.results[0].receiptEvent).toBe('coord:receipt:m1');
  });

  it('no receipt on: local-only send, broadcast, or inject-only', async () => {
    // local-only (no hive scope): required wake but federated:false
    wakeM.mockResolvedValueOnce({ targets: ['su-r'], keys: [], woken: 1, staged: 0, stagedTargets: [] } as never);
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
    remoteMapM.mockResolvedValue(new Map([['su-remote-1', Date.now()]]) as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-remote-1'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({ idle: ['su-remote-1'] } as never); // no local watcher — but it is REMOTE
    const b = await body({ to: ['su-remote-1'], summary: 'cross-machine ping', wake: 'required' });
    expect(b.results[0].wake.recipient_remote).toEqual(['su-remote-1']);
    expect(b.results[0].wake.recipient_dead).toBeUndefined();
    expect(b.results[0].wake.note).toMatch(/REMOTE machine|FEDERATES|receiptEvent|coord:receipt/i);
    expect(b.results[0].federated).toBe(true);
  });

  it('a remote-homed recipient on a NON-federated send gets the loud scope hint (it will never arrive)', async () => {
    // no shared hive → the send stays local, but the recipient is remote-only
    remoteMapM.mockResolvedValue(new Map([['su-remote-1', Date.now()]]) as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-remote-1'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({ idle: ['su-remote-1'] } as never);
    const b = await body({ to: ['su-remote-1'], summary: 'ping', wake: 'required' });
    expect(b.results[0].federated).toBe(false);
    expect(b.results[0].wake.note).toMatch(/did NOT federate|scope:'hive'/i);
  });

  it('a STALE remote beat is reported as probably-gone (P-010) — treat like dead unless the receipt arrives', async () => {
    fedScopeM.mockResolvedValue({ kind: 'one', homeSlug: 'my-hive' } as never);
    remoteMapM.mockResolvedValue(new Map([['su-remote-1', Date.now() - 30 * 60 * 1000]]) as never);
    wakeM.mockResolvedValueOnce({ targets: ['su-remote-1'], keys: [], woken: 0, staged: 0, stagedTargets: [] } as never);
    idleM.mockResolvedValueOnce({ idle: ['su-remote-1'] } as never);
    const b = await body({ to: ['su-remote-1'], summary: 'ping', wake: 'required' });
    expect(b.results[0].wake.recipient_remote_stale).toEqual(['su-remote-1']);
    expect(b.results[0].wake.note).toMatch(/STALE|probably gone|re-dispatch/i);
  });
});

describe('coord:send — fleet-scoped broadcast default (queen-fleet-authority-boundary P-004)', () => {
  // A leader IS a fleeted sender (fleetRole:'leader'); its bare '*' must down-scope
  // to its own fleet so it can NEVER reach a peer leader outside that fleet. The
  // fleet SLUG is resolved from fetchPresenceFleet (the JOIN), the source the old
  // getPresence().fleetSlug read failed to hit — making this a prod no-op until now.
  const fleetOf = (slug: string, role = 'leader') =>
    new Map([['me', { fleetSlug: slug, fleetRole: role }]]);

  it("auto-scopes a fleet leader's bare ['*'] to @fleet:<slug> — cannot reach a peer leader outside its fleet", async () => {
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops') as never);
    const b = await body({ to: ['*'], summary: 'closed WI-123' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    // the '*' was rewritten before send → the message went to the fleet audience ONLY
    expect(b.results[0].to).toEqual(['@fleet:ops']);
    expect(sendM.mock.calls[0][1].to).toEqual(['@fleet:ops']);
    expect(sendM.mock.calls[0][1].to).not.toContain('*'); // never a hive-wide blast
    // the rewrite is surfaced (transparent, teaches the override)
    expect(b.results[0].scopedBroadcast).toMatchObject({ from: '*', to: '@fleet:ops' });
    expect(b.results[0].scopedBroadcast.reason).toContain('allHive:true');
    expect(b.results[0].allHiveBroadcast).toBeUndefined();
  });

  it("honors ['*'] verbatim when a NON-leader fleeted sender (an ordinary member) passes allHive:true", async () => {
    // A plain member carries no cueAuthority stamp (resolveCueAuthority only
    // stamps fleetRole:'leader'), so the fleet_scoped_cue_allhive_contradiction
    // guard (EI-9501) never fires for it — allHive stays a real conscious override.
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops', 'member') as never);
    const b = await body({ to: ['*'], summary: 'HIVE-WIDE: PG lock stampede', allHive: true });
    expect(b.results[0].to).toEqual(['*']);
    expect(sendM.mock.calls[0][1].to).toEqual(['*']);
    expect(b.results[0].allHiveBroadcast).toBe(true);
    expect(b.results[0].scopedBroadcast).toBeUndefined();
    // P-010 (H5b): the conscious claim is PERSISTED on the envelope — the
    // durable trace the allhive-broadcast-sweep detector keys on.
    expect(sendM.mock.calls[0][1].extra?.allHiveBroadcast).toBe(true);
  });

  it("does NOT stamp allHiveBroadcast on a non-fleeted sender's routine bare ['*'] (P-010 detector scope)", async () => {
    // Routine solo-agent traffic (live data: hundreds/day) must never trip the
    // H5b detector — only the explicit allHive:true override is stamped.
    const b = await body({ to: ['*'], summary: 'closed WI-777' });
    expect(b.results[0].to).toEqual(['*']);
    expect(sendM.mock.calls[0][1].extra?.allHiveBroadcast).toBeUndefined();
  });

  it('honors [\'*\'] verbatim for a hive-queen sender (mug/kettle) with allHive:true — its authority IS hive-wide', async () => {
    // A mug/kettle's cueAuthority stamp is scope:'hive-wide' (resolveCueAuthority),
    // never 'fleet-members' — the EI-9501 guard only fires on a fleet-scoped stamp,
    // so a genuine hive-queen broadcast is unaffected.
    getPresenceM.mockResolvedValueOnce({ agentRole: 'mug' } as never);
    const b = await body({ to: ['*'], summary: 'HIVE-WIDE: pausing the whole hive', allHive: true });
    expect(b.results[0].to).toEqual(['*']);
    expect(b.results[0].allHiveBroadcast).toBe(true);
  });

  it("EI-9501: refuses a fleet LEADER's allHive:true broadcast — its cue is stamped fleet-members(<slug>), so blasting '*' is an internal contradiction", async () => {
    // The 2026-07-11 incident: a fleet leader relayed an owner pause directive with
    // allHive:true, meant only for its own fleet's members; it reached every agent
    // in the hive instead. The stamp (fleet-leader authority is fleet-scoped ONLY,
    // by design — queen-fleet-authority-boundary-2026-07-02) and the delivery ('*')
    // contradicted each other and shipped silently. Refuse it instead.
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops') as never);
    const b = await body({ to: ['*'], summary: 'pause the fleet', allHive: true });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'fleet_scoped_cue_allhive_contradiction' });
    expect(b.results[0].message).toMatch(/fleet-members\(ops\)/);
    expect(b.results[0].message).toMatch(/@fleet:ops/);
    expect(sendM).not.toHaveBeenCalled();
    // EI-18791996856052350: the remedy it names must be EXECUTABLE. The old text
    // said "send it from a non-fleet-authority context", which is unreachable —
    // fleet leadership is a property of the sender's identity, not of the call.
    expect(b.results[0].message).toMatch(/asAuthority:'none'/);
  });

  it("EI-18791996856052350: a fleet leader CAN send a hive-wide NOTICE with asAuthority:'none' — delivered UNSTAMPED, so it informs the hive without commanding it", async () => {
    // The refusal above is right that a fleet-scoped CUE must not blast '*'. But it
    // left a leader unable to send any hive-wide notice at all: the leader holding a
    // fleet-wide outage item (facts:assert down for every agent) could not warn the
    // hive, because its identity always stamps fleet-members(<slug>). Renouncing the
    // authority for ONE message resolves the contradiction at its real source — the
    // STAMP, not the audience.
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops') as never);
    const b = await body({
      to: ['*'],
      summary: 'HIVE-WIDE: facts:assert is failing on :3070 — re-assert after the heal',
      allHive: true,
      asAuthority: 'none',
    });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0].to).toEqual(['*']);
    expect(sendM.mock.calls[0][1].to).toEqual(['*']);
    // UNSTAMPED: an explicit null (not undefined) so the H5a seam does not re-resolve
    // the sender's fleet authority and refuse the very send this exit exists to allow.
    expect(sendM.mock.calls[0][1].cueAuthorityResolved).toBeNull();
    // the downgrade is REPORTED — a leader must never silently believe its cue
    // carried fleet-control weight hive-wide.
    expect(b.results[0].sentWithoutFleetAuthority).toBe(true);
    // and the P-010/H5b durable trace still lands, so the allhive sweep still sees it
    expect(b.results[0].allHiveBroadcast).toBe(true);
    expect(sendM.mock.calls[0][1].extra?.allHiveBroadcast).toBe(true);
  });

  it("asAuthority:'none' does NOT widen the audience on its own — without allHive a fleeted sender's ['*'] is still down-scoped", async () => {
    // The two knobs stay orthogonal: allHive decides the AUDIENCE, asAuthority decides
    // the STAMP. Renouncing authority must never become an accidental hive-wide blast.
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops') as never);
    const b = await body({ to: ['*'], summary: 'status', asAuthority: 'none' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0].to).toEqual(['@fleet:ops']);
    expect(sendM.mock.calls[0][1].to).not.toContain('*');
    expect(b.results[0].allHiveBroadcast).toBeUndefined();
    // the renunciation itself DOES still apply (it is a property of the message, not
    // of the audience) and is reported — the stamp is dropped, the audience is not
    // widened. That separation is the whole point: renouncing authority must never
    // become an accidental hive-wide blast.
    expect(sendM.mock.calls[0][1].cueAuthorityResolved).toBeNull();
    expect(b.results[0].sentWithoutFleetAuthority).toBe(true);
  });

  it("asAuthority:'none' is inert for a sender holding no fleet-leader authority", async () => {
    // An ordinary member never carries a fleet-members stamp, so there is nothing to
    // renounce — the flag must not invent a downgrade report or change delivery.
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops', 'member') as never);
    const b = await body({
      to: ['*'],
      summary: 'HIVE-WIDE: PG lock stampede',
      allHive: true,
      asAuthority: 'none',
    });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0].to).toEqual(['*']);
    expect(b.results[0].sentWithoutFleetAuthority).toBeUndefined();
  });

  it('EI-9501 guard does not fire without allHive — the ordinary fleet-scoped rewrite still applies', async () => {
    fetchPresenceFleetM.mockResolvedValue(fleetOf('ops') as never);
    const b = await body({ to: ['*'], summary: 'closed WI-999' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0].to).toEqual(['@fleet:ops']);
  });

  it("leaves a non-fleeted sender's ['*'] as a literal hive broadcast (no fleet to scope to)", async () => {
    // default mock returns an empty fleet map → no fleet → no scoping
    const b = await body({ to: ['*'], summary: 'system notice' });
    expect(b.results[0].to).toEqual(['*']);
    expect(b.results[0].scopedBroadcast).toBeUndefined();
    expect(b.results[0].allHiveBroadcast).toBeUndefined();
  });

  it('does not read presence/fleet for a purely directed send (no wildcard → no lookup)', async () => {
    const b = await body({ to: ['bee-1'], summary: 'hi' });
    expect(b.results[0].to).toEqual(['bee-1']);
    expect(fetchPresenceFleetM).not.toHaveBeenCalled();
    expect(getPresenceM).not.toHaveBeenCalled(); // nor the cue-authority resolver's read
  });
});

describe('coord:send args schema (EI-7838: missing-summary must not be masked by a sibling field error)', () => {
  const CROSS_FIELD_MSG =
    'pass { to, summary, expects } for one message, or items:[{ to, summary, expects }] for many distinct messages';

  it('missing `summary` alone reports the actionable "pass { to, summary, expects }" message', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], expects: 'none', wake: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain(CROSS_FIELD_MSG);
    }
  });

  it('a genuinely-invalid `wake` value ALONE (to+summary+expects all present) reports the wake issue, not the cross-field one', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expects: 'none', wake: 'not-a-real-value' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'wake')).toBe(true);
      expect(r.error.issues.map((i) => i.message)).not.toContain(CROSS_FIELD_MSG);
    }
  });

  it('EI-7838 repro: missing `summary` AND an invalid `wake` value together — the cross-field "need to+summary" message must still surface (previously the wake type error alone was reported, silently hiding the missing-summary problem)', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], expects: 'none', body: 'test', wake: 'not-a-real-value' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain(CROSS_FIELD_MSG);
    }
  });

  it('a fully valid single-message payload still parses cleanly through the preprocess wrapper', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expects: 'none', wake: true });
    expect(r.success).toBe(true);
  });

  it('a valid items:[…] payload (no top-level to/summary) still parses cleanly', () => {
    const r = tool.args.safeParse({ items: [{ to: ['bee-1'], summary: 'hi', expects: 'none' }] });
    expect(r.success).toBe(true);
  });
});

/**
 * P-017 (b) gate #1 / D-016 / D-048 — `expects` is REQUIRED with an explicit `none`,
 * never defaulted. D-016: "A default is how a field dies — everyone takes it, and the
 * field then carries no information."
 *
 * The gate must hold on BOTH axes. The shorthand is the cheaper call and therefore the
 * one that would carry the traffic, so a gate enforced only on items[] would not be a
 * gate — it would just relocate.
 */
describe('coord:send `expects` gate (P-017 b#1 — required-with-explicit-none, never defaulted)', () => {
  it('REFUSES a single-form send with no `expects`, naming the field and the explicit-none rule', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], summary: 'hi' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const onExpects = r.error.issues.filter((i) => i.path.join('.') === 'expects');
      expect(onExpects.length).toBeGreaterThan(0);
      expect(onExpects[0]!.message).toContain("'none'");
    }
  });

  it('REFUSES an items[] send whose item omits `expects` (the union enforces it structurally)', () => {
    const r = tool.args.safeParse({ items: [{ to: ['bee-1'], summary: 'hi' }] });
    expect(r.success).toBe(false);
  });

  it('REFUSES a value outside the enum — the vocabulary is closed, not free text', () => {
    expect(tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expects: 'maybe' }).success).toBe(false);
    expect(tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expects: true }).success).toBe(false);
  });

  it('ACCEPTS every enumerated value on both axes — including the explicit `none`', () => {
    for (const expects of ['ack', 'answer', 'action', 'none'] as const) {
      expect(tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expects }).success, expects).toBe(true);
      expect(
        tool.args.safeParse({ items: [{ to: ['bee-1'], summary: 'hi', expects }] }).success,
        `items:${expects}`,
      ).toBe(true);
    }
  });

  it('the OLD `expectsReply` input is gone — passing it does not satisfy the gate', () => {
    const r = tool.args.safeParse({ to: ['bee-1'], summary: 'hi', expectsReply: true });
    expect(r.success).toBe(false);
  });

  it('a mixed items[] batch refuses as a whole when ONE item omits `expects` (no partial default)', () => {
    const r = tool.args.safeParse({
      items: [
        { to: ['bee-1'], summary: 'ok', expects: 'ack' },
        { to: ['bee-2'], summary: 'missing' },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('report card payload (agent-report-cards-2026-07-17 P-001)', () => {
  it('a valid report is normalized and stamped on the envelope (extra.report)', async () => {
    const b = await body({
      to: ['human'],
      summary: '📋 Fleet update — 2 progressed',
      report: {
        title: '  Fleet update  ',
        plans: [
          { title: 'p2p-public-release', status: 'wip', items: [{ id: 'P-003', text: 'lanes', status: 'done' }] },
        ],
      },
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(sendM).toHaveBeenCalledTimes(1);
    const opts = sendM.mock.calls[0]![1] as { extra?: { report?: unknown } };
    expect(opts.extra?.report).toEqual({
      // NORMALIZED by parseReportBlock: title trimmed, valid plan kept.
      title: 'Fleet update',
      plans: [
        {
          slug: undefined,
          title: 'p2p-public-release',
          status: 'wip',
          summary: undefined,
          items: [{ id: 'P-003', text: 'lanes', status: 'done' }],
        },
      ],
    });
  });

  it('an invalid report (no valid plan survives) is a LOUD report_invalid refusal — nothing sent', async () => {
    const b = await body({
      to: ['human'],
      summary: 'bad card',
      report: { plans: [{ status: 'done' }] }, // no title/slug → parseReportBlock null
    });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'report_invalid' });
    expect(sendM).not.toHaveBeenCalled();
  });

  it('items axis: an invalid-report item fails ALONE; the valid one lands with its card', async () => {
    const b = await body({
      items: [
        { to: ['human'], summary: 'good', report: { plans: [{ title: 'lane-a', status: 'wip' }] } },
        { to: ['human'], summary: 'bad', report: { plans: [{ summary: 'no label' }] } },
      ],
    });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[1]).toMatchObject({ ok: false, error: 'report_invalid' });
    expect(sendM).toHaveBeenCalledTimes(1);
    const opts = sendM.mock.calls[0]![1] as { extra?: { report?: { plans: { title?: string }[] } } };
    expect(opts.extra?.report?.plans[0]?.title).toBe('lane-a');
  });

  it('no report arg → no extra.report key (plain sends unchanged)', async () => {
    await body({ to: ['human'], summary: 'plain' });
    const opts = sendM.mock.calls[0]![1] as { extra?: Record<string, unknown> };
    expect(opts.extra?.report).toBeUndefined();
  });

  it('the report shape parses through the tool arg schema (single + items axes)', () => {
    const report = { title: 'Fleet update', plans: [{ title: 'lane', items: [{ text: 'x', status: 'done' }] }] };
    expect(tool.args.safeParse({ to: ['human'], summary: 'hi', expects: 'none', report }).success).toBe(true);
    expect(
      tool.args.safeParse({ items: [{ to: ['human'], summary: 'hi', expects: 'none', report }] }).success,
    ).toBe(true);
  });
});
