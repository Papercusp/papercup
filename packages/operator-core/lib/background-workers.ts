/**
 * background-workers.ts — the ONE evaluation of the EI-126 rule: should THIS
 * process run shared-DB background machinery (federation drains, DBOS
 * workflows, boot-time hive watchdog / wake-rule registration)?
 *
 * Two hosts running it against one papercusp DB caused the 2026-06-08 DBOS
 * appVersion war (EI-126); module-scope boot effects bypassing the rule let
 * every vitest WORKER run a "host boot" hive-watchdog check against the live
 * DB — 11 staged watchdog wakes per test run (EI-312 leg 1).
 *
 * Rule: explicit PAPERCUSP_BACKGROUND_WORKERS wins when set; otherwise default
 * ON everywhere EXCEPT the dev-box staging operator (PAPERCUSP_HONO_PORT=3170,
 * request-only by design) — and NEVER under vitest (tests must not poke the
 * live wake system, whatever the box's env says).
 */
export function backgroundWorkersEnabled(): boolean {
  if (process.env.VITEST) return false;
  return process.env.PAPERCUSP_BACKGROUND_WORKERS != null
    ? process.env.PAPERCUSP_BACKGROUND_WORKERS !== '0'
    : process.env.PAPERCUSP_HONO_PORT !== '3170';
}
