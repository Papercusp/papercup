/**
 * tool-error-classifier.ts — the SINGLE source of truth for how a failed
 * `harness_shared.tool_invocations` row is classified into a `ToolErrorClass`.
 *
 * The classification is consumed in TWO places that used to be "kept in sync"
 * by a comment and DRIFTED in practice
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011):
 *   1. `classifyToolError` — the TS reference fn (the documented oracle).
 *   2. the SQL `CASE` that `watchdog.ts collectToolErrorSignals` runs to
 *      classify rows in-DB at scale.
 *
 * The drift was real: a `handler_error` row whose message starts
 * `"invalid_args: …"` classified `caller` in SQL (`LIKE 'invalid_args:%'`) but
 * `structural` in the TS fn (its error-code branch never checked the message
 * prefix). 100+ high-volume rows/day disagreed between the two.
 *
 * FIX: both the TS fn AND the SQL CASE are now GENERATED from one ordered
 * `TOOL_ERROR_RULES` table — they cannot drift by construction. The fixture
 * regression test (tool-error-classifier.test.ts) locks the live high-volume
 * buckets to their correct class; the integration test
 * (tool-error-classifier.integration.test.ts) runs the GENERATED SQL CASE over
 * the corpus and asserts row-by-row agreement with `classifyToolError`.
 *
 * ── Pattern dual-engine constraint (load-bearing) ─────────────────────────────
 * Every `messagePattern` below is a string that MUST be a valid regular
 * expression in BOTH:
 *   • Postgres `~*` (POSIX ERE, case-insensitive), and
 *   • JS `new RegExp(pattern, 'i')`.
 * The constructs we use — `|`, `?`, `*`, `+`, `^`, `(…)`, `[ _-]`, literal
 * chars — mean the same thing in both engines, so one string drives both. Do
 * NOT use engine-specific syntax (JS `\s`/`\d`/`\b`/lookarounds, or POSIX
 * `[[:alpha:]]` classes) — those would make the two engines disagree, which is
 * the very thing this module exists to prevent. `compileRulePatterns()` (run at
 * module load + asserted in the test) fails fast if a pattern won't compile as
 * a JS RegExp.
 */

/**
 * A failed tool call's class. Each deserves a different FIRE bar + destination:
 *   - structural — a real bug/misconfig (the tool, a missing table, a wiring
 *     gap). Fires on FEW occurrences OR a high error-rate → auto-implement.
 *   - transient  — timeout / load / shared-infra exhaustion. Volume-gated.
 *   - caller     — the caller sent bad input or lacks a role (DX/schema). kind=change.
 *   - rate-limit — an EXTERNAL provider rate-limit / quota (OpenAI embed TPM
 *     429). Capacity, not a code bug → infra/owner, never the auto-implement lane.
 */
export type ToolErrorClass = 'structural' | 'transient' | 'caller' | 'rate-limit';

/** The default class when no rule matches. */
export const DEFAULT_TOOL_ERROR_CLASS: ToolErrorClass = 'structural';

/**
 * One classification rule. A row matches the rule when ANY of its predicate
 * kinds match: `error_code ∈ errorCodes`, `status ∈ statuses`, or the
 * `error_message` matches `messagePattern` (case-insensitive). Rules are
 * evaluated IN ORDER; the first match wins. The table is the single source for
 * both the TS fn and the SQL CASE.
 */
export interface ToolErrorRule {
  /** The class to assign on a match (never `structural` — that is the fallback). */
  readonly class: Exclude<ToolErrorClass, 'structural'>;
  /** Exact `error_code` matches (any). */
  readonly errorCodes?: readonly string[];
  /** Exact `status` matches (any). */
  readonly statuses?: readonly string[];
  /** Dual-engine POSIX-ERE / JS pattern matched against `error_message` (case-insensitive). */
  readonly messagePattern?: string;
  /** One-line human rationale (docs / test legibility). */
  readonly why: string;
}

// ── The shared message patterns (dual-engine; see the module header) ──────────

/** A timeout, including one that surfaced as `handler_error`
 *  ("exceeded timeout … handler returned but signal had aborted"). */
export const TIMEOUT_MESSAGE_PATTERN = 'exceeded timeout|timed? *out';

/** Caller-side arg/scope error in the MESSAGE: an `invalid_args:` prefix
 *  (regardless of the row's error_code — this is the bit the old TS fn missed),
 *  or a missing / unregistered harness. A missing WORKSPACE-scope
 *  ("requires a workspace-scoped call") is deliberately NOT here — a
 *  workspace-scoping gap is treated as `structural` (a wiring gap worth catching
 *  at the low bar), and the fingerprint separates it from anything it used to mask. */
export const CALLER_MESSAGE_PATTERN =
  '^invalid_args:|No harness specified|not registered in (any workspace|harness_shared)';

/** An EXTERNAL provider rate-limit / quota (OpenAI embedding TPM 429,
 *  "Rate limit reached", surfaced as `openai_embed_failed_429`). CAPACITY, not a
 *  code bug — must not fall through to `structural` (P-002). */
export const RATE_LIMIT_MESSAGE_PATTERN =
  'openai_embed_failed_429|rate[ _-]?limit[ _-]?(reached|exceeded)|tokens per min|requests per min|too many requests';

/** Shared-infra exhaustion (PG `max_connections` / DB-unavailable). Recurs
 *  identically in SHAPE across EVERY pg-backed tool during a wedge, but is
 *  transient LOAD, not a per-tool bug — defer to the volume bar so a brief wedge
 *  stops mis-filing structural tool-bug EIs. */
export const INFRA_TRANSIENT_MESSAGE_PATTERN =
  'too many clients already|remaining connection slots are reserved|too many connections|the database system is (starting up|shutting down|in recovery|not yet accepting)|terminating connection due to|ECONNREFUSED|ECONNRESET|connection terminated|could not connect to server';

/**
 * The ordered classification table. ORDER IS SIGNIFICANT — earlier rules win.
 * The precedence mirrors the historical hand-written logic exactly, with the
 * one intended correction that an `invalid_args:`-prefixed message classifies
 * `caller` regardless of its error_code (the drift that motivated P-011).
 */
export const TOOL_ERROR_RULES: readonly ToolErrorRule[] = [
  {
    class: 'transient',
    errorCodes: ['timeout'],
    statuses: ['timeout'],
    messagePattern: TIMEOUT_MESSAGE_PATTERN,
    why: 'a timeout (incl. one surfaced as handler_error) is load, not a tool bug',
  },
  {
    class: 'caller',
    errorCodes: ['invalid_args', 'invalid_input', 'role_not_allowed', 'missing_capability', 'quota_exceeded', 'harness_required'],
    statuses: ['role-not-allowed'],
    messagePattern: CALLER_MESSAGE_PATTERN,
    why: 'the caller sent bad input / lacks a role / named no (or an unregistered) harness — DX, not a tool bug',
  },
  {
    class: 'rate-limit',
    messagePattern: RATE_LIMIT_MESSAGE_PATTERN,
    why: 'an EXTERNAL provider rate-limit / quota (OpenAI embed TPM 429) — capacity, not a code bug',
  },
  {
    class: 'transient',
    messagePattern: INFRA_TRANSIENT_MESSAGE_PATTERN,
    why: 'shared-infra exhaustion (PG max_connections / DB unavailable) — load, not a per-tool bug',
  },
];

/**
 * Tool-error classes that carry an error-shape FINGERPRINT in their dedup key
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012). Originally only
 * `structural` was fingerprinted (P-003); `caller` and `transient` are added so
 * genuinely DIFFERENT same-class modes under one tool stop collapsing onto a
 * single key and masking each other (e.g. `plans:new` rejecting `note too big`
 * vs `status invalid option` vs `paths too small` — distinct DX fixes that used
 * to share one `plans:new:caller` EI). `rate-limit` is deliberately EXCLUDED:
 * every provider-429 under a tool is the SAME capacity concern, so fingerprinting
 * it would FRAGMENT one EI into many — the opposite of dedup.
 *
 * Both the SQL fingerprint CASE (`toolErrorFingerprintSqlCase`) and the TS key
 * builder read this set, so they cannot drift on which classes are fingerprinted.
 */
export const FINGERPRINTED_TOOL_ERROR_CLASSES: ReadonlySet<ToolErrorClass> =
  new Set<ToolErrorClass>(['structural', 'caller', 'transient']);

/** Compile every rule's messagePattern as a JS RegExp once. Throws (at module
 *  load) if a pattern is not a valid JS regex — the cheap half of the
 *  dual-engine guarantee (the SQL `~*` half is proven by the integration test). */
function compileRulePatterns(): { rule: ToolErrorRule; re: RegExp | null }[] {
  return TOOL_ERROR_RULES.map((rule) => ({
    rule,
    re: rule.messagePattern ? new RegExp(rule.messagePattern, 'i') : null,
  }));
}

const COMPILED_RULES = compileRulePatterns();

/**
 * Pure: classify one tool failure by walking `TOOL_ERROR_RULES` in order and
 * returning the first rule whose error_code / status / message matches; falls
 * back to `structural`. This is the TS half of the single source — the SQL CASE
 * (`toolErrorClassSqlCase`) is generated from the same table.
 */
export function classifyToolError(
  errorCode: string | null | undefined,
  status: string | null | undefined,
  errorMessage: string | null | undefined,
): ToolErrorClass {
  const code = errorCode ?? '';
  const st = status ?? '';
  const msg = errorMessage ?? '';
  for (const { rule, re } of COMPILED_RULES) {
    if (code && rule.errorCodes && rule.errorCodes.includes(code)) return rule.class;
    if (st && rule.statuses && rule.statuses.includes(st)) return rule.class;
    if (msg && re && re.test(msg)) return rule.class;
  }
  return DEFAULT_TOOL_ERROR_CLASS;
}

/** A postgres.js tagged-template fn. Typed structurally + generically so this
 *  module needn't import `@papercusp/db-org` (keeps it unit-testable without PG):
 *  the caller passes the real `getOrgPg().sql`, and the value-binding / fragment
 *  composition is what postgres.js already does throughout watchdog.ts.
 *
 *  The values are `any[]` (not `unknown[]`) deliberately: this one type must
 *  accept BOTH the real postgres `Sql` (whose params are the stricter
 *  `Serializable`) AND the test's debug tag — `any` is the bivariant form both
 *  satisfy; `unknown[]` would make the real `Sql` non-assignable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlTag<T> = (strings: TemplateStringsArray, ...values: any[]) => T;

/** OR together one rule's predicates into a single SQL boolean fragment. */
function ruleConditionSql<T>(sql: SqlTag<T>, rule: ToolErrorRule): T {
  const preds: T[] = [];
  if (rule.errorCodes?.length) preds.push(sql`error_code = ANY(${rule.errorCodes as string[]}::text[])`);
  if (rule.statuses?.length) preds.push(sql`status = ANY(${rule.statuses as string[]}::text[])`);
  if (rule.messagePattern) preds.push(sql`error_message ~* ${rule.messagePattern}`);
  if (preds.length === 0) return sql`FALSE`;
  return preds.reduce((a, b) => sql`${a} OR ${b}`);
}

/**
 * Generate the `CASE … END` SQL fragment that classifies a row into a
 * `ToolErrorClass`, from the SAME `TOOL_ERROR_RULES` table the TS fn walks. The
 * fragment references the bare columns `error_code`, `status`, `error_message`,
 * so embed it where those are in scope (the `fail` CTE of
 * `collectToolErrorSignals`). The result is `CASE WHEN … THEN '<class>' … ELSE
 * 'structural' END`.
 */
export function toolErrorClassSqlCase<T>(sql: SqlTag<T>): T {
  let whens = sql``;
  for (const rule of TOOL_ERROR_RULES) {
    whens = sql`${whens} WHEN ${ruleConditionSql(sql, rule)} THEN ${rule.class}`;
  }
  return sql`CASE${whens} ELSE ${DEFAULT_TOOL_ERROR_CLASS} END`;
}

/**
 * Pure: the normalized error-shape FINGERPRINT — the first 6 alpha tokens of the
 * digit-stripped, punctuation-collapsed, lowercased message, joined with `-`.
 * Returns null when the message has no alpha content.
 *
 * MIRROR of `toolErrorFingerprintSqlCase`'s SQL expression — the two MUST agree
 * (proven row-by-row by the integration test). This TS form lets the key-
 * migration routine recompute a fingerprint from an EI's stored sample without
 * a round-trip to PG.
 */
export function toolErrorFingerprint(message: string | null | undefined): string | null {
  const skeleton = (message ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (!skeleton) return null;
  const fp = skeleton.split(' ').filter(Boolean).slice(0, 6).join('-');
  return fp || null;
}

/**
 * Generate the SQL fragment that computes the error-shape fingerprint for the
 * fingerprinted classes (and NULL otherwise). The class membership comes from
 * `FINGERPRINTED_TOOL_ERROR_CLASSES`, so SQL + TS cannot drift on which classes
 * are fingerprinted. The arithmetic mirrors `toolErrorFingerprint` exactly
 * (parity proven by the integration test). References the bare `class` /
 * `error_message` columns, so embed where they are in scope (the `tagged` CTE).
 */
export function toolErrorFingerprintSqlCase<T>(sql: SqlTag<T>): T {
  const classes = [...FINGERPRINTED_TOOL_ERROR_CLASSES];
  return sql`CASE WHEN class = ANY(${classes}::text[]) THEN
    nullif(array_to_string((string_to_array(
      trim(regexp_replace(regexp_replace(lower(coalesce(error_message, '')), '[0-9]+', '', 'g'), '[^a-z]+', ' ', 'g')),
    ' '))[1:6], '-'), '')
  ELSE NULL END`;
}

/** The dedup key for a repeated-tool-error signal: `<tool>:<class>` plus a
 *  `:<fingerprint>` segment for the fingerprinted classes (when a fingerprint
 *  was derivable). Single source for the live collector AND the key-migration
 *  routine, so a migrated key matches what the next tick produces. */
export function toolErrorSignalKey(
  toolName: string,
  klass: ToolErrorClass,
  fingerprint: string | null | undefined,
): string {
  const fp = FINGERPRINTED_TOOL_ERROR_CLASSES.has(klass) && fingerprint ? fingerprint : null;
  return fp ? `${toolName}:${klass}:${fp}` : `${toolName}:${klass}`;
}
