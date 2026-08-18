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

import { atomize, atomizePipeline } from './atomize';
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
  const out: SubstitutionMatch[] = [];
  const pipedOut = atomsWhoseStdoutFeedsAPipe(command);
  // First matching atom wins: one row speaks about one intent, so a command
  // reading two files should produce ONE `file-whole-read` advisory, not two
  // copies of the same sentence. That dedup is an ADVISORY concern — see
  // matchAtomsToSubstitutions for why COUNTING must not inherit it.
  const seen = new Set<string>();
  for (const m of matchAtomsToSubstitutions(atomsOf(command), rows)) {
    if (seen.has(m.intentLabel)) continue;
    if (RENDERED_OUTPUT_TOOLS.has(m.toolName) && pipedOut.has(m.atom)) continue;
    seen.add(m.intentLabel);
    out.push(m);
  }
  return out;
}

/**
 * Tools whose result is a RENDERED payload rather than the command's raw stdout.
 *
 * The standing rule (owner, 2026-08-18 — D-045): guidance fires only where the
 * tool is a fully equivalent substitute for what the agent actually wrote. A
 * pipeline stage is the case where that silently stops being true. `cat FILE`
 * and `capability:read { file_path }` answer the same question when the agent is
 * the reader, but `cat FILE | grep X` feeds BYTES to a next stage, and
 * `capability:read` returns a numbered, headed, paged rendering — so the advice
 * is not merely less helpful there, it is wrong.
 *
 * Membership is a property of the TOOL, not of the row, which is why this is
 * keyed on `toolName` and needs no new column. The test for membership is
 * concrete: does the pair need an {@link AnswerEnvelope} to make the two sides
 * comparable? `capability:read` does (header + per-line number prefix + pager
 * footer), and that envelope IS the proof its output is not byte-identical.
 *
 * DELIBERATELY NOT a blanket "suppress every piped atom" rule, which would be
 * wrong in the other direction: `npm test … 2>&1 | tail -60` should still advise
 * `testing:run`, because that tool subsumes the WHOLE pipeline — it returns the
 * failing tests structurally, so there is nothing left for the `tail` to do.
 * Suppressing that advisory would withhold good advice. The distinction is
 * whether the tool replaces the ATOM (and hands the next stage something it
 * cannot use) or replaces the PIPELINE.
 *
 * Only `capability:read` is listed because it is the only membership backed by
 * evidence today — the file-read family is where a live rollout demonstrated the
 * failure. The remaining tools are UNSURVEYED, not cleared; adding one requires
 * the same envelope argument, not an intuition.
 */
const RENDERED_OUTPUT_TOOLS = new Set(['capability:read']);

/**
 * The atoms of `command` whose stdout is consumed by a pipe.
 *
 * Derived from the NEXT atom's separator rather than the atom's own: `atomize`
 * records what precedes an atom (`pipedInto`), and "my output goes to a pipe" is
 * exactly "the atom after me was piped into".
 *
 * Returns normalised atom TEXT, which is the same grain
 * {@link matchAtomsToSubstitutions} reports in `SubstitutionMatch.atom`, so the
 * two can be compared directly. A command that legitimately repeats an atom on
 * both sides of a pipe collapses to one entry; that is harmless here, because a
 * repeated atom piping out even once is enough to withhold the advisory.
 */
export function atomsWhoseStdoutFeedsAPipe(command: string): Set<string> {
  const parts = atomizePipeline(command);
  const out = new Set<string>();
  parts.forEach((part, index) => {
    if (parts[index + 1]?.pipedInto) out.add(part.atom);
  });
  return out;
}

/**
 * The matchable atoms of a raw command — `atomize` plus the length cap.
 *
 * Factored out so the advisory path and the counting path can never disagree
 * about what "the atoms of this command" are, including which oversized ones
 * get dropped (MAX_MATCHABLE_ATOM_LENGTH).
 */
export function atomsOf(command: string): string[] {
  if (!command.trim()) return [];
  return atomize(command).filter((a) => a.length <= MAX_MATCHABLE_ATOM_LENGTH);
}

/**
 * EVERY (row, atom) match across the given atoms — no per-row dedup.
 *
 * This is the COUNTING entry point (P-002), and its difference from
 * {@link matchCommandToSubstitutions} is deliberate. That function answers
 * "what should I tell this agent", so it collapses a command reading three
 * files into one advisory. This one answers "how much of that intent
 * happened", where three reads are three reads.
 *
 * Atom grain is also what makes the P-029 before/after a real comparison: the
 * frozen `fixtures/*.sample.json` baselines recorded `totalAtoms` as
 * `corpusAtoms.filter(pattern.test).length` — every matching atom — so a
 * command-deduped metric would be measuring a different quantity than the
 * number it is compared against.
 *
 * Everything else — pattern compilation, stateful-flag stripping, the
 * `not-a-substitute` skip — is shared with the advisory path by construction,
 * because that path now runs through this function.
 */
export function matchAtomsToSubstitutions(
  atoms: string[],
  rows: SubstitutionRow[],
): SubstitutionMatch[] {
  if (atoms.length === 0 || rows.length === 0) return [];

  const out: SubstitutionMatch[] = [];
  for (const row of rows) {
    // Per D-007 these record a pattern whose tool answers a DIFFERENT question
    // (the ~5,100 Grep/Glob calls agents were correctly told to make). They are
    // documented negatives, not substitutions — counting them as substitutable
    // demand would overstate the number this plan is trying to move.
    if (row.equivalenceVerdict === 'not-a-substitute') continue;
    const pattern = compileRegistryPattern(row.bashPattern, row.bashPatternFlags ?? '');
    if (!pattern) continue;

    for (const atom of atoms) {
      if (!pattern.test(atom)) continue;
      out.push({
        intentLabel: row.intentLabel,
        toolName: row.toolName,
        tier: row.tier,
        advisoryText: row.advisoryText,
        atom,
      });
    }
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
