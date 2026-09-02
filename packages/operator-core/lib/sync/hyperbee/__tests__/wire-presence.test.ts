/**
 * wire-presence — the P-008 presence-publisher boot wiring. Hermetic: a mock
 * handle + injected identity/hive-slug/timer seams (no swarm, no PG, no gh).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  wirePresenceAnnounceForHarness,
  publishPresenceTombstoneForHarness,
  type PresenceWireHandle,
  createBroadcastFailureReporter,
} from '../wire-presence';
import type { LocalWriteOp } from '../boot';
import type { PresenceIdentity } from '../presence-announce';

function mockHandle(over: Partial<PresenceWireHandle> = {}): {
  handle: PresenceWireHandle;
  appended: LocalWriteOp[];
  closeHooks: Array<() => void | Promise<void>>;
} {
  const appended: LocalWriteOp[] = [];
  const closeHooks: Array<() => void | Promise<void>> = [];
  const handle: PresenceWireHandle = {
    workspaceId: 'ws',
    harnessSlug: 'repo-a',
    ownLog: { keyHex: 'abc' },
    append: async (op) => {
      appended.push(op);
    },
    swarm: {}, // joined a swarm
    registerCloseHook: (h) => {
      closeHooks.push(h);
      return () => {};
    },
    ...over,
  };
  return { handle, appended, closeHooks };
}

const identity: PresenceIdentity = { githubUserId: 7, machineLabel: 'm1', devicePubkey: 'pk' };
// A setInterval that never fires the callback — keeps the loop deterministic (we drive tickOnce).
const noTick = () => 0 as unknown as ReturnType<typeof setInterval>;

describe('wirePresenceAnnounceForHarness (P-008 publisher wiring)', () => {
  it('does NOT start when the harness joined no swarm (private/local)', async () => {
    const { handle } = mockHandle({ swarm: null });
    expect(await wirePresenceAnnounceForHarness(handle, { resolveIdentity: async () => identity })).toBeNull();
  });

  it('does NOT start when intervalMs <= 0 (disabled)', async () => {
    const { handle } = mockHandle();
    expect(
      await wirePresenceAnnounceForHarness(handle, { intervalMs: 0, resolveIdentity: async () => identity }),
    ).toBeNull();
  });

  it('starts the loop + registers a close hook for a swarmed harness', async () => {
    const { handle, closeHooks } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolvePotSlug: async () => 'my-hive',
      setIntervalFn: noTick,
    });
    expect(loop).not.toBeNull();
    expect(closeHooks).toHaveLength(1);
  });

  it('a tick stamps the resolved hive_slug on the appended presence op', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolvePotSlug: async (ws, slug) => {
        expect([ws, slug]).toEqual(['ws', 'repo-a']);
        return 'my-hive';
      },
      setIntervalFn: noTick,
      now: () => 1000,
    });
    await loop!.tickOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ table: 'presence', hbKey: '7/m1' });
    expect((appended[0].value as { hive_slug?: string | null }).hive_slug).toBe('my-hive');
  });

  it('a non-Hive harness announces with hive_slug null', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolvePotSlug: async () => null,
      setIntervalFn: noTick,
      now: () => 1000,
    });
    await loop!.tickOnce();
    expect((appended[0].value as { hive_slug?: string | null }).hive_slug).toBeNull();
  });

  it('gh-unauthenticated (resolveIdentity null) → ticks but never appends, and SAYS SO', async () => {
    const { handle, appended } = mockHandle();
    // EI-18768167802573425: "no identity → announce nothing" used to be entirely
    // silent, which is how a node could be invisible to every peer with clean
    // logs. The wiring now warns on each (throttled) failed attempt.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loop = await wirePresenceAnnounceForHarness(handle, {
        resolveIdentity: async () => null,
        resolvePotSlug: async () => 'my-hive',
        setIntervalFn: noTick,
      });
      await loop!.tickOnce();
      expect(appended).toHaveLength(0);
      const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toContain('no swarm identity');
      expect(msg).toContain('ws::repo-a');
      expect(msg).toContain('announcing NOTHING');
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed hive-slug resolution → announces harness-scoped (hive_slug null), never throws', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolvePotSlug: async () => {
        throw new Error('registry unavailable');
      },
      setIntervalFn: noTick,
      now: () => 1000,
    });
    expect(loop).not.toBeNull();
    await loop!.tickOnce();
    expect((appended[0].value as { hive_slug?: string | null }).hive_slug).toBeNull();
  });
});

describe('publishPresenceTombstoneForHarness (EI-469 leave retract)', () => {
  it('appends a del op on this device key when swarmed + identity resolves', async () => {
    const { handle, appended } = mockHandle();
    const ok = await publishPresenceTombstoneForHarness(handle, {
      resolveIdentity: async () => identity,
      now: () => 4242,
    });
    expect(ok).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: 'del', table: 'presence', hbKey: '7/m1', ts: 4242 });
    expect(appended[0].value).toBeUndefined(); // a tombstone carries no row
  });

  it('no-op (false) for a private/local harness (no swarm) — no peers to tell', async () => {
    const { handle, appended } = mockHandle({ swarm: null });
    expect(await publishPresenceTombstoneForHarness(handle, { resolveIdentity: async () => identity })).toBe(false);
    expect(appended).toHaveLength(0);
  });

  it('no-op (false) when gh is unauthenticated (identity null) — nothing to retract', async () => {
    const { handle, appended } = mockHandle();
    expect(await publishPresenceTombstoneForHarness(handle, { resolveIdentity: async () => null })).toBe(false);
    expect(appended).toHaveLength(0);
  });

  it('an identity-resolver throw is swallowed → false, never throws', async () => {
    const { handle, appended } = mockHandle();
    const ok = await publishPresenceTombstoneForHarness(handle, {
      resolveIdentity: async () => {
        throw new Error('keychain locked');
      },
    });
    expect(ok).toBe(false);
    expect(appended).toHaveLength(0);
  });
});

// EI-18767449529288937 — a failed presence gossip broadcast used to be COMPLETELY
// silent (the false return discarded at the only call site; throws swallowed into
// that same false), so a node could be invisible to every peer with clean logs.
// Observed live on the 2-machine rig (WI-559). These cover the pure reporter that
// now carries the signal.
describe('createBroadcastFailureReporter (EI-18767449529288937 broadcast-failure signal)', () => {
  function harness(warnIntervalMs = 1000) {
    const warns: string[] = [];
    const infos: string[] = [];
    let now = 0;
    const note = createBroadcastFailureReporter({
      label: 'ws::repo-a',
      now: () => now,
      warnIntervalMs,
      warn: (m) => warns.push(m),
      info: (m) => infos.push(m),
    });
    return {
      warns,
      infos,
      note,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const TOPIC = 'abcdef0123456789';

  it('a delivered beat is silent — no log noise on the healthy path', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.note(true, TOPIC);
    expect(h.warns).toHaveLength(0);
    expect(h.infos).toHaveLength(0);
  });

  it('warns IMMEDIATELY on the first failure, naming the node and the consequence', () => {
    const h = harness();
    h.note(false, TOPIC);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain('ws::repo-a');
    expect(h.warns[0]).toContain('NOT reaching peers');
    // The operative consequence — why a reader should care.
    expect(h.warns[0]).toContain('INVISIBLE');
    // The topic is identified (truncated), so a multi-topic node is diagnosable.
    expect(h.warns[0]).toContain('abcdef012345');
  });

  it('THROTTLES a permanently-failing broadcast instead of flooding the log', () => {
    const h = harness(1000);
    // A permanently-unbound writer re-attempts every ~30s forever; 50 beats inside
    // one window must not produce 50 lines.
    for (let i = 0; i < 50; i++) h.note(false, TOPIC);
    expect(h.warns).toHaveLength(1);
  });

  it('warns again once the throttle window elapses, with a rising streak count', () => {
    const h = harness(1000);
    h.note(false, TOPIC); // streak 1 → warns
    h.advance(999);
    h.note(false, TOPIC); // still inside the window → silent
    expect(h.warns).toHaveLength(1);
    h.advance(1);
    h.note(false, TOPIC); // window elapsed → warns again
    expect(h.warns).toHaveLength(2);
    // The count is the evidence that this is sustained, not a one-off miss.
    expect(h.warns[1]).toContain('3 consecutive');
  });

  it('reports RECOVERY when a beat lands after a failing streak, then resets', () => {
    const h = harness(1000);
    h.note(false, TOPIC);
    h.note(false, TOPIC);
    h.note(true, TOPIC);
    expect(h.infos).toHaveLength(1);
    expect(h.infos[0]).toContain('RECOVERED');
    expect(h.infos[0]).toContain('2 consecutive failed beat(s)');
    // Streak reset: the next failure is a FIRST failure again (warns immediately,
    // not swallowed by the throttle left over from the previous episode).
    const warnsBefore = h.warns.length;
    h.note(false, TOPIC);
    expect(h.warns).toHaveLength(warnsBefore + 1);
    expect(h.warns[h.warns.length - 1]).toContain('1 consecutive');
  });

  it('a recovery with no prior failure is silent (never announces a non-event)', () => {
    const h = harness();
    h.note(true, TOPIC);
    expect(h.infos).toHaveLength(0);
  });
});
