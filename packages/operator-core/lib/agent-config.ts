/**
 * Agent backend configuration — which CLI (claude-code or omp) the
 * operator + harness drive, plus optional binary/path overrides.
 *
 * Persisted at <papercuspRoot>/agent/config.json so the setting is
 * per-workspace (matches how credentials.json + oracle/* settings are
 * scoped). On read it falls back to env vars; on write it both updates
 * the file AND mirrors into `process.env` so subsequent in-process
 * spawns (Architect chat, delegate-summary, runAgentChat) pick up the
 * change without a server restart.
 *
 * Notes:
 *   - Headless harness runs (`run.sh` invoked from a terminal outside
 *     the operator) DON'T inherit process.env from this server. Those
 *     callers either set $AGENT_BACKEND/$AGENT_CMD themselves or rely
 *     on the auto-inference from the binary name. The settings page
 *     surfaces this caveat to the user.
 *   - Per-role model overrides live alongside in `models` and feed
 *     the orchestrator's existing config.json `models.<role>` lookup
 *     (see invoke.ts — config wins; this file is the user-level
 *     default).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { papercuspPath } from './papercusp-root';
import {
  AGENT_BACKENDS,
  SURFACE_KEYS,
  isValidModelSpec,
  type AgentBackend,
  type ModelTier,
  type SurfaceKey,
} from './agent-config-constants';

// Client-safe constants + types live in `agent-config-constants.ts` (a leaf
// module with no Node/server imports) so the /settings/agent client page can
// import them without dragging this fs/PG module into the renderer. Re-exported
// here for backward compat — existing server callers still `import … from
// './agent-config'`.
export { AGENT_BACKENDS, SURFACE_KEYS };
export type { AgentBackend, ModelTier, SurfaceKey };

export interface AgentConfig {
  /** Which backend to drive. 'auto' lets resolveBackend infer from the
      binary name; explicit values force-select. */
  backend: AgentBackend | 'auto';
  /** Override the agent binary + flags. e.g. 'omp -p' or
      '/usr/local/bin/claude -p --model sonnet' or 'omp -p --model haiku'.
      Empty = use defaults (omp -p). */
  cmd: string;
  /** Per-role model overrides (e.g. `{ worker: 'haiku', reviewer: 'opus' }`).
      Forwarded to the orchestrator via $AGENT_MODELS env (JSON). */
  models: Record<string, string>;
  /** Per-surface backend overrides for the in-app brains. A surface absent
      from the map inherits the global `backend`. Lets you run e.g. oracle on
      claude-code while the operator stays on omp. Resolved per-call via
      `surfaceBackend()` and passed as RunAgentChatOptions.backend — NOT
      mirrored to env (env carries only the single global backend). The
      orchestrator's harness-pipeline agents are configured separately via
      .papercusp/config.json `aiBackend.roles`. Optional: legacy rows/literals
      omit it; `readAgentConfig` always populates it from `parseBackends`. */
  backends?: Partial<Record<SurfaceKey, AgentBackend>>;
  /** Per-surface MODEL overrides — the companion to `backends` (OQ3). A
      surface that runs on a non-default backend needs a model id that
      backend can resolve (the operator brain's default
      `anthropic/claude-opus-4-7` won't resolve on codex). A surface absent
      from the map inherits whatever the surface's own default model logic
      picks. Resolved per-call via `surfaceModel()` and passed as
      RunAgentChatOptions.model. Distinct from `models` above, which is the
      per-ROLE map forwarded to the orchestrator pipeline via env. */
  surfaceModels?: Partial<Record<SurfaceKey, string>>;
  /** User-defined model-tier menu, ordered WEAKEST → STRONGEST (the order is
      the strength ranking the floor/ceiling clamp uses). Empty = the
      committed DEFAULT_MODEL_TIERS (quick/standard/deep/max). The queen's
      fleet:spawn `tier` arg resolves against this menu — see
      fleet/model-tiers.ts (queen-model-tier-selection-2026-06-11). */
  tiers?: ModelTier[];
  /** Per-role tier CEILING (role → tier name): the strongest tier the queen
      may pick for that role. Absent = the strongest tier is allowed. The
      FLOOR is not configured — it derives from the role's resolved default
      model (a tier pick can escalate a role, never downgrade it). */
  tierCeilings?: Record<string, string>;
}

const DEFAULT_CONFIG: AgentConfig = {
  backend: 'omp',
  cmd: '',
  models: {},
  backends: {},
  surfaceModels: {},
  tiers: [],
  tierCeilings: {},
};

export async function readAgentConfig(): Promise<AgentConfig> {
  const raw = await readOperatorState<Partial<AgentConfig>>('operator_agent_config');
  if (!raw) return { ...DEFAULT_CONFIG };
  return {
    backend: validBackend(raw.backend) ?? DEFAULT_CONFIG.backend,
    cmd: typeof raw.cmd === 'string' ? raw.cmd : '',
    models: raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
      ? Object.fromEntries(
          Object.entries(raw.models)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : {},
    backends: parseBackends(raw.backends),
    surfaceModels: parseSurfaceModels(raw.surfaceModels),
    tiers: parseTiers(raw.tiers),
    tierCeilings: parseTierCeilings(raw.tierCeilings, raw.tiers),
  };
}

/** Validate the stored tier menu: an array of { name, spec } with a non-empty
    lowercase-unique name and a syntactically valid model spec. Invalid entries
    are dropped (absence → DEFAULT_MODEL_TIERS at resolution time). */
export function parseTiers(raw: unknown): ModelTier[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelTier[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as ModelTier).name === 'string' ? (entry as ModelTier).name.trim() : '';
    const spec = typeof (entry as ModelTier).spec === 'string' ? (entry as ModelTier).spec.trim() : '';
    const key = name.toLowerCase();
    if (!name || !spec || seen.has(key) || !isValidModelSpec(spec)) continue;
    seen.add(key);
    out.push({ name, spec });
  }
  return out;
}

/** Validate the per-role ceiling map: role → tier name. A ceiling naming a
    tier absent from the stored menu is dropped (when the menu is empty the
    names are checked against nothing — resolution ignores unknown ceilings
    anyway, but dropping here keeps the stored config self-consistent). */
export function parseTierCeilings(raw: unknown, rawTiers?: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const tiers = parseTiers(rawTiers);
  const names = new Set(tiers.map((t) => t.name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [role, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof role !== 'string' || !role.trim() || typeof tier !== 'string' || !tier.trim()) continue;
    if (names.size > 0 && !names.has(tier.trim().toLowerCase())) continue;
    out[role.trim()] = tier.trim();
  }
  return out;
}

/** Validate the per-surface backend map: keep only known surface keys
    mapped to concrete (non-'auto') backends. Unknown keys / invalid
    backends are dropped silently — absence means "inherit the global". */
export function parseBackends(raw: unknown): Partial<Record<SurfaceKey, AgentBackend>> {
  const out: Partial<Record<SurfaceKey, AgentBackend>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((SURFACE_KEYS as readonly string[]).includes(k) && (v === 'omp' || v === 'claude-code' || v === 'codex')) {
      out[k as SurfaceKey] = v;
    }
  }
  return out;
}

/** Validate the per-surface model map (OQ3): known surface keys mapped to
    non-empty string model ids. Unknown keys / non-string values dropped. */
export function parseSurfaceModels(raw: unknown): Partial<Record<SurfaceKey, string>> {
  const out: Partial<Record<SurfaceKey, string>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((SURFACE_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v.trim()) {
      out[k as SurfaceKey] = v.trim();
    }
  }
  return out;
}

export async function writeAgentConfig(cfg: AgentConfig): Promise<AgentConfig> {
  await writeOperatorState('operator_agent_config', cfg);
  applyToProcessEnv(cfg);
  await writeShellEnvFile(cfg).catch(() => { /* best-effort; non-fatal */ });
  return cfg;
}

/**
 * Mirror saved config to a shell-sourceable file at
 * <papercuspRoot>/agent/env.sh. Headless `run.sh` invocations
 * launched from a terminal outside the operator process source this
 * file so the user's /settings/agent toggle reaches the orchestrator
 * without manual export. run.sh's defaults still apply if the file is
 * absent or empty.
 *
 * Generates only `export` lines for set values — empty/auto values are
 * unset to allow run.sh's own fallback chain to kick in.
 */
export async function writeShellEnvFile(cfg: AgentConfig): Promise<string> {
  const path = papercuspPath('agent', 'env.sh');
  const lines: string[] = [
    '# Auto-generated by /settings/agent. Source from run.sh:',
    '#   [ -f "$HOME/.papercusp/agent/env.sh" ] && . "$HOME/.papercusp/agent/env.sh"',
    '# Edits will be overwritten on the next save.',
  ];
  if (cfg.backend !== 'auto') {
    lines.push(`export AGENT_BACKEND=${shQuote(cfg.backend)}`);
  } else {
    lines.push('unset AGENT_BACKEND');
  }
  if (cfg.cmd && cfg.cmd.trim()) {
    lines.push(`export AGENT_CMD=${shQuote(cfg.cmd.trim())}`);
  } else {
    lines.push('unset AGENT_CMD');
  }
  if (Object.keys(cfg.models).length > 0) {
    lines.push(`export AGENT_MODELS=${shQuote(JSON.stringify(cfg.models))}`);
  } else {
    lines.push('unset AGENT_MODELS');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join('\n') + '\n', { mode: 0o644 });
  return path;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mirror saved config into process.env so in-process spawns pick up
 * the change immediately. Called automatically on writeAgentConfig and
 * once at server startup (call applyToProcessEnv(readAgentConfig())
 * from a hot path; we don't have a single startup hook).
 */
export function applyToProcessEnv(cfg: AgentConfig): void {
  if (cfg.backend === 'auto') {
    delete process.env.AGENT_BACKEND;
  } else {
    process.env.AGENT_BACKEND = cfg.backend;
  }
  if (cfg.cmd && cfg.cmd.trim()) {
    process.env.AGENT_CMD = cfg.cmd.trim();
  } else {
    delete process.env.AGENT_CMD;
  }
  if (Object.keys(cfg.models).length > 0) {
    process.env.AGENT_MODELS = JSON.stringify(cfg.models);
  } else {
    delete process.env.AGENT_MODELS;
  }
}

function validBackend(v: unknown): AgentConfig['backend'] | undefined {
  if (v === 'claude-code' || v === 'omp' || v === 'codex' || v === 'auto') return v;
  return undefined;
}

/**
 * Resolve the backend that would actually be driven right now, collapsing
 * `'auto'` to a concrete `'claude-code' | 'omp'` the same way the harness's
 * `resolveAgentBackend` does: explicit config wins; otherwise infer from the
 * binary name in `cmd` / $AGENT_CMD / $CLAUDE_CMD, defaulting to omp.
 *
 * Shared by the /agent-config GET snapshot and the /agent-config/test probe
 * so the "Test current backend" button exercises the same backend the user
 * actually selected.
 */
export function effectiveBackend(cfg: AgentConfig): AgentBackend {
  if (cfg.backend !== 'auto') return cfg.backend;
  const cmd = (cfg.cmd || process.env.AGENT_CMD || process.env.CLAUDE_CMD || 'omp').trim();
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(?:^|\/)claude$/.test(first)) return 'claude-code';
  if (/(?:^|\/)codex$/.test(first)) return 'codex';
  return 'omp';
}

/**
 * The per-surface backend override for an in-app brain, or `undefined` when
 * the surface inherits the global backend. Pass the result straight to
 * `RunAgentChatOptions.backend`: `undefined` lets `runAgentChat` fall back to
 * `$AGENT_BACKEND` (the global pick `applyToProcessEnv` mirrors from config).
 * Best-effort — returns `undefined` on any read error so the call site
 * degrades to the global backend rather than throwing on the hot path.
 */
export async function surfaceBackend(surface: SurfaceKey): Promise<AgentBackend | undefined> {
  try {
    const cfg = await readAgentConfig();
    return cfg.backends?.[surface];
  } catch {
    return undefined;
  }
}

/** Per-surface model override (OQ3 companion to surfaceBackend). Returns
    the configured model id for the surface, or undefined to inherit the
    surface's own default. Pass straight to RunAgentChatOptions.model. */
export async function surfaceModel(surface: SurfaceKey): Promise<string | undefined> {
  try {
    const cfg = await readAgentConfig();
    return cfg.surfaceModels?.[surface];
  } catch {
    return undefined;
  }
}
