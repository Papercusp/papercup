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
export function backgroundWorkersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST) return false;
  return env.PAPERCUSP_BACKGROUND_WORKERS != null
    ? env.PAPERCUSP_BACKGROUND_WORKERS !== '0'
    : env.PAPERCUSP_HONO_PORT !== '3170';
}

/**
 * Headless UTILITY host (PAPERCUSP_UTILITY_HOST=1) — a short-lived dedicated
 * operator instance (the gym-operator, future eval/bench hosts) that needs the
 * request surface + DBOS pipelines but none of the interactive/dogfood legs.
 *
 * backgroundWorkersEnabled() can't express this: it bundles the DBOS launch
 * with the shared-DB drains, and the gym needs DBOS ON. This flag instead
 * gates the boot legs that are irrelevant to a utility instance AND carry the
 * process's heavy native-module surface (EI-368 — the gym-operator
 * intermittently died with a bare `terminate called after throwing an
 * instance of 'Napi::Error'` mid-boot; the suspect natives all live behind
 * these legs):
 *  - the hyperbee/holepunch dogfood substrate (sodium/udx/rocksdb natives)
 *  - the voice cluster (mobile/desktop WS, local audio socket, relay — more
 *    holepunch natives + port scanning)
 *  - the boot-time embedder warm-up (onnxruntime)
 *
 * Independent of backgroundWorkers: a utility host usually keeps
 * backgroundWorkers ON for its own dedicated DB (DBOS pipelines); the gated
 * legs check BOTH.
 */
export function utilityHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_UTILITY_HOST === '1';
}

/**
 * Whether THIS process should arm the in-process REACTION MATCHER — project the
 * persisted hive-wake subscriptions into the in-memory reaction registry so a tool
 * invoked HERE fires its demand-wake reaction in-process (EI-307).
 *
 * This is REQUEST-SERVING work, NOT a background loop: no tick, no drain, no
 * resource cost beyond one PG read at boot, and it must be live on EVERY operator
 * host that serves tool calls — INCLUDING the dev-box staging operator
 * (PAPERCUSP_HONO_PORT=3170). `backgroundWorkersEnabled()` deliberately turns the
 * loops OFF on :3170 (request-only by design); bundling the matcher projection into
 * that gate is exactly the EI-307 bug — a `work_items:create` landing on :3170
 * matched no rule (staging's matcher was never armed) so the hive demand-wake
 * silently dropped. The matcher therefore arms wherever requests are served:
 * everywhere except tests (a vitest worker must not poke the live wake system) and
 * an explicit full-disable (PAPERCUSP_BACKGROUND_WORKERS=0).
 */
export function reactionMatcherShouldArm(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST) return false;
  if (env.PAPERCUSP_BACKGROUND_WORKERS === '0') return false;
  return true;
}

/**
 * Whether THIS process actually LAUNCHES DBOS: a background-workers host with DBOS
 * enabled — mirroring host-bootstrap's launch gate (`backgroundWorkers &&
 * PAPERCUSP_DBOS_ENABLE === '1'`). Request-only hosts set PAPERCUSP_BACKGROUND_WORKERS=0
 * (or run on the :3170 staging port) and delegate DBOS to the dedicated bg-host, so
 * their local `dbosStarted()` is false BY DESIGN.
 *
 * Unlike backgroundWorkersEnabled()/reactionMatcherShouldArm(), this is a PURE
 * predicate gating no machinery — so it deliberately has NO vitest short-circuit, and
 * readiness handlers (/api/health/ready, /api/health/deep) that call it argless under
 * test compute the real env-derived value. The bug it fixes: those handlers gated
 * readiness on the bare PAPERCUSP_DBOS_ENABLE env flag (which is set in the shared
 * .env.local that EVERY host sources), so a request-only host — which never launches
 * DBOS — reported `ready:false`/503 forever even while perfectly able to serve.
 */
export function dbosLaunchesHere(env: NodeJS.ProcessEnv = process.env): boolean {
  const backgroundHost =
    env.PAPERCUSP_BACKGROUND_WORKERS != null
      ? env.PAPERCUSP_BACKGROUND_WORKERS !== '0'
      : env.PAPERCUSP_HONO_PORT !== '3170';
  return backgroundHost && env.PAPERCUSP_DBOS_ENABLE === '1';
}
