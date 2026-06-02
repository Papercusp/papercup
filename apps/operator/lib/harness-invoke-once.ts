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
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

/**
 * Apply a PER-ROLE model override to the base agent command. `AGENT_MODELS` is a
 * JSON map `{ <role>: <modelId> }` (mirrored from `AgentConfig.models` by
 * `applyToProcessEnv`). When the spawned role has an entry, we strip any global
 * `--model` from the base command and append the role's model — so the worker
 * (the role that writes code) can run a stronger model while the fast reasoning
 * roles (director/debugger/validator/scoper) stay on the cheap `AGENT_CMD`
 * default. A role with no entry, or an unparseable/empty `AGENT_MODELS`, keeps
 * the base command unchanged. Exported for unit testing.
 */
export function applyRoleModel(baseCmd: string, role: string): string {
  const raw = process.env.AGENT_MODELS;
  if (!raw || !role) return baseCmd;
  let models: Record<string, unknown>;
  try {
    models = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return baseCmd;
  }
  const model = models[role];
  if (typeof model !== 'string' || !model.trim()) return baseCmd;
  // Strip any existing `--model <x>` / `--model=<x>`, then append the role model.
  const stripped = baseCmd.replace(/\s--model(?:=|\s+)\S+/g, '').trimEnd();
  return `${stripped} --model ${model.trim()}`;
}

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
  // Per-role model override (AGENT_MODELS): lets the worker run a stronger model
  // than the fast reasoning roles. invoke-once's resolveAgentCmd() reads
  // `AGENT_CMD ?? CLAUDE`, so we MUST override AGENT_CMD (the preferred var) —
  // setting only CLAUDE is masked by the inherited global AGENT_CMD. Set both so
  // whichever resolveAgentCmd reads gets the per-role command.
  const roleAgentCmd = applyRoleModel(process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p', spec.role);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROJECT_DIR: spec.projectDir,
    STATE_DIR: spec.stateDir,
    HARNESS_DIR: spec.harnessDir,
    LOG_DIR: `${spec.stateDir}/logs`,
    ROLE: spec.role,
    EXTRAS_JSON: JSON.stringify(spec.extras),
    AGENT_CMD: roleAgentCmd,
    CLAUDE: roleAgentCmd,
    // Production launchers must enable the PG state path + provide the DSN — the
    // pg-bootstrap otherwise runs with empty in-memory state and the spawned
    // agent's tools (spawn-mcp) fail "no PG DSN in env". Mirrors harness-launch.ts
    // so invoke-route/scoper/expert agents hit the SAME Postgres the operator
    // uses. `??` keeps any explicit override (e.g. tests forcing in-memory).
    PAPERCUSP_USE_PG_STATE: process.env.PAPERCUSP_USE_PG_STATE ?? '1',
    // `||` (not `??`): an EMPTY-string DATABASE_URL must fall through to the
    // resolved admin URL, not mask it — an empty value reaches the agent as
    // `DATABASE_URL=''`, which spawn-mcp reads as "no PG DSN" and refuses to sign
    // the MCP URL (observed breaking a durable-pipeline director invoke).
    DATABASE_URL: process.env.DATABASE_URL || getHarnessAdminUrl(),
  };
  if (spec.resultPath) env.RESULT_PATH = spec.resultPath;
  for (const [k, v] of Object.entries(spec.extraEnv ?? {})) {
    if (v !== undefined) env[k] = v;
  }
  // `node <tsx-cli> <invoke-once.ts>` — same launcher harness-launch.ts
  // uses for the main-loop bin (avoids npx's CWD-walk in user project dirs).
  return { command: 'node', args: [tsxBin(), invokeOnceBin()], env };
}
