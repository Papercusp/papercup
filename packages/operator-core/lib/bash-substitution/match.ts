/**
 * Match a raw shell command against the substitution registry
 * (plan `bash-to-tool-substitution-2026-07-26`, P-015).
 *
 * This is the ONE matcher every consumer runs: the `locks:check_command` server
 * verdict, both PreToolUse hooks (P-016 cc shell, P-017 omp ts), and the
 * CLAUDE.md routing generator (P-019). D-002 makes the TABLE the single source
 * of truth for WHICH patterns exist; this module is the single source of truth
 * for what MATCHING one means. Two places deciding "does this command match"
 * would drift exactly the way the pre-filter tokens drifted from the resource
 * `match_patterns` (the hazard migration 665's own comment names).
 *
 * Everything here is PURE and synchronous — no DB, no I/O. The rows come from
 * the caller, so the hook can match against a cached snapshot and the server
 * against a live read, with byte-identical semantics.
 */

import { atomize } from './atomize';
import type { EquivalenceVerdict, SubstitutionTier } from './types';

/**
 * A registry row as the matcher needs it — the projection of
 * `harness_shared.bash_tool_substitutions` that matters for matching.
 */
export interface SubstitutionRow {
  intentLabel: string;
  bashPattern: string;
  /** Regex flags the pattern was AUDITED with (migration 667). */
  bashPatternFlags?: string;
  toolName: string;
  tier: SubstitutionTier;
  advisoryText: string | null;
  equivalenceVerdict: EquivalenceVerdict;
}

/** One registry row that claimed one atom of the command. */
export interface SubstitutionMatch {
  intentLabel: string;
  toolName: string;
  tier: SubstitutionTier;
  advisoryText: string | null;
  /** The specific normalised atom that matched — what an `observe` tier logs. */
  atom: string;
}

/**
 * Flags that make `RegExp.prototype.test()` STATEFUL by advancing `lastIndex`
 * between calls. A registry row carrying one would match, then miss, then match
 * again across successive commands — an advisory that fires every other time
 * with no reproducible pattern. Migration 667's CHECK makes storing one
 * impossible; this strips it anyway, because the audit harness also compiles
 * pairs that were never written to the registry.
 */
const STATEFUL_FLAGS = /[gy]/g;

/**
 * The longest atom we will run a registry regex against.
 *
 * WHY A CAP AT ALL: these patterns come from a database row and run inside a
 * PreToolUse hook on EVERY bash command from EVERY agent on the box. A pattern
 * with nested quantifiers meeting a long enough subject backtracks
 * catastrophically, and the failure mode is not a bad advisory — it is a hung
 * hook, which is a wedged agent, fleet-wide, with no obvious cause. 4000 chars
 * is far above every atom in the audit corpus (the substitutions target
 * one-liners: `sed -n '1,80p' file`, `psql -c "SELECT …"`), so the cap costs no
 * real coverage; anything longer is a heredoc body or an inlined script, which
 * is not what any of these intents describe.
 */
export const MAX_MATCHABLE_ATOM_LENGTH = 4000;

/**
 * Compile a registry pattern the way every consumer must compile it.
 *
 * Returns null for a malformed pattern rather than throwing: a bad row must
 * never wedge a command. Enforcement here is cooperative and fail-open — the
 * worst acceptable outcome of a broken row is a missing advisory, and the worst
 * UNacceptable one is a blocked agent, so the choice is not close.
 */
export function compileRegistryPattern(source: string, flags = ''): RegExp | null {
  try {
    return new RegExp(source, normalizeRegistryFlags(flags));
  } catch {
    return null;
  }
}

/**
 * The flags a pattern is STORED with — the stateful ones removed.
 *
 * Recording these rather than the raw `.flags` keeps the stored row honest: the
 * registry's value is exactly what {@link compileRegistryPattern} will build
 * from, so "the audited pattern" and "the enforced pattern" are the same object
 * by construction rather than by two call sites agreeing. It also keeps the row
 * insertable — migration 667's CHECK rejects `g`/`y` outright.
 */
export function normalizeRegistryFlags(flags = ''): string {
  return flags.replace(STATEFUL_FLAGS, '');
}

/**
 * Every registry row that claims some atom of `command`.
 *
 * Matching is PER ATOM, not against the whole command line — the registry's
 * `bash_pattern` column is documented that way and every equivalence verdict was
 * computed that way (see `atomize`). Matching the raw line instead would both
 * over-match (a piped `| grep` reading as a code search) and under-match (a
 * leading `cd` hiding the real verb), which would divorce enforcement from the
 * evidence that authorised it.
 *
 * `not-a-substitute` rows are skipped unconditionally. Per D-007 those record a
 * pattern whose tool answers a DIFFERENT question — the ~5,100 Grep/Glob calls
 * where agents were correctly following the harness's own instruction. They
 * exist in the table as documented negatives so nobody re-litigates them, and
 * surfacing one as an advisory would tell an agent to stop doing the right
 * thing.
 */
export function matchCommandToSubstitutions(
  command: string,
  rows: SubstitutionRow[],
): SubstitutionMatch[] {
  if (!command.trim() || rows.length === 0) return [];

  const atoms = atomize(command).filter((a) => a.length <= MAX_MATCHABLE_ATOM_LENGTH);
  if (atoms.length === 0) return [];

  const out: SubstitutionMatch[] = [];
  for (const row of rows) {
    if (row.equivalenceVerdict === 'not-a-substitute') continue;
    const pattern = compileRegistryPattern(row.bashPattern, row.bashPatternFlags ?? '');
    if (!pattern) continue;

    // First matching atom wins: one row speaks about one intent, so a command
    // reading two files should produce ONE `file-whole-read` advisory, not two
    // copies of the same sentence.
    const atom = atoms.find((a) => pattern.test(a));
    if (atom === undefined) continue;

    out.push({
      intentLabel: row.intentLabel,
      toolName: row.toolName,
      tier: row.tier,
      advisoryText: row.advisoryText,
      atom,
    });
  }

  return out;
}

/** Tier precedence — the strongest tier among matches decides what happens. */
const TIER_RANK: Record<SubstitutionTier, number> = { observe: 0, advise: 1, deny: 2 };

/**
 * The single tier a set of matches resolves to, or null when nothing matched.
 * A command touching both an `observe` and an `advise` rule is advised.
 */
export function strongestTier(matches: SubstitutionMatch[]): SubstitutionTier | null {
  let best: SubstitutionTier | null = null;
  for (const m of matches) {
    if (best === null || TIER_RANK[m.tier] > TIER_RANK[best]) best = m.tier;
  }
  return best;
}
