import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeOutcome } from './types';
import { MultiSessionTestbed, makeDelivery, advSessionHandle, deadPid } from '../../../test/_multi-session-testbed';

/**
 * P0a wiring: executeWake's `resume-headless` channel must forward the detached turn's
 * eventual exit to `deps.onResumeTurnExit`, bound to THIS delivery — the seam the loop
 * turn-outcome handler uses to feed the autoloop circuit on a 429 turn-death. The
 * delivery is still 'delivered' the instant a PID lands (the observation is async).
 */
describe('wake-executor — resume-headless exit observation (P0a)', () => {
  let tb: MultiSessionTestbed;
  beforeEach(() => {
    tb = MultiSessionTestbed.create();
  });
  afterEach(async () => {
    await tb.destroy();
  });

  async function exitedClaudeResumeDeps(over: Partial<ExecuteWakeDeps> = {}): Promise<{
    deps: ExecuteWakeDeps;
    s: ReturnType<MultiSessionTestbed['session']>;
  }> {
    const s = tb.session('A');
    const dead = await deadPid();
    return {
      s,
      deps: {
        findPsuHost: () => null, // no live socket → fall through to the resume ladder
        getSession: async () =>
          ({
            pid: dead,
            endedAt: null,
            agent: 'claude',
            sessionId: 'native-A',
            coordOwnerId: null,
            cwd: s.cwd,
          }) as never,
        findPty: () => null,
        write: () => true,
        presence: async () => null,
        alive: () => false,
        ...over,
      },
    };
  }

  it('forwards the detached turn exit to onResumeTurnExit, bound to the delivery; still delivers on spawn', async () => {
    let observed: { d: DeliveryWork; exit: ResumeTurnExitRaw } | null = null;
    let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
    const synthetic: ResumeTurnExitRaw = { exitCode: 1, signal: null, stdoutTail: 'API Error: 429 · Rate limited', stderrTail: '' };

    const { deps, s } = await exitedClaudeResumeDeps({
      // Capture the onExit the executor passes; pretend a pid spawned.
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitWired = onExit;
        return 4242;
      },
      onResumeTurnExit: (d, exit) => {
        observed = { d, exit };
      },
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);

    // Delivered on spawn — the observation does NOT block the delivery.
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    // The executor wired an onExit closure into the spawn.
    expect(onExitWired).toBeTypeOf('function');
    // Firing it (as the real subprocess close would) reaches onResumeTurnExit with THIS delivery.
    onExitWired!(synthetic);
    expect(observed).not.toBeNull();
    expect(observed!.d.id).toBe(d.id);
    expect(observed!.d.subscriberId).toBe(s.ownerId);
    expect(observed!.exit).toEqual(synthetic);
  });

  it('back-compat: with NO onResumeTurnExit dep, the spawn receives an undefined onExit and still delivers', async () => {
    let onExitArg: unknown = 'unset';
    const { deps, s } = await exitedClaudeResumeDeps({
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitArg = onExit;
        return 4242;
      },
      // no onResumeTurnExit
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(onExitArg).toBeUndefined();
  });
});
