/**
 * Build the spawn command + env for a one-shot TS agent invoke via the
 * orchestrator's `invoke-once.ts` bin.
 *
 * This is the replacement for the legacy
 *   `bash -c 'source <(awk ... run.sh); invoke <role> EXTRAS...'`
 * pattern that operator sites used to spawn an agent off run.sh's
 * bash function library: `harness-scoper.ts` (background scoper) and the
 * `/harness/:slug/invoke` route. `invoke-once.ts` reads ROLE / EXTRAS_JSON / RESULT_PATH plus the
 * usual PROJECT_DIR / STATE_DIR / HARNESS_DIR from env, constructs the
 * InvokeContext (with PG bootstrap), and runs the TS `invoke()` exactly
 * once — the same code path the orchestrator main loop drives.
 *
 * Callers own the spawn options (detached vs. synchronous, stdio) and any
 * result-file polling; this just assembles the command + env so the call
 * sites stay in lockstep.
 */
import { invokeOnceBin, tsxBin } from './harness-paths';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';
import type { TurnBackend } from '@papercusp/papercup-shared/agent';

/**
 * Infer the `{ backend, model }` the spawned CLI will actually use for `role` — from the
 * resolved per-role agent command (`AGENT_CMD`/`CLAUDE` + the `AGENT_MODELS` override). Used
 * to key the SHARED RateLimitGovernor to the right `(provider, model-class)` bucket (RB-012)
 * so the pipeline spawn paces against the bucket it really hits: the default `omp -p` is
 * self-pacing (collapses to omp's concurrency-only bucket), `claude …` → the Anthropic
 * per-model-class bucket (opus/sonnet are separate buckets), `codex …` → the OpenAI bucket.
 * Previously the orchestrator hardcoded `('claude-code', '')`, which both mis-attributed the
 * default omp spawns to Anthropic AND collapsed every role into one `anthropic:default`
 * bucket. Exported for unit testing.
 */
export function resolveSpawnBackendModel(role: string): { backend: TurnBackend; model: string } {
  const cmd = applyRoleModel(process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p', role);
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const backend: TurnBackend = /codex/.test(bin) ? 'codex' : /claude/.test(bin) ? 'claude-code' : 'omp';
  const m = /(?:--model(?:=|\s+)|\s-m\s+)(\S+)/.exec(cmd);
  return { backend, model: m?.[1] ?? '' };
}

/** Reasoning-effort levels the `claude --effort` flag accepts. */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Apply a PER-ROLE model (and optional reasoning effort) override to the base agent
 * command. `AGENT_MODELS` is a JSON map `{ <role>: <spec> }` (mirrored from
 * `AgentConfig.models` by `applyToProcessEnv`). Each `<spec>` is either a bare
 * `<modelId>` or `<modelId>:<effort>` where effort ∈ {low,medium,high,xhigh,max}
 * — the `model:effort` form mirrors the repo's existing convention (e.g.
 * `gpt-5.5:xhigh`) and maps to the CLI's `--model` + `--effort` flags. When the
 * spawned role has an entry, we strip any global `--model`/`--effort` and append
 * the role's — so e.g. the worker (or merge-resolver) runs a stronger model at
 * higher effort while the fast reasoning roles stay on the cheap `AGENT_CMD`
 * default.
 *
 * `AGENT_MODELS` OVERRIDES the committed `ROLE_MODEL_DEFAULTS` floor (EI-7): a
 * role with no env entry falls back to its committed default spec (so e.g.
 * `release-manager` runs at `opus:xhigh` even on a host with `AGENT_MODELS`
 * unset, instead of silently downgrading to the CLI default). A role with
 * neither an env entry nor a committed default keeps the base command
 * unchanged. Exported for unit testing.
 */
export function applyRoleModel(baseCmd: string, role: string): string {
  if (!role) return baseCmd;
  const raw = process.env.AGENT_MODELS;
  let models: Record<string, unknown> = {};
  if (raw) {
    try {
      models = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      models = {}; // malformed AGENT_MODELS — fall through to the committed default
    }
  }
  const envSpec = models[role];
  // env wins; otherwise the committed default floor.
  const spec =
    typeof envSpec === 'string' && envSpec.trim() ? envSpec : roleModelDefault(role);
  if (typeof spec !== 'string' || !spec.trim()) return baseCmd;
  // Split a trailing `:<effort>` ONLY when the suffix is a known effort level, so a
  // colon-bearing model id (unusual for claude, but possible elsewhere) stays intact.
  const trimmed = spec.trim();
  const lastColon = trimmed.lastIndexOf(':');
  let model = trimmed;
  let effort: string | undefined;
  if (lastColon > 0 && EFFORT_LEVELS.has(trimmed.slice(lastColon + 1))) {
    model = trimmed.slice(0, lastColon);
    effort = trimmed.slice(lastColon + 1);
  }
  // Strip any existing `--model`/`--effort`, then append the role's.
  let cmd = baseCmd
    .replace(/\s--model(?:=|\s+)\S+/g, '')
    .replace(/\s--effort(?:=|\s+)\S+/g, '')
    .trimEnd();
  cmd = `${cmd} --model ${model}`;
  if (effort) cmd = `${cmd} --effort ${effort}`;
  return cmd;
}

export interface InvokeOnceSpec {
  /** PROJECT_DIR — the user's project root. */
  projectDir: string;
  /** STATE_DIR — usually `<projectDir>/.papercusp`. */
  stateDir: string;
  /** HARNESS_DIR — normally the harness package dir; a caller may
      overlay a per-run prompt-shadow dir here. */
  harnessDir: string;
  /** Role to invoke (scoper, worker, …). */
  role: string;
  /** Positional `K=V` extras (e.g. `MODE=proposal`, `FEATURE_ID=F-1`)
      — passed to invoke-once as EXTRAS_JSON. */
  extras: string[];
  /** When set, invoke-once tees output here and appends the
      `__INVOCATION_DONE__` sentinel on exit (for background pollers). */
  resultPath?: string;
  /** Extra env merged in (role-specific: SCOPER_*, decrypted
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
    // so invoke-route/scoper agents hit the SAME Postgres the operator
    // uses. `??` keeps any explicit override (e.g. tests forcing in-memory).
    PAPERCUSP_USE_PG_STATE: process.env.PAPERCUSP_USE_PG_STATE ?? '1',
    // `||` (not `??`): an EMPTY-string DATABASE_URL must fall through to the
    // resolved admin URL, not mask it — an empty value reaches the agent as
    // `DATABASE_URL=''`, which spawn-mcp reads as "no PG DSN" and refuses to sign
    // the MCP URL (observed breaking a durable-pipeline director invoke).
    DATABASE_URL: process.env.DATABASE_URL || getHarnessAdminUrl(),
    // The orchestrator's pg-bootstrap (which the spawned invoke-once subprocess runs)
    // resolves its DSN from PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json >
    // hardcoded :5432/papercusp — it does NOT read DATABASE_URL. So setting DATABASE_URL
    // alone is NOT enough to make the worker "hit the SAME Postgres the operator uses":
    // when the operator's DB ≠ the :5432/papercusp fallback (e.g. the harness gym's
    // dedicated PG), the worker connects to the wrong DB and `UPDATE harness_features`
    // 42P01s (the gym's per-harness schema is absent there). Mirror the resolved DSN
    // onto PAPERCUSP_DATABASE_URL so the worker's bootstrap tracks the operator's DB.
    // For the live fleet this equals DATABASE_URL (= the live DB the fallback already
    // resolved to), so it's a no-op there; an explicit PAPERCUSP_DATABASE_URL is kept.
    PAPERCUSP_DATABASE_URL:
      process.env.PAPERCUSP_DATABASE_URL || process.env.DATABASE_URL || getHarnessAdminUrl(),
  };
  if (spec.resultPath) env.RESULT_PATH = spec.resultPath;
  for (const [k, v] of Object.entries(spec.extraEnv ?? {})) {
    if (v !== undefined) env[k] = v;
  }
  // Packaged desktop: invoke-once is a self-contained esbuild bundle
  // (invoke-once.mjs) → run with plain `node`, no tsx, no dep tree. Dev: run
  // the `.ts` via `node <tsx-cli> <invoke-once.ts>` (avoids npx's CWD-walk in
  // user project dirs). invokeOnceBin() returns the .mjs when it's bundled.
  const bin = invokeOnceBin();
  const args = bin.endsWith('.mjs') ? [bin] : [tsxBin(), bin];
  return { command: 'node', args, env };
}
