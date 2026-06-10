/**
 * Lifecycle-hook registry for the LIVE DBOS pipeline (audit P-016 / EI-94).
 *
 * History: hook names used to be derived at runtime by grepping
 * `runHook('<name>')` out of the TS orchestrator's `main-loop.ts`. That
 * main-loop was RETIRED (`libs/papercusp/_retired/…`), so the grep always
 * found nothing and every consumer fell back to the `['pre-worker']` floor —
 * the UI advertised a hook that never fires and hid the two that do (EI-94).
 *
 * The DBOS pipeline is the only spawner now and its hook points are code, not
 * config, so this is a static table kept honest by a drift guard:
 * `known-hooks.test.ts` greps the live firing sites under `lib/dbos/` and
 * asserts set equality with the `live` rows. Adding a `runHook(...)` call
 * without a registry row (or vice versa) fails the test.
 *
 * EI-95 (restore the bash-era lifecycle points lost in the DBOS migration)
 * builds on this registry: the lost names are catalogued as `status: 'lost'`
 * so the restoration has one place to flip them live, but `getKnownHooks()`
 * exposes only what actually fires.
 */

export interface KnownHookInfo {
  name: string;
  /** Where the live pipeline fires it — a human-readable code anchor. */
  firesAt: string;
  /**
   * Hook-specific env the script receives, beyond the auto-injected Phase-6
   * context (HARNESS_SLUG / WORKSPACE_ID / OPERATOR_BASE / PROJECT_DIR /
   * STATE_DIR — see orchestrator/src/hooks.ts).
   */
  env: readonly string[];
  /**
   * 'live' = fired by the DBOS pipeline today; 'lost' = a bash-era point the
   * DBOS migration dropped (EI-95 backlog) — not fired, not advertised.
   */
  status: 'live' | 'lost';
}

export const DBOS_PIPELINE_HOOKS: readonly KnownHookInfo[] = [
  {
    name: 'afterDone',
    firesAt: 'lib/dbos/orchestrator-runner.ts (finalize step kind:hook — feature queue drained)',
    env: ['TRIGGER', 'FEATURE_ID', 'PROJECT_DIR', 'STATE_DIR'],
    status: 'live',
  },
  {
    name: 'on-escalate',
    firesAt: 'lib/dbos/orchestrator-runner.ts (finalize step kind:hook — escalation path)',
    env: ['REASON', 'PROJECT_DIR', 'STATE_DIR'],
    status: 'live',
  },
  // ── EI-95 backlog: bash-era lifecycle points lost in the bash→DBOS migration.
  // (Names per orchestrator/src/hooks.ts's contract docstring.)
  { name: 'pre-worker', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'post-worker', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'pre-validator', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'post-validator', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'on-smoke-pass', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'on-smoke-fail', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'on-competition-start', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
  { name: 'on-synthesis-won', firesAt: '(lost in the bash→DBOS migration — EI-95)', env: [], status: 'lost' },
];

/**
 * Hook names the live pipeline actually fires — what the UI lists and the
 * harness hook routes validate against. Sorted for stable rendering.
 */
export function getKnownHooks(): string[] {
  return DBOS_PIPELINE_HOOKS.filter((h) => h.status === 'live')
    .map((h) => h.name)
    .sort();
}
