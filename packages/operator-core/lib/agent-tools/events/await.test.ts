/**
 * await.test.ts — events:await wrapper defaults (GAP 16).
 *
 * Mirrors watch.test.ts's tool-mock rig. events:await is the one-shot WAKE sugar
 * — asserts registerAwait is called with policy:'wake', timeoutBehavior:'wake'
 * by default, timeoutSec = the shared AWAIT_DEFAULT_TIMEOUT_SEC (1800 = 30min) by
 * default, that overrides flow through, and that the response carries
 * await_id/expires_ts/wake_handle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-awaiter', ownerLabel: 'a', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 99, eventKey: i.eventKey, expiresTs: '2030-01-01', timeoutBehavior: i.timeoutBehavior })),
}));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
vi.mock('../coordination/messages', () => ({ getMessageById: vi.fn() }));
// EI-10870: the orphan-key guard reads the INSTALLED tier to avoid false-warning on a
// pack-declared key. Default: no installed packs ⇒ the builtin catalog decides.
vi.mock('../../events/await/installed-events', () => ({
  readInstalledUnitEvents: vi.fn(async () => []),
}));
// EI-13095: the done/unblocked registration latches probe the live item — mocked so
// the rig stays hermetic (the real module pulls db-org). Defaults ('live'/'blocked')
// make every existing case register exactly as before.
vi.mock('../../work-items-events', () => ({
  liveSettledProbe: vi.fn(async () => ({ verdict: 'live' as const, itemState: 'wip' })),
  liveBlockedState: vi.fn(async () => 'blocked' as const),
}));
// EI-383: the claim-lease-extension side-call also pulls db-org (via claims.ts +
// resolvePlanScope) — mocked so the rig stays hermetic, same reasoning as the
// work-items-events mock above.
vi.mock('../../plan-items/claims', () => ({
  extendOwnerClaimsForAwait: vi.fn(async () => [] as string[]),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-x', harnessSlug: 'papercup' })),
}));

import awaitTool from './await';
import { registerAwait } from '../../events/await/store';
import { getMessageById } from '../coordination/messages';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { startAwaitSweeper } from '../../events/await/engine';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import { liveSettledProbe } from '../../work-items-events';
import { AWAIT_DEFAULT_TIMEOUT_SEC } from '../../events/await/types';
import { extendOwnerClaimsForAwait } from '../../plan-items/claims';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof awaitTool.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await awaitTool.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('events:await wrapper defaults', () => {
  it('defaults: policy:wake, timeoutBehavior:wake, timeoutSec:AWAIT_DEFAULT_TIMEOUT_SEC (1800 = 30min), and the sweeper starts', async () => {
    await call({ event: 'lock:grant:t1' });
    expect(startAwaitSweeper).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-awaiter',
      eventKey: 'lock:grant:t1',
      policy: 'wake',
      timeoutBehavior: 'wake',
      timeoutSec: AWAIT_DEFAULT_TIMEOUT_SEC,
      note: null,
    });
    // WI-3575: registerAwait no longer takes workspaceId (events:await is
    // single-workspace by design — see store.ts).
    expect(arg).not.toHaveProperty('workspaceId');
  });

  it('captures the wake handle NOW and stamps it onto the registration', async () => {
    await call({ event: 'k', plan_run_id: 5 });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-awaiter', { planRunId: 5 });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg.wakeHandle).toMatchObject({ kind: 'adv-session' });
  });

  it('overrides: on_timeout=expire, timeout_sec, and note flow through', async () => {
    await call({ event: 'k', on_timeout: 'expire', timeout_sec: 30, note: 'why' });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ timeoutBehavior: 'expire', timeoutSec: 30, note: 'why' });
  });

  it('response carries await_id / event / expires_ts / on_timeout / wake_handle', async () => {
    const out = await call({ event: 'plan-run:finished:9' });
    expect(out).toMatchObject({
      ok: true,
      await_id: 99,
      event: 'plan-run:finished:9',
      expires_ts: '2030-01-01',
      on_timeout: 'wake',
      wake_handle: 'resumable',
    });
  });

  // ── P-201: pattern / macro awaits ────────────────────────────────────────
  it('a raw glob is stored as-is and flagged pattern:true in the response', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:done:*');
    expect(out).toMatchObject({ ok: true, event: 'work-item:done:*', pattern: true });
    expect(out.advice).toContain('PATTERN');
  });

  it('@plan:<slug> expands to the plan-item glob before registering', async () => {
    await call({ event: '@plan:my-plan-2026' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('plan-item:done:my-plan-2026:*');
  });

  it('@fleet:<slug> expands to the fleet glob before registering', async () => {
    await call({ event: '@fleet:red-team' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('fleet:*:red-team');
  });

  it('an exact key is NOT flagged as a pattern', async () => {
    const out = await call({ event: 'lock:grant:t1' });
    expect(out.pattern).toBeUndefined();
  });

  it('rejects an unknown macro and a too-broad pattern (never registers)', async () => {
    await expect(call({ event: '@bogus:x' })).rejects.toThrow(/unknown pattern macro/);
    await expect(call({ event: '*' })).rejects.toThrow(/too broad/);
    expect(registerAwait).not.toHaveBeenCalled();
  });

  // ── EI-8998: predicate/payload watches ────────────────────────────────────
  it('payload_filter flows through to registerAwait; omitted defaults to null', async () => {
    const filter = { severity: { gte: 3 } };
    await call({ event: 'alert:raised', payload_filter: filter });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: filter });

    vi.clearAllMocks();
    await call({ event: 'alert:raised' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ payloadFilter: null });
  });

  // ── coord-authority-hardening P-006: fromMsg — resolve the gate key OFF the
  //    declaring message so the awaiter never re-types it ─────────────────────
  describe('fromMsg (P-006)', () => {
    it('resolves the single gateRef off the message and registers on that EXACT key', async () => {
      vi.mocked(getMessageById).mockResolvedValue({
        msg_id: 'm-1',
        gateRefs: [{ key: 'fleet:p2p-git:phase1-green', status: 'declared' }],
      } as never);
      const out = await call({ fromMsg: 'm-1' });
      expect(out.ok).toBe(true);
      expect(out.resolved_from_msg).toBe('m-1');
      expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
        eventKey: 'fleet:p2p-git:phase1-green',
      });
    });

    it('msg_not_found is a loud error — nothing registered', async () => {
      vi.mocked(getMessageById).mockResolvedValue(null as never);
      const out = await call({ fromMsg: 'm-nope' });
      expect(out).toMatchObject({ ok: false, error: 'msg_not_found' });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('a message with no gateRefs stamp is a loud no_gate_refs_on_msg', async () => {
      vi.mocked(getMessageById).mockResolvedValue({ msg_id: 'm-2', summary: 'prose only' } as never);
      const out = await call({ fromMsg: 'm-2' });
      expect(out).toMatchObject({ ok: false, error: 'no_gate_refs_on_msg' });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('multiple gateRefs is ambiguous — the keys are listed for an explicit `event` await', async () => {
      vi.mocked(getMessageById).mockResolvedValue({
        msg_id: 'm-3',
        gateRefs: [
          { key: 'g-one', status: 'declared' },
          { key: 'g-two', status: 'declared' },
        ],
      } as never);
      const out = await call({ fromMsg: 'm-3' });
      expect(out).toMatchObject({ ok: false, error: 'ambiguous_gate_refs', gate_refs: ['g-one', 'g-two'] });
      expect(registerAwait).not.toHaveBeenCalled();
    });

    it('schema: event/spec/fromMsg are mutually exclusive (exactly one)', () => {
      const schema = (awaitTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
      expect(schema.safeParse({ event: 'k', fromMsg: 'm-1' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ fromMsg: 'm-1' }).success).toBe(true);
    });
  });
});

describe('EI-10870 — the ORPHAN-AWAIT guard (a key nothing emits can only ever time out)', () => {
  it('WARNS on a key with no registered emitter — and still REGISTERS it (warn, never reject)', async () => {
    // The real orphan: 14 settled awaits, 0 fires ever, appears nowhere in the tree.
    const out = await call({ event: 'overwatch:surface-landed' });

    expect(out.unknown_event_key).toBe(true);
    expect(out.unknown_event_key_advice).toMatch(/NO REGISTERED EMITTER/);
    expect(out.unknown_event_key_advice).toMatch(/can only TIME OUT/);

    // Fail-open: the await is still registered. A hard reject would break the
    // legitimate not-yet-catalogued cases (hand-minted pair keys, announced gates).
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT on a real catalogued key — no false alarm on the happy path', async () => {
    const out = await call({ event: 'release:green:papercusp' });
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.unknown_event_key_advice).toBeUndefined();
    expect(out.await_id).toBe(99);
  });

  it('stays silent on a PATTERN await (a glob is not a key and has no single emitter)', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(out.pattern).toBe(true);
    expect(out.unknown_event_key).toBeUndefined();
  });

  it('does NOT warn on a key declared by an INSTALLED pack (the false-positive that would train the warning out)', async () => {
    vi.mocked(readInstalledUnitEvents).mockResolvedValueOnce([
      {
        unit: 'my-pack',
        events: [
          {
            family: 'my-pack',
            keyTemplate: 'my-pack:thing-happened:<id>',
            params: [{ name: 'id', required: true }],
            describe: 'a pack-declared event',
            emitter: 'my-pack',
          },
        ],
      },
    ] as never);

    const out = await call({ event: 'my-pack:thing-happened:42' });
    expect(out.unknown_event_key).toBeUndefined();
  });

  it('stays SILENT when the installed tier cannot be confirmed — an unverifiable claim is worse than no warning', async () => {
    // Discovery throws ⇒ withBoundedTimeout degrades to the null fallback ⇒ we cannot
    // prove the key is an orphan ⇒ say nothing (and never break the registration).
    // The degradation IS logged (a cold plugin host should be visible in the logs) —
    // assert that explicitly rather than let it leak past fail-on-console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readInstalledUnitEvents).mockRejectedValueOnce(new Error('plugin host cold'));

    const out = await call({ event: 'overwatch:surface-landed' });
    expect(out.unknown_event_key).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99); // the await still registers — the guard is advisory
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('events-await:orphanKey'));
    warn.mockRestore();
  });
});

describe('the done-key registration LATCH (EI-13095 — the WI-5075 stranded-await incident)', () => {
  it('awaiting work-item:done:<id> for an ALREADY-settled item answers already_done and registers NOTHING', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'settled', itemState: 'resolved' });
    const out = await call({ event: 'work-item:done:WI-5075' });
    expect(out).toMatchObject({ ok: true, already_done: true, event: 'work-item:done:WI-5075', item_state: 'resolved' });
    expect(out.advice).toContain('Do not wait');
    expect(registerAwait).not.toHaveBeenCalled();
    expect(liveSettledProbe).toHaveBeenCalledWith('WI-5075');
  });

  it('a LIVE item registers exactly as before (the latch only answers on settled)', async () => {
    const out = await call({ event: 'work-item:done:WI-42' });
    expect(out.already_done).toBeUndefined();
    expect(out.await_id).toBe(99);
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('work-item:done:WI-42');
  });

  it('an UNKNOWN probe (unreadable/ambiguous id) fails OPEN — the registration proceeds', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'unknown' });
    const out = await call({ event: 'work-item:done:WI-404' });
    expect(out.already_done).toBeUndefined();
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('a PATTERN await (work-item:done:*) never probes — patterns can always match a future key', async () => {
    const out = await call({ event: 'work-item:done:*' });
    expect(liveSettledProbe).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
    expect(registerAwait).toHaveBeenCalledTimes(1);
  });

  it('non-done keys never probe (no per-registration tax on unrelated awaits)', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(liveSettledProbe).not.toHaveBeenCalled();
  });
});

describe('EI-383 — extend the caller\'s plan-item claim leases to survive the sleep', () => {
  it('an ACTUAL registration extends claims sized to the resolved timeout_sec', async () => {
    await call({ event: 'lock:grant:t9', timeout_sec: 3600 });
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledTimes(1);
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledWith('ws-x', 'su-awaiter', 3600);
  });

  it('no timeout_sec passed → extends using the shared default', async () => {
    await call({ event: 'lock:grant:t9' });
    expect(extendOwnerClaimsForAwait).toHaveBeenCalledWith('ws-x', 'su-awaiter', AWAIT_DEFAULT_TIMEOUT_SEC);
  });

  it('an already-settled/no-sleep short-circuit does NOT extend anything (no real sleep happens)', async () => {
    vi.mocked(liveSettledProbe).mockResolvedValueOnce({ verdict: 'settled', itemState: 'resolved' });
    const out = await call({ event: 'work-item:done:WI-5075' });
    expect(out.already_done).toBe(true);
    expect(extendOwnerClaimsForAwait).not.toHaveBeenCalled();
  });

  it('a claim-extension failure never blocks or fails the await registration (best-effort)', async () => {
    vi.mocked(extendOwnerClaimsForAwait).mockRejectedValueOnce(new Error('db unreachable'));
    const out = await call({ event: 'lock:grant:t9' });
    expect(out.ok).toBe(true);
    expect(out.await_id).toBe(99);
  });
});
