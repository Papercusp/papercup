/**
 * Seed `harness_shared.bash_tool_substitutions` from the audited pairs
 * (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 * D-002 makes the TABLE the single source of truth that both PreToolUse hooks
 * read at runtime. But the VERDICT is not a fact a human types — it is derived
 * by the P-004 harness from frozen samples of real commands. So this seeder is
 * the one place those two meet: it recomputes every verdict from the committed
 * fixtures and upserts the result.
 *
 * (The CLAUDE.md routing generator, P-019, therefore reads `ALL_PAIRS` rather
 * than the table: the pairs are UPSTREAM of both, so generating from them keeps
 * the prose, the seeded rows and the enforcement descended from one artifact —
 * and, unlike a DB read, it works with no Postgres, so its drift check can be a
 * hard build gate instead of an advisory one. See scripts/gen-tool-routing.ts.)
 *
 * That direction matters. Rows are DERIVED, never hand-authored, so the table
 * can never drift from the evidence: widen a tool, update its envelope, re-run
 * the seed, and the row follows. A hand-edited row would be a claim with no
 * sample behind it — exactly what D-001's enforcement gate must not rest on.
 *
 * Every row enters at `tier: 'observe'` regardless of verdict. Promotion to
 * `advise` is P-020's staged decision after a real observation window, never an
 * automatic consequence of a green verdict — the DB's `tier_requires_equivalence`
 * CHECK sets the ceiling, and this seeder deliberately stays under it.
 */

import { getOrgPg } from '@papercusp/db-org';
import { auditPair } from './equivalence';
import { ALL_PAIRS } from './pairs';
import type { CorpusFixture } from './corpus';
import type { PairAudit, SubstitutionPair } from './types';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** A pair plus the frozen sample its verdict is derived from. */
export interface PairWithFixture {
  pair: SubstitutionPair;
  fixture: CorpusFixture;
}

export interface SeedOutcome {
  intentLabel: string;
  toolName: string;
  verdict: PairAudit['verdict'];
  sampleSize: number;
  inserted: boolean;
}

/**
 * Upsert one audited pair. Keyed on (workspace_id, intent_label) — the intent is
 * the unit an advisory speaks about, so re-seeding updates in place rather than
 * accumulating duplicate rules that would fire twice on the same command.
 *
 * `tier`, `false_positive_count` and `observed_since` are deliberately NOT
 * overwritten on conflict: those are PROMOTION state earned by an observation
 * window (P-020), and re-running the seed must not silently demote a rule that
 * has already been promoted, nor erase the false-positive evidence that would
 * argue against promoting it.
 */
async function upsertPair(
  sql: OrgSql,
  workspaceId: string,
  audit: PairAudit,
  pair: SubstitutionPair,
  fixture: CorpusFixture,
): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO harness_shared.bash_tool_substitutions (
      workspace_id, intent_label, bash_pattern, bash_pattern_flags, tool_name,
      equivalence_verdict, sample_size, failing_cases, evidence_ref,
      tier, advisory_text, enabled,
      baseline_calls, baseline_sessions, observed_since
    ) VALUES (
      ${workspaceId}, ${audit.intentLabel}, ${audit.bashPattern}, ${audit.bashPatternFlags}, ${audit.toolName},
      ${audit.verdict}, ${audit.sampleSize}, ${JSON.stringify(audit.failingCases)}::jsonb, ${fixture.evidenceRef},
      'observe', ${pair.advisoryText}, true,
      ${fixture.totalAtoms}, ${fixture.totalSessions}, now()
    )
    ON CONFLICT (workspace_id, intent_label) DO UPDATE SET
      bash_pattern        = EXCLUDED.bash_pattern,
      bash_pattern_flags  = EXCLUDED.bash_pattern_flags,
      tool_name           = EXCLUDED.tool_name,
      equivalence_verdict = EXCLUDED.equivalence_verdict,
      sample_size         = EXCLUDED.sample_size,
      failing_cases       = EXCLUDED.failing_cases,
      evidence_ref        = EXCLUDED.evidence_ref,
      advisory_text       = EXCLUDED.advisory_text,
      baseline_calls      = EXCLUDED.baseline_calls,
      baseline_sessions   = EXCLUDED.baseline_sessions,
      updated_at          = now()
    RETURNING (xmax = 0) AS inserted
  `) as unknown as Array<{ inserted: boolean }>;

  return rows[0]?.inserted ?? false;
}

/**
 * Recompute every pair's verdict from its fixture and upsert the registry.
 *
 * @throws if a pair's recorded `expectedVerdict` disagrees with what the harness
 *   computes — that mismatch means the code and the evidence have diverged, and
 *   seeding a verdict nobody re-derived is precisely the drift D-002 exists to
 *   prevent. Fix the envelope or re-record the pair; never seed past it.
 */
export async function seedSubstitutionRegistry(opts: {
  workspaceId: string;
  fixtures: PairWithFixture[];
  client?: OrgSql;
}): Promise<SeedOutcome[]> {
  const sql = opts.client ?? getOrgPg().sql;
  const outcomes: SeedOutcome[] = [];

  for (const { pair, fixture } of opts.fixtures) {
    const audit = auditPair(pair, fixture.sample);
    if (audit.verdict !== pair.expectedVerdict) {
      throw new Error(
        `[substitution-seed] pair "${pair.id}" computes "${audit.verdict}" but is recorded as ` +
          `"${pair.expectedVerdict}". The envelope and the evidence disagree — re-audit before seeding.`,
      );
    }
    const inserted = await upsertPair(sql, opts.workspaceId, audit, pair, fixture);
    outcomes.push({
      intentLabel: audit.intentLabel,
      toolName: audit.toolName,
      verdict: audit.verdict,
      sampleSize: audit.sampleSize,
      inserted,
    });
  }

  return outcomes;
}

/** The pairs this seeder knows about — re-exported so callers need one import. */
export { ALL_PAIRS };
