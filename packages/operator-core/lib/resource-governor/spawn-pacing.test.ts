import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SPAWN_PACING,
  agentSpawnPacingConfig,
  agentSpawnPacingStats,
  resetAgentSpawnPacingForTests,
  withAgentSpawnPacing,
  type SpawnPacingConfig,
} from './spawn-pacing';

/** Drive N spawns at once and report the PEAK number that overlapped inside the body. */
async function runBurst(
  count: number,
  config: SpawnPacingConfig,
  bodyMs = 15,
): Promise<{ peak: number; startOffsets: number[] }> {
  let inFlight = 0;
  let peak = 0;
  const t0 = Date.now();
  const startOffsets: number[] = [];
  await Promise.all(
    Array.from({ length: count }, () =>
      withAgentSpawnPacing(async () => {
        startOffsets.push(Date.now() - t0);
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setTimeout(r, bodyMs));
        inFlight -= 1;
      }, config),
    ),
  );
  return { peak, startOffsets };
}

describe('agent spawn boot-window pacing', () => {
  beforeEach(() => resetAgentSpawnPacingForTests());
  afterEach(() => resetAgentSpawnPacingForTests());

  it('caps how many agents boot at once', async () => {
    const config: SpawnPacingConfig = {
      maxConcurrentBoots: 2,
      bootSettleMs: 10,
      maxWaitMs: 5_000,
    };
    const { peak } = await runBurst(8, config);
    expect(peak).toBeLessThanOrEqual(2);
  });

  /**
   * CALIBRATION CONTROL. `runBurst` is the instrument every assertion above depends on,
   * so it has to be shown capable of REPORTING a violation — otherwise a peak of 2 could
   * equally mean "pacing worked" or "the meter is broken". Pacing disabled is the same
   * code path with the limit removed, and it must report the full unpaced burst.
   */
  it('control: with pacing disabled the same burst overlaps completely', async () => {
    const { peak } = await runBurst(8, {
      maxConcurrentBoots: 0,
      bootSettleMs: 10,
      maxWaitMs: 5_000,
    });
    expect(peak).toBe(8);
  });

  it('spaces starts by the boot-settle interval rather than releasing on spawn return', async () => {
    const { startOffsets } = await runBurst(
      6,
      { maxConcurrentBoots: 2, bootSettleMs: 30, maxWaitMs: 5_000 },
      1,
    );
    const span = Math.max(...startOffsets) - Math.min(...startOffsets);
    // 6 spawns / 2 slots = 3 waves, so at least two settle intervals must have elapsed.
    // A pacer that released its slot when the (millisecond-fast) spawn call returned
    // would finish this burst in ~0ms and fail here.
    expect(span).toBeGreaterThanOrEqual(30);
  });

  it('fails open instead of refusing a launch when a holder never releases', async () => {
    const config: SpawnPacingConfig = {
      maxConcurrentBoots: 1,
      bootSettleMs: 10_000,
      maxWaitMs: 40,
    };
    // Hold the only slot for far longer than any waiter is willing to queue.
    void withAgentSpawnPacing(() => new Promise<void>(() => {}), config);
    await new Promise((r) => setTimeout(r, 5));

    let ran = false;
    await withAgentSpawnPacing(async () => {
      ran = true;
    }, config);

    expect(ran).toBe(true);
    expect(agentSpawnPacingStats().failOpenCount).toBe(1);
  });

  it('releases the slot when the spawn throws', async () => {
    const config: SpawnPacingConfig = {
      maxConcurrentBoots: 1,
      bootSettleMs: 0,
      maxWaitMs: 5_000,
    };
    await expect(
      withAgentSpawnPacing(async () => {
        throw new Error('no terminal');
      }, config),
    ).rejects.toThrow('no terminal');
    expect(agentSpawnPacingStats().active).toBe(0);

    // The next launch must still be admitted — a failed spawn must not leak a slot.
    let ran = false;
    await withAgentSpawnPacing(async () => {
      ran = true;
    }, config);
    expect(ran).toBe(true);
  });

  it('admits a queued burst in arrival order', async () => {
    const config: SpawnPacingConfig = {
      maxConcurrentBoots: 1,
      bootSettleMs: 1,
      maxWaitMs: 5_000,
    };
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        withAgentSpawnPacing(async () => {
          order.push(i);
        }, config),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  describe('config', () => {
    const KEYS = [
      'PAPERCUSP_AGENT_SPAWN_MAX_CONCURRENT_BOOTS',
      'PAPERCUSP_AGENT_SPAWN_BOOT_SETTLE_MS',
      'PAPERCUSP_AGENT_SPAWN_PACING_MAX_WAIT_MS',
    ] as const;

    it('defaults when unset', () => {
      expect(agentSpawnPacingConfig({})).toEqual(DEFAULT_SPAWN_PACING);
    });

    it('reads explicit overrides, including a deliberate 0 disable', () => {
      expect(
        agentSpawnPacingConfig({
          [KEYS[0]]: '0',
          [KEYS[1]]: '250',
          [KEYS[2]]: '9000',
        }),
      ).toEqual({ maxConcurrentBoots: 0, bootSettleMs: 250, maxWaitMs: 9_000 });
    });

    /**
     * A typo'd env var must fall back to the default, NOT to zero. Reading garbage as 0
     * would silently DISABLE pacing on the box that typo'd it, and the resulting dropped
     * briefs would look exactly like the bug this guard was added to fix.
     */
    it('falls back to the default on a non-numeric or negative value', () => {
      for (const bad of ['abc', '-1', 'NaN', ' ']) {
        expect(agentSpawnPacingConfig({ [KEYS[0]]: bad }).maxConcurrentBoots).toBe(
          DEFAULT_SPAWN_PACING.maxConcurrentBoots,
        );
      }
    });
  });
});
