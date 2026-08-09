/**
 * The pot pause STATE TRANSITION, extracted from the `pot:pause` tool so the goal
 * stop fan-out (EI-20013729460455061) performs the identical transition instead of
 * re-implementing it.
 *
 * Re-implementing it was the alternative, and it would have drifted on the two
 * things that are easy to omit and silent when omitted:
 *   - the P-013 ORDERING — the per-pot placement bit is cleared FIRST so no
 *     watchdog seam re-arms between the wake clear and the state flip;
 *   - the `deliberate: true` markers (WI-3261 / WI-3309) — without them the
 *     paused-pot recovery sweep reads the pause as a silent outage and AUTO-RESUMES
 *     it. A goal stop that got quietly undone by a watchdog minutes later would be
 *     the same class of bug the goal stop exists to fix.
 *
 * The graceful cup-drain cue stays in the tool: it needs the caller's agent
 * identity, and it is a policy choice (the harder stop), not part of the transition.
 */

import type { Sql } from 'postgres';
import { clearPotTimeWake } from './wake';
import { setPotStarted, setPotPlacementStarted, anyPotPlacementStarted } from './started';
import { setDefaultWakeMode } from '../agent-tools/coordination/wake-mode';

export interface PausePotResult {
  harness: string;
  started: false;
  wakeMode: 'manual' | 'auto';
  /** True when NO pot remained started, so the workspace Mug loop was idled too. */
  workspaceLoopIdle: boolean;
  timeWakeCleared: boolean;
}

/**
 * Clear a pot's placement bit and, when it was the last started pot, idle the
 * workspace Mug loop. Idempotent: pausing an already-paused pot is a no-op write.
 */
export async function pausePotState(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
): Promise<PausePotResult> {
  // Per-pot Stop: clear THIS pot's placement bit FIRST (P-013 ordering). This is
  // what stops the workspace Mug placing THIS pot's work.
  await setPotPlacementStarted(workspaceId, installSlug, false, { deliberate: true });

  // Idle the workspace Mug LOOP only when NO pot remains started — otherwise the
  // single workspace Mug keeps running for the other started hives.
  const loopIdle = !(await anyPotPlacementStarted(workspaceId, installSlug));
  if (loopIdle) {
    await setPotStarted(workspaceId, installSlug, false, { deliberate: true });
    await setDefaultWakeMode('manual');
    await clearPotTimeWake(sql, installSlug, { workspaceId });
  }

  return {
    harness: installSlug,
    started: false,
    wakeMode: loopIdle ? 'manual' : 'auto',
    workspaceLoopIdle: loopIdle,
    timeWakeCleared: loopIdle,
  };
}
