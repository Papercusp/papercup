/**
 * WI-752 late-join re-wire: when the boot-time swarm join fails and only the
 * join-RETRY later attaches the swarm, the presence step — which no-ops against
 * `swarm: null` and is then marked wired — must be UN-marked and re-attempted
 * via the boot engine's `onSwarmJoinRecovered` hook. Pins the 2026-07-17 tower
 * bg-host failure: a whole process lifetime ran presence-gossip-less with the
 * PRESENCE_GOSSIP flag ON because nothing re-wired after the join recovery.
 * Outbox must NOT be re-wired (it never needs the swarm, and a second wire
 * could double-arm its drain loop).
 */
import { describe, expect, it, vi } from 'vitest';
import { bootSingleHarness } from './boot-all';
import type { BootHarnessOpts, BootedHarnessHandle } from './boot';

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  return {
    workspaceId,
    harnessSlug,
    swarm: null,
    registerCloseHook: () => {},
    close: async () => {},
  } as unknown as BootedHarnessHandle;
}

describe('boot-all onSwarmJoinRecovered re-wire (WI-752 late join)', () => {
  it('re-attempts presence wiring — and only presence — after the join-retry recovery hook fires', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let recovered: (() => void) | undefined;
    const wireOutbox = vi.fn(async () => {});
    const wirePresence = vi.fn(async () => {});

    const res = await bootSingleHarness('ws-swarm-rewire', 'hx-rewire', {
      resolveSwarmBinding: async () => null,
      bootHarness: async (o: BootHarnessOpts) => {
        recovered = o.onSwarmJoinRecovered;
        return fakeHandle('ws-swarm-rewire', 'hx-rewire');
      },
      wireSendSide: { wireOutbox, wirePresence },
    });

    expect(res.state).toBe('booted');
    // Initial boot wires both steps once (presence no-ops inside the real
    // wirePresenceAnnounceForHarness on swarm:null — here the injected fake
    // stands in; what matters is the marking).
    expect(wirePresence).toHaveBeenCalledTimes(1);
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(recovered).toBeTypeOf('function');

    // The WI-752 join-retry succeeds later and fires the hook: presence must be
    // un-marked and re-wired against the registered handle; outbox must not.
    recovered!();
    await vi.waitFor(() => expect(wirePresence).toHaveBeenCalledTimes(2));
    expect(wireOutbox).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('swarm join recovered'));
    errSpy.mockRestore();
  });
});
