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
import { augmentedSpawnPath, resolveBin } from './plugin-spawn-impl';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';
import { DEFAULT_BACKEND_CMDS, type AgentBackend } from './agent-config-constants';
import type { TurnBackend } from '@papercusp/papercusp-shared/agent';

/** Backend a command's binary drives (the same discriminator
    resolveSpawnBackendModel / effectiveBackend use). */
function cmdBackend(cmd: string): AgentBackend {
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (/codex/.test(bin)) return 'codex';
  if (/claude/.test(bin)) return 'claude-code';
  return 'omp';
}

/**
 * Swap the base agent command to `backend`'s default when it differs from the
 * command's own backend (per-tier backend, queen-model-tier-selection). The
 * host command's flags are deliberately NOT carried over — they're
 * binary-specific (a claude flag means nothing to omp); backend-specific
 * flags (stream format, scheduler deny) are appended by the child's invoke
 * path from the resolved backend, not from AGENT_CMD. No-op when the
 * backends already match, so the host's tuned command survives the usual case.
 */
export function applyBackendSwap(baseCmd: string, backend?: string): string {
  if (!backend) return baseCmd;
  const target = backend as AgentBackend;
  if (!DEFAULT_BACKEND_CMDS[target] || cmdBackend(baseCmd) === target) return baseCmd;
  return DEFAULT_BACKEND_CMDS[target];
}

function specModelId(spec?: string): string {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return '';
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return trimmed;
  const suffix = trimmed.slice(lastColon + 1);
  return EFFORT_LEVELS.has(suffix) ? trimmed.slice(0, lastColon) : trimmed;
}

/** Infer a subprocess backend from an explicit per-spawn model spec when the
    spec is unambiguously provider-specific. Keep this intentionally narrow:
    only Codex-shaped specs force a backend swap; Claude/OMP aliases continue to
    inherit the configured command unless the caller supplied
    PAPERCUSP_SPAWN_BACKEND. */
export function inferBackendFromModelSpec(spec?: string): AgentBackend | undefined {
  const id = specModelId(spec).toLowerCase();
  if (!id) return undefined;
  if (id.startsWith('openai-codex/') || id.startsWith('chatgpt:') || /^gpt-\d/.test(id)) return 'codex';
  return undefined;
}

/** Map Papercusp's user-facing Codex aliases to the ids Codex CLI knows. */
export function normalizeCodexCliModel(model: string): string {
  const trimmed = model.trim();
  const chatgpt = /^chatgpt:(.+)$/i.exec(trimmed);
  return chatgpt ? `gpt-${chatgpt[1]}` : trimmed;
}

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
export function resolveSpawnBackendModel(
  role: string,
  overrideSpec?: string,
  overrideBackend?: string,
): { backend: TurnBackend; model: string } {
  const effectiveBackend = overrideBackend || inferBackendFromModelSpec(overrideSpec) || roleBackendOverride(role);
  const base = applyBackendSwap(process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p', effectiveBackend);
  const cmd = applyRoleModel(base, role, overrideSpec);
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const backend: TurnBackend = /codex/.test(bin) ? 'codex' : /claude/.test(bin) ? 'claude-code' : 'omp';
  const m = /(?:--model(?:=|\s+)|\s-m\s+)(\S+)/.exec(cmd);
  return { backend, model: m?.[1] ?? '' };
}

/** Per-role backend override from /settings/agent. Explicit per-spawn backend
    wins before this is consulted; malformed JSON fails open to inherited. */
export function roleBackendOverride(role: string): AgentBackend | undefined {
  if (!role) return undefined;
  const raw = process.env.AGENT_ROLE_BACKENDS;
  if (!raw) return undefined;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const v = map[role];
    return v === 'claude-code' || v === 'omp' || v === 'codex' ? v : undefined;
  } catch {
    return undefined;
  }
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
 *
 * `overrideSpec` is the PER-SPAWN escalation channel
 * (queen-model-tier-selection-2026-06-11 P-001): an explicit spec for THIS one
 * child — fleet:spawn's `model`/`tier` arg, threaded via
 * extraEnv.PAPERCUSP_SPAWN_MODEL — that outranks both the env map and the
 * committed default. Tier-derived overrides are already floor-clamped by
 * resolveTierSpec before they reach here.
 */
export function applyRoleModel(baseCmd: string, role: string, overrideSpec?: string): string {
  if (!role && !overrideSpec?.trim()) return baseCmd;
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
  // per-spawn override wins, then env, then the committed default floor.
  const spec =
    typeof overrideSpec === 'string' && overrideSpec.trim()
      ? overrideSpec
      : typeof envSpec === 'string' && envSpec.trim()
        ? envSpec
        : roleModelDefault(role);
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
  const bin = baseCmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const isCodex = /(?:^|\/)codex$/.test(bin);
  const codexEffort = effort === 'max' ? 'xhigh' : effort;
  // Strip any existing model/effort flags, then append the role's. Codex does
  // not have a `--effort` flag; its reasoning effort is a config override.
  let cmd = baseCmd
    .replace(/\s--model(?:=|\s+)\S+/g, '')
    .replace(/\s-m\s+\S+/g, '')
    .replace(/\s--effort(?:=|\s+)\S+/g, '')
    .replace(/\s-c\s+model_reasoning_effort=(?:"[^"]*"|'[^']*'|\S+)/g, '')
    .trimEnd();
  const cliModel = isCodex ? normalizeCodexCliModel(model) : model;
  cmd = `${cmd} --model ${cliModel}`;
  if (effort) {
    cmd = isCodex
      ? `${cmd} -c model_reasoning_effort="${codexEffort}"`
      : `${cmd} --effort ${effort}`;
  }
  return cmd;
}

/**
 * Append a forced native session id to the agent command so a headless bee run
 * is resumable by EXACT uuid — `claude --resume <uuid>` — for the hive-tabs bee
 * attach (hive-agent-tabs-psu-tui-2026-06-09 P-016 / D-007). Only `claude`
 * accepts `--session-id`; omp resumes by thread id and codex by rollout, so for
 * those the command is returned UNCHANGED (the caller records the backend-native
 * handle instead). Idempotent — never double-appends if a `--session-id` is
 * already present. Exported for unit testing.
 */
export function appendForcedSessionId(cmd: string, sessionId: string): string {
  const bin = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/claude/.test(bin)) return cmd; // omp/codex: not claude-resumable this way
  if (/--session-id(?:=|\s)/.test(cmd)) return cmd; // already forced
  return `${cmd.trimEnd()} --session-id ${sessionId}`;
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
  /** P-016/D-007: force this native session uuid so the run is resumable by exact
      id (`claude --resume <uuid>`). Applied only when the resolved backend is
      claude (see appendForcedSessionId); the caller records it for the bee attach. */
  forceSessionId?: string;
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
  // PAPERCUSP_SPAWN_MODEL (in extraEnv) is the per-spawn escalation: an explicit
  // spec for THIS child that outranks the env map + committed default — set by
  // spawnAgentInHarness from fleet:spawn's model/tier arg (P-001). It also rides
  // the child's env, where invoke.ts resolveModel consults it first (covers the
  // config.aiBackend agentCmd-swap path this command-level append can't reach).
  // PAPERCUSP_SPAWN_BACKEND (per-tier backend) swaps the base command to that
  // backend's default before the model is applied — and must ALSO override the
  // inherited AGENT_BACKEND below: the child's resolveAgentBackend prefers the
  // explicit env over binary inference, so a swapped command with a stale
  // AGENT_BACKEND would mis-resolve every backend-keyed flag.
  const spawnBackend =
    spec.extraEnv?.PAPERCUSP_SPAWN_BACKEND ||
    inferBackendFromModelSpec(spec.extraEnv?.PAPERCUSP_SPAWN_MODEL) ||
    roleBackendOverride(spec.role);
  const roleAgentCmd = applyRoleModel(
    applyBackendSwap(process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p', spawnBackend),
    spec.role,
    spec.extraEnv?.PAPERCUSP_SPAWN_MODEL,
  );
  // P-016/D-007: when the spawn forces a native session id, bake `--session-id`
  // into the (claude) agent command so the headless bee run is resumable by exact
  // uuid for the hive-tabs bee attach. No-op for omp/codex (appendForcedSessionId).
  const agentCmd = spec.forceSessionId
    ? appendForcedSessionId(roleAgentCmd, spec.forceSessionId)
    : roleAgentCmd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROJECT_DIR: spec.projectDir,
    STATE_DIR: spec.stateDir,
    HARNESS_DIR: spec.harnessDir,
    LOG_DIR: `${spec.stateDir}/logs`,
    ROLE: spec.role,
    EXTRAS_JSON: JSON.stringify(spec.extras),
    AGENT_CMD: agentCmd,
    CLAUDE: agentCmd,
    // Per-tier backend swap: pin the child's explicit backend to the swapped
    // one (resolveAgentBackend prefers AGENT_BACKEND over binary inference).
    ...(spawnBackend && DEFAULT_BACKEND_CMDS[spawnBackend as AgentBackend]
      ? { AGENT_BACKEND: spawnBackend }
      : {}),
    ...(spawnBackend && DEFAULT_BACKEND_CMDS[spawnBackend as AgentBackend]
      ? { PAPERCUSP_SPAWN_BACKEND: spawnBackend }
      : {}),
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
  // Resolve `node` to an ABSOLUTE path (and pin an augmented PATH onto the child
  // env) instead of spawning the bare `'node'` basename. The operator sidecar is
  // launched (Tauri bg-host / systemd dev unit) with a minimal PATH that often
  // OMITS the dir where `node` lives, so `spawn('node')` throws ENOENT and wedges
  // every invoke-driven routine — git-sync + deploys froze ~10h on 2026-06-20
  // from exactly this (a restart does NOT fix it; the PATH gap recurs).
  //
  // We deliberately do NOT spawn `process.execPath` directly: on the node bg-host
  // it equals node, but the operator also runs INSIDE the packaged desktop (the
  // Tauri embedder boots `node serve.mjs`, and that operator spawns harness
  // invokes too) where execPath can be a non-node wrapper binary — spawning it
  // would mis-launch. resolveBin keeps the command a real `node` in EVERY runtime
  // (bg-host, dev, packaged), falling back to bare `node` only when none is found
  // (a clear ENOENT, not a silent mis-spawn). augmentedSpawnPath = the running
  // runtime's own dir + well-known node locations; pinning it onto env.PATH also
  // protects the child's own downstream basename spawns. Same helpers + discipline
  // as plugin-spawn-impl.ts, the codebase's fix for this exact ENOENT class.
  const spawnPath = augmentedSpawnPath();
  env.PATH = spawnPath;
  return { command: resolveBin('node', spawnPath), args, env };
}
