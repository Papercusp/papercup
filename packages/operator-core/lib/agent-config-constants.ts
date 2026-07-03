/**
 * Client-safe agent-backend / surface constants + types.
 *
 * Why this file exists: `agent-config.ts` imports `node:fs/promises` and the
 * PG state layer (`operator-state-pg` → `db-encryption` → `postgres`) at module
 * scope. Pulling ANY export from there — even a plain string-tuple const like
 * `SURFACE_KEYS` — drags that whole server subtree into the consumer's chunk.
 * The operator-vite renderer has no Node built-ins, so that leak caused
 * "homedir is not a function" / postgres-in-the-browser crashes.
 *
 * Extracted so client modules (e.g. `app/settings/agent/page.tsx`) can import
 * these constants/types without triggering the cascade. `agent-config.ts`
 * re-exports them for backward compat. Mirrors the `workspace-id-constant.ts`
 * pattern. Keep this module free of any Node/server imports.
 */

/**
 * Canonical subprocess-spawn backend set (operator side). Kept in sync with the
 * orchestrator's `AGENT_BACKENDS` (`@papercusp/orchestrator` types.ts) and the
 * spawn-capable subset of `@papercusp/papercusp-shared` chat-stream's
 * `AgentBackend` (which additionally has `anthropic-direct`, a stateless brains-only
 * HTTP backend — not a subprocess). The submodule boundary rules out a single
 * literal import; `agent-backend-sync.test.ts` guards the three against drift.
 */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/**
 * The in-app brain surfaces that support a per-surface backend override. Keep in
 * sync with the call sites that pass `surfaceBackend('<key>')` and the
 * /settings/agent per-surface table.
 */
export const SURFACE_KEYS = [
  'operator',
  'scanner',
  'delegate',
  'oracle',
  'architect',
  'brainstorm',
  'agent_chats',
  'plans',
] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

// ── Model tiers (queen-model-tier-selection-2026-06-11) ──────────────────────

/** Reasoning-effort levels a model spec's `:<effort>` suffix may carry —
    mirrors the `claude --effort` flag values (same set as
    harness-invoke-once's EFFORT_LEVELS; client-safe copy lives here). */
export const MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORT_LEVELS)[number];

/**
 * One entry in the user-defined model-tier menu. `spec` is the same
 * `<modelId>[:<effort>]` shape `AGENT_MODELS` values take, so it flows through
 * the existing parsers (applyRoleModel / resolveModel) unchanged.
 */
export interface ModelTier {
  /** Tier name the queen picks by — short, lowercase (e.g. 'standard'). */
  name: string;
  /** Model spec this tier resolves to (e.g. 'opus:high'). */
  spec: string;
  /** Backend this tier runs on. Absent = inherit the host's agent command
      (the usual case). When set and different from the host backend, the
      spawn's base command is swapped to this backend's default
      (DEFAULT_BACKEND_CMDS) before the model spec is applied — so a tier can
      be e.g. quick-on-omp while deep stays on claude. */
  backend?: AgentBackend;
  /** USER-AUTHORED guidance: when the queen should pick this tier (one
      line, e.g. 'ambiguous or architectural work; repeat failures'). Injected
      verbatim into the queen's launch prompt as her live tier menu — this is
      the owner's instruction channel for per-tier judgment. */
  when?: string;
  /** Soft compaction limit (tokens) for sessions spawned on this tier — the
      context size at which the agent should reach a clean stopping point and
      self-compact (agent-managed-compaction-2026-07-01). Absent = the
      model-derived default, `defaultCompactionLimitForSpec(spec)`
      (context-trimming-tiers D-001/D-002). That default is also the CEILING:
      agents may overshoot the soft limit by ~20%, so `parseTiers` clamps a
      stored value to keep `limit × 1.2 ≤ window − margin`. */
  compactionLimit?: number;
}

/** Default agent command per backend — used when a per-tier backend swap
    needs a base command for a backend the host's AGENT_CMD doesn't drive.
    Mirrors the /settings/agent placeholders + run.sh defaults. */
export const DEFAULT_BACKEND_CMDS: Record<AgentBackend, string> = {
  'claude-code': 'claude -p',
  omp: 'omp -p',
  codex: 'codex exec',
};

/**
 * The default tier menu when the user hasn't defined one — ordered WEAKEST →
 * STRONGEST (the order IS the strength ranking the floor/ceiling clamp uses).
 * Mirrors the fleet's implicit haiku/sonnet/opus tiering (ROLE_MODEL_DEFAULTS).
 * The `when` lines are the default placement rubric — the user's own menu
 * replaces them wholesale.
 *
 * The sonnet/opus specs carry `[1m]` AT THE SOURCE (owner directive
 * 2026-07-02): every spawn path — psu-normalized or a direct `claude --model
 * <spec>` exec (orchestrator invoke) — then launches the 1M auto-compact
 * window. A BARE `sonnet`/`opus` spec runs a 200k auto-compact window in CC
 * 2.1.198 (live-verified via /context 2026-07-02 — auto-fires ~167k), which is
 * what killed a wave of sonnet fleet members; do not strip the marker.
 */
export const DEFAULT_MODEL_TIERS: readonly ModelTier[] = [
  { name: 'quick', spec: 'haiku', when: 'trivial / mechanical work (renames, single-file fixes, mechanical sweeps)' },
  { name: 'standard', spec: 'sonnet[1m]', when: 'spec-bounded normal features and bugs — the usual pick; omitting tier is equivalent' },
  { name: 'deep', spec: 'opus[1m]:high', when: 'ambiguous or architectural work, cross-cutting changes, repeat failures on a lower tier' },
  { name: 'max', spec: 'opus[1m]:xhigh', when: 'security-sensitive, migration, or deploy-adjacent work where a mistake is expensive' },
] as const;

/** Validate a `<modelId>[:<effort>]` spec string (loose on the model id —
    provider ids vary — strict on the effort suffix). */
export function isValidModelSpec(spec: string): boolean {
  if (!spec || /\s/.test(spec)) return false;
  const lastColon = spec.lastIndexOf(':');
  if (lastColon <= 0) return spec.length > 0;
  const suffix = spec.slice(lastColon + 1);
  // A colon-bearing id whose suffix is NOT an effort level is treated as a
  // plain model id (same rule applyRoleModel uses when splitting).
  return suffix.length > 0 && spec.slice(0, lastColon).length > 0;
}

// ── Compaction limits (context-trimming-tiers-2026-07-01) ────────────────────

/** 1M-window models — a spec carrying the `[1m]` marker. */
export const MODEL_WINDOW_1M = 1_000_000;
/** The conservative default window: any spec WITHOUT the `[1m]` marker —
    haiku, sonnet ≤4.x, unknown/null specs, AND un-normalized default-1M-family
    specs (a bare `sonnet`/`opus` launch really does run a 200k auto-compact
    window in CC — see `isDefault1mModelSpec`). */
export const MODEL_WINDOW_DEFAULT = 200_000;

/**
 * Hard context window for a CC-hosted model spec. The `[1m]` marker on the
 * spec IS the window signal — live-verified via `/context` on CC 2.1.198
 * (2026-07-02): bare `sonnet` reports "Auto-compact window: 200k tokens" and
 * auto-compacts ~167k (killed a wave of sonnet fleet members at preTokens
 * 167-170k), while `sonnet[1m]` reports "Auto-compact window: 967k tokens".
 * So: `[1m]` → 1M; anything else (including an unknown/null spec and a bare
 * default-1M-family name that skipped launch normalization) → the conservative
 * 200k. Fail-safe direction matters: a low limit on a 1M session is just
 * deliberate leanness (agent-managed-compaction D-006); a high limit on a 200k
 * session means papercusp never preempts and CC auto-compacts MID-TASK — the
 * exact 2026-07-02 failure. OMP/local models resolve via their own registry
 * (follow-up, context-trimming D-003).
 */
export function modelWindowForSpec(spec?: string | null): number {
  if (spec == null) return MODEL_WINDOW_DEFAULT;
  return spec.includes('[1m]') ? MODEL_WINDOW_1M : MODEL_WINDOW_DEFAULT;
}

/**
 * Model FAMILIES papercusp launches at the FULL 1M window: `opus`, `fable`
 * (owner directive 2026-07-02), and `sonnet-5` (incl. the bare `sonnet` alias,
 * which CC resolves to the latest sonnet = sonnet-5). This is the FAMILY
 * predicate the launch normalizer keys on — psu-launcher `normalizeModelSpec`
 * injects `[1m]` into these specs at launch — NOT a claim that a bare spec
 * already runs 1M. REVERSAL of the P-031 note (2026-07-02, live-verified via
 * `/context` the same day): a bare `sonnet` session runs a 200k AUTO-COMPACT
 * window in CC 2.1.198; the 967k default in CC's model table sits behind a
 * staged-rollout gate (statsig `tengu_amber_moleskin`, OFF here), so only the
 * `[1m]` marker reliably buys the big window. Window/limit math must therefore
 * key on the marker (`modelWindowForSpec`), never on this family predicate.
 * Sonnet ≤4.x (`claude-sonnet-4-6` etc.) stays outside the family — the regex
 * deliberately does not match `sonnet-4-5`.
 */
export const DEFAULT_1M_FAMILY_RE = /fable|opus|sonnet-?5|^sonnet(\[1m\])?(:[a-z0-9]+)?$/i;

/**
 * Inject the `[1m]` window marker into a default-1M-family spec (idempotent;
 * a no-op outside the families or when the marker is already present). The TS
 * twin of psu-launcher `normalizeModelSpec` — psu covers its own launches;
 * THIS one is applied at the operator exec boundary (`applyRoleModel`) so a
 * direct `claude --model <spec>` spawn (committed role default, AGENT_MODELS,
 * or a per-spawn pin) also gets the 1M auto-compact window. Kept in lockstep
 * via DEFAULT_1M_FAMILY_RE.
 */
export function normalizeModelSpec(spec: string): string {
  if (!spec || /\[1m\]/i.test(spec) || !DEFAULT_1M_FAMILY_RE.test(spec)) return spec;
  const c = spec.lastIndexOf(':');
  const suffix = c > 0 ? spec.slice(c + 1) : '';
  if (c > 0 && /^(low|medium|high|xhigh|max)$/i.test(suffix)) return `${spec.slice(0, c)}[1m]${spec.slice(c)}`;
  return `${spec}[1m]`;
}

export function isDefault1mModelSpec(spec?: string | null): boolean {
  if (spec == null) return false;
  if (/fable|opus|sonnet-?5/i.test(spec)) return true;
  // The bare `sonnet` alias (whole spec, optional [1m] marker / :effort suffix)
  // resolves to the LATEST sonnet in Claude Code — claude-sonnet-5 today
  // (live-verified 2026-07-02: a `--model sonnet:medium` member's transcript
  // reports "model":"claude-sonnet-5"). Versioned sonnet ≤4.x ids don't hit
  // this branch (they carry the version digits and fail the anchor).
  return /^sonnet(\[1m\])?(:[a-z0-9]+)?$/i.test(spec);
}

// ── Cloud model-spec validation (WI-1979 / WI-1993 defense-in-depth) ─────────
//
// The TS TWIN of psu-launcher `validateModelSpec` (+ its KNOWN_CLOUD_ALIASES /
// damerauDistance / nearestCloudAlias helpers). psu-launcher.mjs is exec'd
// DIRECTLY by node (never bundled/tsx-compiled), so it cannot import this TS
// module and vice-versa — the same submodule/build boundary that already forces
// `normalizeModelSpec` / `DEFAULT_1M_FAMILY_RE` to be kept in lockstep by
// convention. This copy exists so the `fleet:launch-on-plan` tool can reject a
// malformed CLOUD spec at the TOOL BOUNDARY (before opening N doomed desktop
// windows that each die at psu boot), instead of only catching it per-member at
// launch. The message text + result shape are kept byte-identical to the
// launcher's so the parity test (apps/operator/lib/psu-launcher.test.ts) can
// assert the two agree across a shared vector table and CATCH DRIFT.

/** The canonical BARE cloud model aliases psu recognizes. Short + lowercase. The
    CLI/gateway own the full OPEN set of ids, so this list is used ONLY to spot an
    obviously-misspelled short alias — never to gate full/provider ids. The TS twin
    of psu-launcher `KNOWN_CLOUD_ALIASES`. */
export const KNOWN_CLOUD_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Damerau optimal-string-alignment distance: Levenshtein PLUS adjacent
    transpositions as a single edit — so a swap typo (`fabel`↔`fable`) is distance 1,
    without widening the substitution radius (`o3`/`gpt4`/`grok` stay far from every
    alias). Tiny; only ever run over the ~4 known aliases. */
function damerauDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
    }
  }
  return d[al][bl];
}

/** Nearest known cloud alias to a (letters-only) token, with its Damerau distance. */
function nearestCloudAlias(letters: string): { alias: string | null; dist: number } {
  const t = String(letters || '').toLowerCase();
  let alias: string | null = null;
  let dist = Infinity;
  for (const a of KNOWN_CLOUD_ALIASES) {
    const dd = damerauDistance(t, a);
    if (dd < dist) {
      dist = dd;
      alias = a;
    }
  }
  return { alias, dist };
}

/** Effort-suffix matcher, built from the single MODEL_EFFORT_LEVELS source so the
    peel + the error message stay identical to psu-launcher's inline `low|…|max`. */
const EFFORT_SUFFIX_RE = new RegExp(`^(${MODEL_EFFORT_LEVELS.join('|')})$`, 'i');

/** Result of {@link validateCloudModelSpec}: ok, plus a corrective `message` on reject. */
export interface CloudModelSpecResult {
  ok: boolean;
  message?: string;
}

/**
 * Validate a hand-typed CLOUD `--model` spec, catching the two malformed-alias
 * classes that otherwise reach the CLI as an unrunnable model and fail the launch
 * with NO useful hint (WI-1979):
 *   (1) a psu-INTERNAL `[1m]` 1M-window marker typed as INPUT on a bare non-family
 *       alias (`fabel5[1m]`) — psu APPENDS `[1m]` (see normalizeModelSpec); it is
 *       never something you type;
 *   (2) a bare short cloud alias that is a CLOSE misspelling of a known one
 *       (`fabel`→fable, `sonet`, `sonnet5`, `opus4`).
 * Deliberately LENIENT — cloud model ids are an OPEN set (the CLI/gateway own the
 * canonical list). It only inspects values that unambiguously look like a bare short
 * alias (pure letters, or letters+digits). A dashed/dotted/slashed/versioned id
 * (`claude-fable-5`, `anthropic.claude-3-5-…`, and legit `[1m]` round-trips like
 * `claude-fable-5[1m]`) is a plausible full id and PASSES UNCHECKED; so does a
 * plausible non-alias short id (`o3`, `gpt4`) that is NOT a close typo of a known
 * alias, and any LOCAL/ollama id (validated separately by fuzzyEnum on the tool arg).
 * The TS twin of psu-launcher `validateModelSpec` — kept byte-identical (parity test).
 */
export function validateCloudModelSpec(spec?: string | null): CloudModelSpecResult {
  if (!spec) return { ok: true };
  const s = String(spec).trim();
  if (!s) return { ok: true };
  if (/^ollama(-cc)?\//i.test(s) || /\bornith\b/i.test(s)) return { ok: true }; // local — not ours to check
  // Peel a recognized :effort tail so we inspect the model BASE (an unrecognized ':x' —
  // bedrock's '…-v2:0' — stays on the base, which then contains ':' → not alias-shaped → passes).
  const c = s.lastIndexOf(':');
  const effort = c > 0 && EFFORT_SUFFIX_RE.test(s.slice(c + 1)) ? s.slice(c + 1) : null;
  const base = effort ? s.slice(0, c) : s;
  // Peel a trailing [..] window marker: 'fable[1m]' → core 'fable', hadMarker true.
  const mk = base.match(/^(.*?)(\[[^\]]*\])$/);
  const core = mk ? mk[1] : base;
  const hadMarker = !!mk;
  const isPure = /^[a-z]+$/i.test(core); // opus, fabel
  const isLettersDigits = /^[a-z]+[0-9]+$/i.test(core); // fabel5, sonnet5, o3
  if (isPure && (KNOWN_CLOUD_ALIASES as readonly string[]).includes(core.toLowerCase())) return { ok: true };
  // A full/provider id (dashes/dots/slashes/version) is NOT alias-shaped → open set, pass —
  // including a legit '[1m]' round-trip on a full id (e.g. 'claude-fable-5[1m]').
  if (!isPure && !isLettersDigits) return { ok: true };
  // Bare short token that is NOT a known alias. Reject only when it is either wearing a [1m]
  // marker (never valid on a non-family bare token) OR a CLOSE typo (Damerau ≤ 1) of a known
  // alias — so genuinely-unknown ids like `o3` / `gpt4` pass untouched.
  const near = nearestCloudAlias(core.replace(/[0-9]+$/, ''));
  const closeTypo = near.alias != null && near.dist <= 1;
  if (!hadMarker && !closeTypo) return { ok: true };
  const suggestion = closeTypo
    ? ` Did you mean \`${effort ? `${near.alias}:${effort}` : `${near.alias}:xhigh`}\`?`
    : '';
  const markerTip = hadMarker
    ? ' The `[1m]` 1M-context marker is appended AUTOMATICALLY by psu — do not type it.'
    : '';
  return {
    ok: false,
    message:
      `\`${s}\` is not a recognized model spec.${suggestion}${markerTip} ` +
      `Cloud models: \`<alias>[:<effort>]\` — aliases ${KNOWN_CLOUD_ALIASES.join('/')}, ` +
      `effort ${MODEL_EFFORT_LEVELS.join('|')} (e.g. \`fable:xhigh\`) — or a full id (e.g. claude-fable-5, anthropic.claude-…).`,
  };
}

/** Output-reservation + startup-attachment headroom subtracted from the hard
    window before deriving the soft limit. */
export const COMPACTION_WINDOW_MARGIN_TOKENS = 10_000;
/** Agents may run ~20% past their SOFT limit before the hard window threatens
    (owner rule, context-trimming-tiers D-001) — the derived default keeps
    `limit × OVERSHOOT ≤ window − margin`. */
export const COMPACTION_OVERSHOOT_FACTOR = 1.2;
/** Floor for any stored/self-set compaction limit (mirrors
    config:set-compaction-limit's arg minimum). */
export const MIN_COMPACTION_LIMIT_TOKENS = 20_000;

/**
 * Preemptive compaction cap for `[1m]`-window sessions: they run on the full
 * 1M window but papercusp compacts them at 500k to bound token spend (owner
 * directive 2026-07-02) — 500k is ample for a leanly-scoped task, and its ×1.2
 * overshoot (600k) stays well under the 1M − margin ceiling.
 */
export const COMPACTION_LIMIT_DEFAULT_1M_CAP = 500_000;

/**
 * The model-derived default soft compaction limit for a spec — and the CEILING
 * a user/agent-set limit is clamped to (context-trimming-tiers D-001):
 * `floor((window − margin) / 1.2)`, floored to 1k for stable display.
 * 200k window → 158,000. EXCEPTION: a `[1m]`-carrying spec is capped at
 * 500,000 (owner directive 2026-07-02) so it compacts preemptively despite the
 * 1M window. Keyed on the `[1m]` MARKER, not the family name: a bare `sonnet`
 * / `opus` launch that skipped normalization really runs a 200k auto-compact
 * window in CC (live-verified 2026-07-02), so its soft limit must be 158k —
 * below CC's own ~167k auto trigger — or papercusp never compacts cleanly and
 * CC compacts mid-task instead.
 */
export function defaultCompactionLimitForSpec(spec?: string | null): number {
  if (spec?.includes('[1m]')) return COMPACTION_LIMIT_DEFAULT_1M_CAP;
  const window = modelWindowForSpec(spec);
  const raw = (window - COMPACTION_WINDOW_MARGIN_TOKENS) / COMPACTION_OVERSHOOT_FACTOR;
  return Math.floor(raw / 1000) * 1000;
}

/** Clamp a requested compaction limit into [MIN, defaultCompactionLimitForSpec(spec)]. */
export function clampCompactionLimit(limit: number, spec?: string | null): number {
  const cap = defaultCompactionLimitForSpec(spec);
  return Math.min(Math.max(Math.floor(limit), MIN_COMPACTION_LIMIT_TOKENS), cap);
}
