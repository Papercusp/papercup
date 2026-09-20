// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  isCarryRespawnSuperseded,
  makeCarryRearmController,
  makeInjectMutex,
  shouldDeferWakeForPendingRespawn,
} from '../scripts/psu-pty-host.mjs';

type Carry = {
  mode: string;
  data: string;
  systemPromptAddendum: string;
  receivedAtMs: number;
};
type EventExtra = { reason?: string };
type Boundary = { deferred: boolean };
const carry = (receivedAtMs = 10): Carry => ({
  mode: 'carry-respawn',
  data: `continue epoch ${receivedAtMs}`,
  systemPromptAddendum: `saved state ${receivedAtMs}`,
  receivedAtMs,
});
const drain = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function harness({
  waitAtPrompt = vi.fn(async (): Promise<Boundary> => ({ deferred: false })),
  waitIdle,
}: {
  waitAtPrompt?: ReturnType<typeof vi.fn<() => Promise<Boundary>>>;
  waitIdle?: () => Promise<Boundary>;
} = {}) {
  const events: { kind: string; reason?: string }[] = [];
  const recycle = vi.fn(async (_data: string, _opts: Record<string, unknown>) => {});
  const mutex = makeInjectMutex();
  let epochStartedAt = 0;
  const options = {
    acquireInject: () => mutex.acquire(),
    waitAtPrompt,
    waitIdle,
    recycle,
    emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
    isSuperseded: (msg: Carry) => isCarryRespawnSuperseded(msg.receivedAtMs, epochStartedAt),
    // An old CURRENT request remains must-deliver. Age and epoch identity
    // are deliberately different predicates.
    isStale: () => true,
    maxProductionAttempts: 3,
  };
  const controller = makeCarryRearmController(options);
  return {
    controller, events, recycle, mutex, waitAtPrompt,
    nextEpoch: (at = 20) => { epochStartedAt = at; },
  };
}

describe('WI-10002078 — production carry re-arms cannot outlive their child epoch', () => {
  it('retires an obsolete retry before waiting on the successor prompt', async () => {
    const h = harness();
    const release = await h.mutex.acquire();
    h.controller.schedule(carry());
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.nextEpoch();
    release();
    await drain();
    expect(h.waitAtPrompt).not.toHaveBeenCalled();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ kind: 'respawn-carry-dropped', reason: 'superseded' });
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(false);
  });

  it.each([true, false])('rechecks epoch after a prompt wait (deferred=%s)', async (deferred) => {
    let settle!: (value: Boundary) => void;
    const waitAtPrompt = vi.fn(() => new Promise<Boundary>((resolve) => { settle = resolve; }));
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    h.nextEpoch();
    settle({ deferred });
    await drain();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.waitAtPrompt).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toMatchObject({ kind: 'respawn-carry-dropped', reason: 'superseded' });
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('does not drop a newer carry that replaces the obsolete payload during the gate wait', async () => {
    let settle!: (value: Boundary) => void;
    const waitAtPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise<Boundary>((resolve) => { settle = resolve; }))
      .mockResolvedValue({ deferred: false });
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    h.nextEpoch();
    const fresh = carry(30);
    expect(h.controller.schedule(fresh)).toBe('superseded');
    settle({ deferred: true });
    await drain();
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.recycle.mock.calls[0]?.[0]).toBe(fresh.data);
    expect(h.events.some((event) => event.reason === 'superseded')).toBe(false);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('keeps an aged current-epoch carry until its safe boundary, without dropping or interrupting it', async () => {
    const waitAtPrompt = vi.fn()
      .mockResolvedValueOnce({ deferred: true })
      .mockResolvedValueOnce({ deferred: true })
      .mockResolvedValue({ deferred: false });
    const h = harness({ waitAtPrompt });
    h.controller.schedule(carry());
    await drain();
    expect(h.waitAtPrompt).toHaveBeenCalledTimes(3);
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.kind === 'respawn-carry-dropped')).toEqual([]);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('does not recycle through a deferred human-input gate', async () => {
    const waitIdle = vi.fn(async () => ({ deferred: true }));
    const h = harness({ waitIdle });
    h.controller.schedule(carry());
    await drain();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.waitAtPrompt).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({
      kind: 'respawn-carry-dropped', reason: 'owner-input-cap',
    });
  });

  it('yields between unbounded production retries while owner input remains staged', async () => {
    const yieldAfterDefer = vi.fn(async () => {});
    const h = harness();
    const controller = makeCarryRearmController({
      acquireInject: () => h.mutex.acquire(),
      hasPendingOwnerInput: () => true,
      waitAtPrompt: vi.fn(async () => ({ deferred: false })),
      recycle: h.recycle,
      emitEvent: (kind: string, extra: EventExtra) => h.events.push({ kind, ...extra }),
      maxProductionAttempts: 2,
      yieldAfterDefer,
    });
    controller.schedule(carry());
    await drain();
    expect(yieldAfterDefer).toHaveBeenCalled();
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({
      kind: 'respawn-carry-dropped',
      reason: 'owner-input-cap',
    });
  });

  it('waits for owner input to clear before retrying the carry', async () => {
    let pending = true;
    const h = harness();
    const controller = makeCarryRearmController({
      acquireInject: () => h.mutex.acquire(),
      hasPendingOwnerInput: () => pending,
      waitForOwnerInputClear: async () => {
        pending = false;
        return { deferred: false };
      },
      waitAtPrompt: vi.fn(async () => ({ deferred: false })),
      recycle: h.recycle,
      emitEvent: (kind: string, extra: EventExtra) => h.events.push({ kind, ...extra }),
      maxProductionAttempts: 2,
    });
    controller.schedule(carry());
    await drain();
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.kind === 'respawn-carry-dropped')).toEqual([]);
  });

  it('does not clear another accepted first attempt when one same-owner attempt finishes', () => {
    const h = harness();
    const first = carry(10);
    const second = carry(11);
    h.controller.beginFirstAttempt(first);
    h.controller.beginFirstAttempt(second);
    h.controller.endFirstAttempt(first);
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.controller.endFirstAttempt(first); // duplicate finalization is harmless
    expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    h.controller.endFirstAttempt(second);
    expect(h.controller.pendingCount()).toBe(0);
  });
});
