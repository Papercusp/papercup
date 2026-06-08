/**
 * wire-presence — the P-008 presence-publisher boot wiring. Hermetic: a mock
 * handle + injected identity/hive-slug/timer seams (no swarm, no PG, no gh).
 */

import { describe, it, expect } from 'vitest';
import { wirePresenceAnnounceForHarness, type PresenceWireHandle } from '../wire-presence';
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
      resolveHiveSlug: async () => 'my-hive',
      setIntervalFn: noTick,
    });
    expect(loop).not.toBeNull();
    expect(closeHooks).toHaveLength(1);
  });

  it('a tick stamps the resolved hive_slug on the appended presence op', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolveHiveSlug: async (ws, slug) => {
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
      resolveHiveSlug: async () => null,
      setIntervalFn: noTick,
      now: () => 1000,
    });
    await loop!.tickOnce();
    expect((appended[0].value as { hive_slug?: string | null }).hive_slug).toBeNull();
  });

  it('gh-unauthenticated (resolveIdentity null) → ticks but never appends', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => null,
      resolveHiveSlug: async () => 'my-hive',
      setIntervalFn: noTick,
    });
    await loop!.tickOnce();
    expect(appended).toHaveLength(0);
  });

  it('a failed hive-slug resolution → announces harness-scoped (hive_slug null), never throws', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wirePresenceAnnounceForHarness(handle, {
      resolveIdentity: async () => identity,
      resolveHiveSlug: async () => {
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
