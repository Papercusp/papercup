/**
 * P-022 / D-020 AUTOLOOP RUNNER CLI — a thin wrapper over `runOneAutoloopCycle`
 * (autoloop-cycle.ts), which now owns the whole runnable: boot a dedicated
 * headless gym-operator on a fresh gym DB, run the budget-capped human-gated
 * optimization loop (autoPromote:false), record proposals to the control plane,
 * tear down. The factoring (learning-system-audit P-031) lets the
 * `system:gym-cycle` routine action call the SAME machinery in-process; this CLI
 * remains the manual entry point.
 *
 * Two modes (env GYM_LOOP_FAKE):
 *   GYM_LOOP_FAKE=1 → fake agent + fake judge + fake proposer →
 *                     validates the WHOLE loop assembly end-to-end with ZERO LLM spend.
 *   default (real)  → real AGENT_CMD pipeline + real opus-4-8 judge + real proposer. Bounded
 *                     (D-019): GYM_LOOP_MAX_CYCLES (default 1) × a hard GYM_LOOP_BUDGET_USD.
 *
 *   cd apps/operator && set -a; . ./.env.local; set +a; \
 *     GYM_LOOP_FAKE=1 npx tsx lib/gym/gym-loop-run.ts             # zero-LLM assembly check
 *     GYM_LOOP_MAX_CYCLES=1 npx tsx lib/gym/gym-loop-run.ts        # real run (on capacity)
 *
 * Env knobs (all read inside runOneAutoloopCycle): GYM_LOOP_PORT, GYM_LOOP_WORKSPACE,
 * GYM_LOOP_HARNESS, GYM_LOOP_MAX_CYCLES, GYM_LOOP_REPEATS, GYM_LOOP_BUDGET_USD,
 * GYM_LOOP_AGENT_CMD, GYM_LOOP_PROPOSER_MODEL, GYM_LOOP_NOVELTY_WEIGHT,
 * GYM_LOOP_CONTROL_DSN (control plane → the LIVE operator DB; else the gym DB).
 */

// The gym judge + agents use the CODE backend (the `claude` CLI), not meridian — it paces
// against the subscription session rather than hammering api.anthropic.com (what tripped the
// rate limit). Set before llm-client loads (TEST_BACKEND read at module init). Overridable.
process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

import { runOneAutoloopCycle, maskDsn } from './autoloop-cycle';

const SLUG = process.env.GYM_LOOP_HARNESS ?? 'gymloopharness';

async function main(): Promise<void> {
  // CLI semantics preserved: env-driven options + the autoloop-row writes
  // (enabled:true + budget + running → idle/paused + spent) around the run.
  const { ok, report } = await runOneAutoloopCycle(SLUG, { manageAutoloopRow: true });

  process.stdout.write('\n===== GYM LOOP (P-022 / D-020) REPORT =====\n' + maskDsn(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nGYM-LOOP: OK\n' : '\nGYM-LOOP: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
