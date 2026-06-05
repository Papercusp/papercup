/**
 * fleet/supervision — the spawn tree as a SUPERVISION TREE (papercusp binding).
 *
 * The mechanism (restart-intensity governor + OTP restart strategies + the crash-loop
 * teardown/escalate decision) lives in @papercusp/structured-concurrency's
 * `createSupervisor`. This module binds it to papercusp: the PG spawn-tree store, the
 * nursery (for the escalate-path teardown), and `openEscalation` as the human-escalation
 * effect. It keeps the historical `<fn>(sql, opts)` entry points.
 */
import type { Sql } from 'postgres';
import {
  createNursery,
  createSupervisor,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_WINDOW_SEC,
  type CancelNotice,
  type EscalateFn,
  type IntensityResult,
  type LockReleaser,
  type RestartSet,
  type Supervisor,
  type SuperviseResult,
} from '@papercusp/structured-concurrency';
import { pgSpawnTreeStore } from './pg-stores';
import { releaseAllLocksForOwners } from './lock-release';
import { defaultNotifier } from './nursery';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export { DEFAULT_MAX_RESTARTS, DEFAULT_RESTART_WINDOW_SEC };
export type { IntensityResult, RestartSet, SuperviseResult, EscalateFn } from '@papercusp/structured-concurrency';

export interface SuperviseOptions {
  workspaceId: string;
  spawnId: string;
  actor: AgentIdentity;
  reason?: string;
  maxRestarts?: number;
  windowSec?: number;
  /** Override the human-escalation effect (tests inject a spy). Default openEscalation. */
  escalate?: EscalateFn;
  /** Forwarded to the subtree teardown on the escalate path. */
  lockReleaser?: LockReleaser;
  notifier?: (notice: CancelNotice) => Promise<void>;
}

/** Build a supervisor bound to papercusp effects. `actor` is optional for the read-only
 *  paths (recordRestartIntensity / restartSet) that never tear a subtree down. */
function buildSupervisor(sql: Sql, opts: { actor?: AgentIdentity; escalate?: EscalateFn; lockReleaser?: LockReleaser; notifier?: (n: CancelNotice) => Promise<void> }): Supervisor {
  const store = pgSpawnTreeStore(sql);
  const actor = opts.actor;
  const nursery = createNursery({
    store,
    lockReleaser: opts.lockReleaser ?? releaseAllLocksForOwners,
    notifier: opts.notifier ?? (actor ? (n) => defaultNotifier(actor, n) : undefined),
  });
  const escalate: EscalateFn =
    opts.escalate ?? (actor ? (input) => openEscalation(actor, input) : async () => ({ msg_id: 'noop' }));
  return createSupervisor({ store, nursery, escalate });
}

export async function recordRestartIntensity(
  sql: Sql,
  opts: { workspaceId: string; spawnId: string; maxRestarts?: number; windowSec?: number },
): Promise<IntensityResult | null> {
  return buildSupervisor(sql, {}).recordRestartIntensity(opts);
}

export async function restartSet(sql: Sql, opts: { workspaceId: string; crashedSpawnId: string }): Promise<RestartSet> {
  return buildSupervisor(sql, {}).restartSet(opts);
}

export async function superviseCrash(sql: Sql, opts: SuperviseOptions): Promise<SuperviseResult> {
  const sup = buildSupervisor(sql, { actor: opts.actor, escalate: opts.escalate, lockReleaser: opts.lockReleaser, notifier: opts.notifier });
  return sup.superviseCrash({
    workspaceId: opts.workspaceId,
    spawnId: opts.spawnId,
    reason: opts.reason,
    maxRestarts: opts.maxRestarts,
    windowSec: opts.windowSec,
  });
}
