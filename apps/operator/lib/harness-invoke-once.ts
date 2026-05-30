/**
 * Build the spawn command + env for a one-shot TS agent invoke via the
 * orchestrator's `invoke-once.ts` bin.
 *
 * This is the replacement for the legacy
 *   `bash -c 'source <(awk ... run.sh); invoke <role> EXTRAS...'`
 * pattern that three operator sites used to spawn an agent off run.sh's
 * bash function library: `harness-scoper.ts` (background scoper),
 * `expert-dispatcher.ts` (expert roles), and the `/harness/:slug/invoke`
 * route. `invoke-once.ts` reads ROLE / EXTRAS_JSON / RESULT_PATH plus the
 * usual PROJECT_DIR / STATE_DIR / HARNESS_DIR from env, constructs the
 * InvokeContext (with PG bootstrap), and runs the TS `invoke()` exactly
 * once — the same code path the orchestrator main loop drives.
 *
 * Callers own the spawn options (detached vs. synchronous, stdio) and any
 * result-file polling; this just assembles the command + env so the three
 * sites stay in lockstep.
 */
import { invokeOnceBin, tsxBin } from '@/lib/harness-paths';

export interface InvokeOnceSpec {
  /** PROJECT_DIR — the user's project root. */
  projectDir: string;
  /** STATE_DIR — usually `<projectDir>/.harness`. */
  stateDir: string;
  /** HARNESS_DIR — normally the harness package dir, but the expert
      dispatcher overlays a per-run prompt-shadow dir here. */
  harnessDir: string;
  /** Role to invoke (scoper, worker, an expert role name, …). */
  role: string;
  /** Positional `K=V` extras (e.g. `MODE=proposal`, `FEATURE_ID=F-1`,
      `EXPERT_ID=…`) — passed to invoke-once as EXTRAS_JSON. */
  extras: string[];
  /** When set, invoke-once tees output here and appends the
      `__INVOCATION_DONE__` sentinel on exit (for background pollers). */
  resultPath?: string;
  /** Extra env merged in (role-specific: SCOPER_*, EXPERT_*, decrypted
      search-provider keys). `undefined` values are skipped. */
  extraEnv?: Record<string, string | undefined>;
}

export function buildInvokeOnce(spec: InvokeOnceSpec): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROJECT_DIR: spec.projectDir,
    STATE_DIR: spec.stateDir,
    HARNESS_DIR: spec.harnessDir,
    LOG_DIR: `${spec.stateDir}/logs`,
    ROLE: spec.role,
    EXTRAS_JSON: JSON.stringify(spec.extras),
    // invoke-once → env.ts resolveAgentCmd() reads AGENT_CMD ?? CLAUDE.
    CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
  };
  if (spec.resultPath) env.RESULT_PATH = spec.resultPath;
  for (const [k, v] of Object.entries(spec.extraEnv ?? {})) {
    if (v !== undefined) env[k] = v;
  }
  // `node <tsx-cli> <invoke-once.ts>` — same launcher harness-launch.ts
  // uses for the main-loop bin (avoids npx's CWD-walk in user project dirs).
  return { command: 'node', args: [tsxBin(), invokeOnceBin()], env };
}
