/**
 * The recurrence guard for EI-20013729460455061.
 *
 * The bug was that `goals:update { status:'paused'|'killed' }` stopped nothing, and its
 * sibling WI-37615 that `status:'active'` RESUMED nothing — the label moved while
 * placement stayed gated. Both halves now ride ONE transition executor, so this guard
 * covers both directions and there is one install point to drop rather than two.
 *
 * The fix is a seam in @papercusp/agent-mcp whose executor operator-core installs AT
 * MODULE LOAD — which means the whole fix hangs on one side-effect import line in
 * agent-tools/index.ts. Drop that line and every test of the executor itself still
 * passes while the shipped behaviour silently reverts to the original bug.
 *
 * So this guard deliberately imports THE BARREL, not the module. Importing
 * ../goals/stop-fanout directly would install the executor as a side effect of the
 * test itself and pass even with the barrel line deleted — a guard anchored to the
 * wrong thing. Same failure class the cell-registrations wiring hit (an empty
 * registry served cheerfully because nothing imported the wiring), and the same
 * before/after shape as plan-items/barrel-boot.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { getGoalTransitionExecutor } from '@papercusp/agent-mcp';

describe('goal transition executor is installed by operator boot', () => {
  // Generous timeout for the same reason barrel-boot.test.ts carries one: the
  // barrel transitively transforms a large module graph, so under a loaded box it
  // is merely SLOW, never hung.
  it(
    'importing the agent-tools barrel installs the goal transition executor',
    { timeout: 180_000 },
    async () => {
      // Nothing has wired it yet — this is the state in which the original bug lives.
      expect(getGoalTransitionExecutor()).toBeUndefined();

      // Exactly what operator boot does.
      await expect(import('../agent-tools/index')).resolves.toBeDefined();

      // After boot the seam is live, so a goal stop can actually stop something.
      expect(typeof getGoalTransitionExecutor()).toBe('function');
    },
  );
});
