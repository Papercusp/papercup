/**
 * Deterministic `for_each` resolvers for generative promote waves (P-043 / D-012a).
 *
 * A generative wave's item-set is resolved by RUNNING A QUERY — NOT an LLM
 * generator (there never was one to keep — `buildWaveFeatures` is pure `{item}`
 * substitution and the set was hand-passed by the promote agent). The
 * promote-time resolvers expand up front because their set exists now:
 *   - `items`: an inline, explicit set
 *   - `glob` : repo files matching a glob (e.g. `app/api/​**​/route.ts`)
 *   - `sql`  : the first column of each row from the harness PG (e.g. VAL-* with
 *              no covering test)
 *
 * Guardrails (D-012a): a resolver yielding MORE than the fan-out cap throws
 * `ForEachFanoutError` (escalate — raise the cap or narrow the query, never
 * silently truncate); a resolver that throws is wrapped in `ForEachResolverError`
 * (escalate — never silently yield zero children).
 *
 * Pure + injected (`runGlob` / `runSql`) so the promote tool stays unit-testable.
 *
 * NOT YET (surfaced follow-up): the grep/AST resolver; the COMPLETION-TIME
 * resolver (a `jq`-style filter over a blocker feature's output artifact, expanded
 * when that feature goes terminal by hooking the DONE finalizer, idempotent on
 * `generated_by`); and edge-rewriting generated children into a dependent wave's
 * `blocked_by`.
 */
import type { ForEachResolver } from './promote-policy';

/** Default cap on how many features one generative wave may fan out to. */
export const DEFAULT_FOR_EACH_FANOUT_CAP = 200;

/** A resolver produced more items than the fan-out cap allows → escalate. */
export class ForEachFanoutError extends Error {
  readonly count: number;
  readonly cap: number;
  constructor(count: number, cap: number) {
    super(
      `for_each resolved ${count} items > fan-out cap ${cap} — escalate ` +
        `(raise the cap or narrow the query) rather than silently truncating`,
    );
    this.name = 'ForEachFanoutError';
    this.count = count;
    this.cap = cap;
  }
}

/** A resolver failed to run (bad glob, SQL error, missing dependency) → escalate. */
export class ForEachResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForEachResolverError';
  }
}

/** True when a wave's `for_each` is a system-run resolver (object), not a legacy
 *  named string (resolved by the agent passing `generate_items`). */
export function isForEachResolver(forEach: string | ForEachResolver): forEach is ForEachResolver {
  return typeof forEach === 'object' && forEach !== null;
}

/**
 * True when a `for_each` resolver is COMPLETION-TIME (`from_feature`) — its
 * item-set is published by a producing feature's worker and is NOT known at
 * promote time, so the wave is deferred and expanded when that feature publishes
 * (D-019). The promote-time kinds (items/glob/sql) return false.
 */
export function isCompletionTimeForEach(
  forEach: string | ForEachResolver,
): forEach is { from_feature: string } {
  return isForEachResolver(forEach) && 'from_feature' in forEach;
}

export interface ResolveForEachCtx {
  /** Run a glob against the harness repo, returning matching paths. Injected. */
  runGlob?: (pattern: string) => Promise<string[]>;
  /** Run a SQL query against the harness PG, returning the first column of each
   *  row as a string. Injected. */
  runSql?: (sql: string) => Promise<string[]>;
  /** Fan-out cap (default `DEFAULT_FOR_EACH_FANOUT_CAP`). */
  cap?: number;
}

/**
 * Resolve a generative wave's item-set by running its resolver. Returns the
 * deduped, trimmed, non-empty items. Throws `ForEachFanoutError` over the cap and
 * `ForEachResolverError` on any resolver failure — both signal "escalate", never
 * silent truncation/zero.
 */
export async function resolveForEach(
  spec: ForEachResolver,
  ctx: ResolveForEachCtx = {},
): Promise<string[]> {
  const cap = ctx.cap ?? DEFAULT_FOR_EACH_FANOUT_CAP;
  let raw: string[];
  try {
    if ('from_feature' in spec) {
      // Completion-time: expanded when the producing feature publishes, not here.
      throw new ForEachResolverError(
        `for_each.from_feature (${spec.from_feature}) is a completion-time resolver — ` +
          `it is expanded when that feature publishes its items, not at promote time`,
      );
    }
    if ('items' in spec) {
      raw = spec.items;
    } else if ('glob' in spec) {
      if (!ctx.runGlob) throw new ForEachResolverError('glob resolver needs a repo glob runner');
      raw = await ctx.runGlob(spec.glob);
    } else if ('sql' in spec) {
      if (!ctx.runSql) throw new ForEachResolverError('sql resolver needs a PG query runner');
      raw = await ctx.runSql(spec.sql);
    } else {
      throw new ForEachResolverError('unknown for_each resolver (expected items/glob/sql)');
    }
  } catch (e) {
    if (e instanceof ForEachResolverError) throw e;
    throw new ForEachResolverError(`for_each resolver failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const items = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  if (items.length > cap) throw new ForEachFanoutError(items.length, cap);
  return items;
}
