/**
 * stalled-loops-guard — act on the `turnsStalled` signal instead of leaving a dead
 * loop armed indefinitely (WI-6639).
 *
 * THE GAP THIS CLOSES. `computeTurnsStalled` (loop.ts) already detects a loop that
 * is `active: true` (armed) but has stopped producing turns — fires keep landing (or
 * even the FIRES themselves have stopped) while no genuine turn completes. Before
 * this file, `turnsStalled`'s only consumer was the read-only `loop:status` tool: an
 * agent had to think to ask about ITS OWN loop, or a human had to eyeball the HUD, for
 * the signal to matter at all. Measured live 2026-07-28: 15 sessions carried an armed
 * loop with no tool call in 37h-158h, three of them for a session that had already
 * ENDED — the routine kept being scheduled against an owner that was gone, forever,
 * because nothing ever turned the switch off.
 *
 * WHY DISARM + BROADCAST, NOT DELETE. This is the coherence sibling of
 * `gc-dead-loops.ts`, not a replacement for it: `gc-dead-loops` reaps INACTIVE loop
 * rows whose owner has been silent past a long retention window (14d) — pure
 * space-reclamation on rows that are already known-dead. This module's job is
 * upstream of that: flip an armed-but-dead loop to `active: false` (mirroring
 * `autoPauseLoopRoutine`, the exact primitive the cost-cap and dead-man guards already
 * use — "the paused state IS the notification", per that module's own doc) so
 * `gc-dead-loops` can eventually reap the row, `loop:status` stops reporting a lie,
 * and the routines engine stops scheduling wakes nobody will ever answer. The
 * broadcast (reusing `severe-event-broadcast`, the same rail `green-stall-watchdog` /
 * `git-sync-stall-watchdog` use) is the ESCALATION half WI-6639 asked for: someone
 * running fleet-wide should learn that a batch of loops just went dark, because a
 * cluster of stalls (WI-6639's own sample clustered at ~47-48h and ~155-158h) is
 * usually ONE systemic event — a wedged wake channel, a deploy, an operator restart —
 * not N independent failures, and only a human/fleet-wide read can chase that down.
 *
 * SAFETY. Reuses `computeTurnsStalled` UNCHANGED (loop.ts) via `getLoopStatuses` — the
 * exact same conservative verdict `loop:status` already reports (≥3 fires required,
 * a generous multiple-of-interval floor, exempt whenever the session shows real
 * presence activity). This module adds no new judgement of its own; it only acts on
 * a verdict that was already being computed and silently ignored.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { getLoopStatuses, type LoopStatus } from './loop';
import { autoPauseLoopRoutine } from './loop-cost-cap';
import { broadcastSevereEvent } from '../../severe-event-broadcast';

export interface StalledLoopsSweepDeps {
  /** Injectable for tests; defaults to the real batch status read. */
  getStatuses?: typeof getLoopStatuses;
  /** Injectable for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
}

export interface StalledLoopsSweepResult {
  /** How many active loop-% routines were examined. */
  checked: number;
  /** How many were disarmed (or, under dryRun, matched) this pass. */
  paused: number;
  /** A sample of the disarmed ownerIds, for the log line / broadcast. */
  sample: string[];
  dryRun: boolean;
}

/**
 * Sweep every ACTIVE `loop-%` routine in the workspace, disarm any whose
 * `computeTurnsStalled` verdict is true, and — if at least one was disarmed —
 * broadcast a single fleet-wide notice naming all of them (never one message per
 * loop, mirroring `broadcastSevereEventResolvedMany`'s "don't spam N inboxes for one
 * root cause" reasoning).
 *
 * Workspace-scoped, not harness-scoped, for the same reason `gc-dead-loops` is:
 * `loop-<ownerId>` rows are keyed by the session that armed them, not by the harness
 * it happens to be working in.
 */
export async function sweepStalledLoops(
  opts: { sql?: Sql; workspaceId?: string; dryRun?: boolean } = {},
  deps: StalledLoopsSweepDeps = {},
): Promise<StalledLoopsSweepResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const dryRun = opts.dryRun === true;
  const getStatuses = deps.getStatuses ?? getLoopStatuses;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;
  const broadcast = deps.broadcast ?? broadcastSevereEvent;

  const rows = await sql<Array<{ id: string; target_owner_id: string }>>`
    SELECT id, target_owner_id
      FROM harness_shared.routines
     WHERE workspace_id = ${ws}
       AND name LIKE 'loop-%'
       AND target_owner_id IS NOT NULL
       AND active = true
  `;
  if (rows.length === 0) return { checked: 0, paused: 0, sample: [], dryRun };

  // Latest routine id per owner (an owner should carry exactly one active loop row,
  // but guard against a duplicate the same way materializeLoop's own overwrite logic
  // does — last one wins).
  const routineIdByOwner = new Map<string, string>();
  for (const r of rows) routineIdByOwner.set(r.target_owner_id, r.id);

  const statuses: Map<string, LoopStatus> = await getStatuses([...routineIdByOwner.keys()], { sql });

  const stalledOwners: string[] = [];
  for (const [ownerId, routineId] of routineIdByOwner) {
    const status = statuses.get(ownerId);
    if (!status?.turnsStalled) continue;
    stalledOwners.push(ownerId);
    if (dryRun) continue;
    const reason =
      `turns-stalled: ${status.fireCount} fire(s), last fired ${status.lastFiredAt ?? 'never'}, ` +
      `last turn ${status.lastTurnAt ?? 'never'}`;
    await autoPause(sql, routineId, `stalled-loops-guard (WI-6639): ${reason}`);
  }

  if (stalledOwners.length > 0 && !dryRun) {
    await broadcast({
      summary:
        `${stalledOwners.length} armed engine loop(s) auto-disarmed on ${ws} — fires kept landing ` +
        `(or stopped entirely) with no turn actually produced (WI-6639).`,
      body:
        `Owners: ${stalledOwners.join(', ')}. Each carried an ARMED loop (active:true) whose ` +
        `computeTurnsStalled verdict was true — either no turn has ever completed after several ` +
        `fires, or the gap since the last fire exceeds the stall floor with no recent session ` +
        `presence. Auto-disarmed by stalled-loops-guard; re-arm with loop:arm if the session is ` +
        `genuinely still working. A cluster of stalls in one sweep is usually ONE systemic event ` +
        `(a wedged wake channel, a deploy, an operator restart) rather than independent failures — ` +
        `worth chasing if this recurs.`,
      category: 'severe-event',
    });
  }

  return { checked: rows.length, paused: stalledOwners.length, sample: stalledOwners.slice(0, 5), dryRun };
}
