/**
 * Pure predicates for the DBOS default-on gates (P-009 + the autoloop/timers
 * migration). Centralized so the bootstrap registration and the legacy
 * stand-down checks (autoloop ticker, periodic timers) use the EXACT same
 * condition — guaranteeing exactly one of {DBOS, legacy} runs (no gap, no
 * double-fire).
 *
 * Master revert: PAPERCUSP_DBOS_ORCHESTRATOR=0 turns the whole DBOS orchestration
 * substrate off (orchestrator + autoloop + timers) and brings the legacy paths
 * back. Individual pieces can be disabled with PAPERCUSP_DBOS_AUTOLOOP=0 /
 * PAPERCUSP_DBOS_TIMERS=0 (which re-enables that piece's legacy fallback).
 */
type DbosEnv = Record<string, string | undefined>;

/** The DBOS durable orchestrator is the default (on unless explicitly =0). */
export function dbosOrchestratorActive(env: DbosEnv = process.env): boolean {
  return env.PAPERCUSP_DBOS_ORCHESTRATOR !== '0';
}

/** The DBOS autoloop (per-harness director/coordinator/auditor firing) is on by
 *  default with the orchestrator; disable with PAPERCUSP_DBOS_AUTOLOOP=0. */
export function dbosAutoloopActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_AUTOLOOP !== '0';
}

/** The DBOS periodic timers (telemetry flush, GC, embed backfill, backup cadence,
 *  …) are on by default with the orchestrator; disable with PAPERCUSP_DBOS_TIMERS=0. */
export function dbosTimersActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_TIMERS !== '0';
}

/**
 * The DBOS provision/runner workflow (plan dbos-durable-flows-adoption, P-001/P-002).
 * Now **default-on** (like the orchestrator/autoloop/timers) — disable with
 * PAPERCUSP_DBOS_PROVISION=0. Still gated by the master orchestrator switch
 * (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off). DBOS's deduplicationID is the
 * cross-request mutex and DBOS recovery is the liveness. The hand-rolled
 * operator-claims advisory lock + 30s heartbeat in `provision/runner` were DELETED
 * in P-002 (no shim) once DBOS provisioning was live crash-resume-verified — so
 * this flag now only selects workflow-vs-direct dispatch, NOT a legacy claim path.
 */
export function dbosProvisionActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_PROVISION !== '0';
}

/**
 * The DBOS backup-snapshot durability seam (plan dbos-durable-flows-adoption,
 * P-011 / D-010). A fresh capability, so **opt-in** for now (enable with
 * PAPERCUSP_DBOS_BACKUP=1) — mirroring how provision started before its
 * live-verified flip to default-on (P-002 part 1). Still gated by the master
 * orchestrator switch so the full-legacy revert (PAPERCUSP_DBOS_ORCHESTRATOR=0)
 * also turns it off. When active, the manual `backup:snapshot_create` op routes
 * through the `backupSnapshot` DBOS workflow and the lib's `snapshot()` steps run
 * as durable checkpoints (a crash mid-snapshot resumes from the last step); when
 * off, `snapshot()` is called directly and the injected StepRunner is a no-op
 * pass-through — identical to today.
 */
export function dbosBackupActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_BACKUP === '1';
}

/**
 * The generic DBOS routines engine (git-sync-auto-commit Phase 1 / D-001) — the
 * durable `routinesTick` that drives `harness_shared.routines`, replacing the
 * dormant in-process `routine-ticker` loop. A fresh capability, so **opt-in**
 * (enable with PAPERCUSP_DBOS_ROUTINES=1) until it's live-verified — mirroring how
 * provision + backup started opt-in before their default-on flip. Still gated by
 * the master orchestrator switch (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off).
 * Opt-in is also the safe default: a host restart won't auto-fire stale/unknown
 * routines (e.g. the dormant git-sync routine seeded inactive) unsupervised.
 */
export function dbosRoutinesActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_ROUTINES === '1';
}
