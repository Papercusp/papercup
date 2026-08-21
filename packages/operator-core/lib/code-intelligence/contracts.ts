/**
 * Code-intelligence acceptance contracts (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-002).
 *
 * This module is the FROZEN half of the acceptance corpus: the result schema
 * every backend is normalized into, the freshness/health truth contract, the
 * resource budgets, and the read-only/lock invariants. The cases themselves
 * live in `./acceptance-corpus.ts`.
 *
 * Why a normalization layer exists at all — this is measured, not assumed:
 * backends disagree about what a "line" is. GitNexus 1.6.9 emits ZERO-indexed
 * lines (verified 2026-08-21 against three independent symbols; see
 * LINE_INDEX_BASE below), the LSP wire protocol is likewise zero-indexed by
 * spec, and grep/sed/editors are one-indexed. An agent that copies a raw line
 * number from one backend into a citation is silently off by one. Every answer
 * therefore enters the corpus through `toOneIndexed()`, and `SymbolSite.line1`
 * is one-indexed BY CONSTRUCTION so the type name itself carries the contract.
 */

/** Backends that can answer a code-intelligence question in this repo. */
export type CodeIntelBackend =
  | 'gitnexus'
  | 'lsp-adapter'
  | 'mcp-language-server'
  | 'omp-lsp'
  | 'ripgrep'
  | 'repomix'
  | 'code2prompt';

/**
 * Line-index base per backend, MEASURED not assumed.
 *
 * gitnexus: verified 2026-08-21 at gitnexus@1.6.9 against three independent
 * symbols, each reported exactly one BELOW its true one-indexed declaration
 * line:
 *   - `managedSetInterval` libs/generic/scheduled-registry/src/index.ts → 285 (true 286)
 *   - `pinModuleState`     libs/generic/module-singleton/src/index.ts   → 105 (true 106)
 *   - a `vi.mock` factory property in predicate-watch.integration.test.ts   → 39  (true 40)
 * lsp-*: zero-indexed by the Language Server Protocol specification
 * (`Position.line` is "line position in a document (zero-based)").
 * ripgrep/grep: one-indexed by POSIX convention.
 */
export const LINE_INDEX_BASE: Readonly<Record<CodeIntelBackend, 0 | 1>> = Object.freeze({
  gitnexus: 0,
  'lsp-adapter': 0,
  'mcp-language-server': 0,
  'omp-lsp': 0,
  ripgrep: 1,
  repomix: 1,
  code2prompt: 1,
});

/**
 * Normalize a backend-reported line to the one-indexed convention every human
 * tool in this repo uses. Pass the RAW number exactly as the backend returned
 * it. Returns null for a missing line so a caller cannot silently turn an
 * absent line into line 1 (GitNexus's `status:"found"` shape omits `line`
 * entirely — see CORPUS case `schema-found-shape-carries-line`).
 */
export function toOneIndexed(
  backend: CodeIntelBackend,
  rawLine: number | null | undefined,
): number | null {
  if (rawLine === null || rawLine === undefined) return null;
  if (!Number.isFinite(rawLine)) return null;
  const base = LINE_INDEX_BASE[backend];
  const oneIndexed = base === 0 ? rawLine + 1 : rawLine;
  // A backend that reports a negative or zero line after normalization is
  // reporting garbage; surface it as absent rather than as a real location.
  return oneIndexed >= 1 ? oneIndexed : null;
}

/** One resolved location for a symbol, always one-indexed. */
export interface SymbolSite {
  /** Repo-relative path, POSIX separators. */
  readonly path: string;
  /** ONE-indexed line. Null when the backend did not report one. */
  readonly line1: number | null;
  /** Backend-reported symbol kind, lowercased ('function', 'class', ...). */
  readonly kind: string | null;
  /**
   * Optional human-readable detail for sites that carry one: a diagnostic's
   * message, a workspace-symbol's container, a rename edit's replacement text.
   *
   * OPTIONAL by construction — the frozen corpus (P-002) constructs sites
   * without it and must keep typechecking, and a required field here would
   * strand every existing call site. Absence means "this backend/intent has no
   * detail to give", never "the detail was empty".
   */
  readonly detail?: string | null;
}

/** Whether a result set is complete or was cut off, stated EXPLICITLY. */
export interface Truncation {
  /** True when the backend cut the result set. Never infer this from length. */
  readonly truncated: boolean;
  /** Total matches the backend claims exist, when it says. */
  readonly totalAvailable: number | null;
  /** Opaque continuation token, when the backend supports pagination. */
  readonly continuation: string | null;
}

/**
 * Freshness/health truth contract.
 *
 * The load-bearing rule (plan corpus case 8): a backend that is unhealthy MUST
 * say so. A confident empty list from a crashed or stale backend is the single
 * most dangerous failure mode in the whole routing design, because it is
 * indistinguishable from a true "no references" answer and it reads as proof
 * of absence. `health` is therefore REQUIRED on every answer and
 * `'unknown'` is a legitimate, branchable value — never coerce it to healthy.
 */
export type BackendHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface Freshness {
  readonly health: BackendHealth;
  /** When the backend's index/state was last updated, ISO-8601, or null. */
  readonly indexedAt: string | null;
  /**
   * True when the backend has observed on-disk edits not yet in its index.
   * Null when the backend cannot tell — which is itself a corpus failure for
   * any backend claiming a bounded freshness window (corpus case 6).
   */
  readonly staleVsDisk: boolean | null;
  /** Commit the index was built against, when the backend records one. */
  readonly indexedCommit: string | null;
}

/** The normalized answer shape every backend is scored against. */
export interface CodeIntelAnswer {
  readonly backend: CodeIntelBackend;
  readonly intent: CodeIntelIntent;
  readonly query: string;
  readonly sites: readonly SymbolSite[];
  readonly truncation: Truncation;
  readonly freshness: Freshness;
  /** Wall-clock milliseconds for this single call. */
  readonly latencyMs: number;
  /**
   * Set when the backend failed. A failed answer with `sites: []` MUST carry
   * this — that is what separates "it broke" from "there are none".
   */
  readonly error: string | null;
}

/** The question kinds the routing table dispatches on. */
export type CodeIntelIntent =
  | 'definition'
  | 'references'
  | 'implementations'
  | 'callers'
  | 'callees'
  | 'impact'
  | 'rename-preview'
  | 'diagnostics'
  /**
   * Find a symbol by NAME across the workspace (LSP `workspace/symbol`).
   * Distinct from 'text-search': the backend matches declared symbols, not
   * arbitrary text, so a comment mentioning the name is not a hit.
   */
  | 'symbol-search'
  | 'structural-search'
  | 'text-search'
  | 'pack';

/**
 * An answer is ACCEPTABLE only if a false-empty is impossible to confuse with
 * a true-empty. This is the predicate the corpus runner applies before it
 * scores correctness at all.
 */
export function isTrustworthyEmpty(answer: CodeIntelAnswer): boolean {
  if (answer.sites.length > 0) return true;
  if (answer.error !== null) return true; // loud failure — honest
  // An empty answer is only trustworthy from a backend that affirmatively
  // claims health. 'unknown' and 'degraded' empties are NOT evidence of
  // absence.
  return answer.freshness.health === 'healthy';
}

/**
 * Resource budgets, per backend process, under fleet load.
 *
 * These are CEILINGS for production selection, not measured values — the
 * measured baseline is recorded by the corpus runner. A backend that cannot be
 * bounded to these fails selection (plan: "cannot bound memory/process
 * multiplication under fleet load").
 */
export interface ResourceBudget {
  readonly coldStartMsMax: number;
  readonly warmQueryMsMax: number;
  readonly rssMbMax: number;
  /** Max long-lived child processes per workspace. */
  readonly childProcMax: number;
  readonly indexDiskMbMax: number;
  /** Max tokens a single tool result may put into an agent's context. */
  readonly resultTokensMax: number;
}

export const DEFAULT_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({
  coldStartMsMax: 10_000,
  warmQueryMsMax: 1_500,
  rssMbMax: 1_024,
  childProcMax: 1,
  indexDiskMbMax: 2_048,
  resultTokensMax: 1_500,
});

/**
 * Read-only / lock invariants (plan corpus cases 10 and 13).
 *
 * The code-intelligence layer is a READ plane. Any backend exposing a tool
 * that mutates the tree bypasses the `PreToolUse` lock arbitration that keeps
 * this shared checkout collision-free, so mutation must be absent rather than
 * merely unused.
 */
export const FORBIDDEN_MUTATING_TOOL_PATTERNS: readonly RegExp[] = Object.freeze([
  // `rename` ALONE is not enough: a real backend names it `rename_symbol`,
  // which /^rename$/ waved straight through. Prefix-anchored, so an unrelated
  // op like `refactor_preview` is untouched.
  /^rename/i,
  // `edit` as a leading or trailing word-part. Together these subsume the
  // former /^apply[_-]?edit$/ and /^workspace[_-]?edit$/ while also catching
  // `edit_file` (snake, leading) and `applyEdit` (camel, trailing) — the two
  // spellings a single exact-anchored pattern cannot both cover.
  /(^|[_-])edit/i,
  /edit$/i,
  /write/i,
  /delete/i,
  /^format/i,
  /^fix/i,
]);

/**
 * Tools that are allowed to CARRY a mutating name because they only ever
 * return a preview. Keep this list tiny and justified; each entry is a
 * promise the corpus verifies by asserting the tree is byte-identical after
 * the call (corpus case `read-only-no-mutation`).
 */
export const PREVIEW_ONLY_ALLOWLIST: readonly string[] = Object.freeze([
  // GitNexus `rename` returns a rename PLAN (affected sites) and never writes.
  // Verified by the no-mutation corpus case, not by its name.
  'rename',
]);

export function isMutatingToolName(name: string): boolean {
  if (PREVIEW_ONLY_ALLOWLIST.includes(name)) return false;
  return FORBIDDEN_MUTATING_TOOL_PATTERNS.some((re) => re.test(name));
}
