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
