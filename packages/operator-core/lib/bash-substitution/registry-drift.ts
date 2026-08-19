/**
 * registry-drift.ts — compare the SEEDED registry rows against the audited pairs
 * (plan `bash-to-tool-substitution-2026-07-26`, P-018/P-019).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `ALL_PAIRS` has TWO downstream projections, and until this file only ONE of
 * them had a gate:
 *
 *   pairs ──> CLAUDE.md routing table   (gen-tool-routing --check: HARD gate)
 *         └─> bash_tool_substitutions   (seed.ts: no caller at all)
 *
 * The gated projection stayed correct. The ungated one silently rotted: after
 * D-017/D-018/D-019 widened `dev:service_health` and moved the listening-socket
 * query onto the new `dev:listening_ports` verb, CLAUDE.md followed within the
 * same change (its check fails the build) while three DB rows kept serving the
 * OLD advisory for ~12 hours — including one that told agents "there is no tool
 * form; keep using ss/lsof", which had become false the moment D-017 shipped.
 *
 * The lesson generalises past this plan: A DERIVED ARTIFACT WITHOUT A DRIFT
 * CHECK IS NOT DERIVED, IT IS A COPY — and a copy of a claim about tooling
 * decays into a lie about tooling. So the DB projection gets the same `--check`
 * treatment its sibling already had.
 *
 * ── WHAT THIS CATCHES THAT gen-tool-routing CANNOT ──────────────────────────
 * `gen-tool-routing.ts` reads the pairs and never the database — deliberately,
 * so it can be a hard build gate with no Postgres. Its docstring names the cost:
 *
 *   "a row inserted DIRECTLY into the table with a novel intent_label would be
 *    enforced by both hooks yet never appear here, and this generator cannot see
 *    that drift direction."
 *
 * That is the `orphan` drift below. A hand-inserted row is enforced by both
 * PreToolUse hooks while appearing in no prose and resting on no sample — the
 * precise thing D-001 says enforcement must never rest on. Reading the DB is the
 * only way to see it, which is why this check is separate from that one rather
 * than folded into it.
 *
 * Pure functions only: no `postgres`, no `fs`. The I/O shell is
 * `scripts/seed-substitution-registry.ts`, mirroring how `routing-table.ts`
 * keeps `gen-tool-routing.ts` to file reads and exit codes.
 */

import { auditPair, meetsAuditFloor } from './equivalence';
import { normalizeRegistryFlags, type SubstitutionRow } from './match';
import type { PairWithFixture } from './seed';
import { assertPolicyTier, type EquivalenceVerdict, type SubstitutionTier } from './types';

/**
 * The registry fields the seeder DERIVES from a pair, and therefore the only
 * ones drift is meaningful for.
 *
 * Deliberately excludes `false_positive_count` and `observed_since`: those are
 * PROMOTION state earned by an observation window (P-020), which the seeder's
 * `ON CONFLICT` clause pointedly does not overwrite. Reporting a promoted row as
 * "drifted" because its tier is no longer `observe` would flag the system
 * working correctly, and would train whoever reads the report to ignore it.
 *
 * ── WHY `tier` IS CONDITIONAL RATHER THAN EXCLUDED (D-046) ──────────────────
 * `tier` used to be excluded outright, for the reason above. That was right for
 * ordinary rows and wrong for the one row class where tier is the highest-
 * consequence field on the table: a pair that declares `policyTier` OWNS its
 * tier, and the seeder RE-ASSERTS it on every run. Read seed.ts's upsert — the
 * two cases are already split there, and this file only mirrored half of it:
 *
 *   tier = CASE WHEN <pair.policyTier> IS NULL
 *               THEN bash_tool_substitutions.tier   -- earned: never overwritten
 *               ELSE EXCLUDED.tier END              -- pair-owned: re-asserted
 *
 * So an un-seeded change to a `policyTier` was invisible to the drift check,
 * which is exactly backwards: a policy row is the only kind that can BLOCK a
 * command, and `deny` vs `advise` is the difference between a blocked agent and
 * an advisory nobody is required to follow. `tier` is therefore compared when —
 * and only when — the pair declares one, leaving the earned-promotion invariant
 * untouched. `undefined` here means "the database owns this", not "unknown".
 */
export interface ExpectedRow {
  intentLabel: string;
  bashPattern: string;
  bashPatternFlags: string;
  toolName: string;
  advisoryText: string;
  equivalenceVerdict: EquivalenceVerdict;
  /**
   * The tier the PAIR declares and the seeder re-asserts, or `undefined` for an
   * ordinary row whose tier is earned by observation and owned by the database.
   * Only a defined value is ever compared — see the interface docstring.
   */
  tier?: SubstitutionTier;
}

/** One field that disagrees between the pairs and the seeded row. */
export interface FieldDrift {
  field: keyof ExpectedRow;
  expected: string;
  actual: string;
}

export type RowDrift =
  /** A pair exists but was never seeded — the gate cannot enforce it. */
  | { kind: 'missing'; intentLabel: string; expected: ExpectedRow }
  /**
   * A row exists that no pair produces. Enforced by both hooks, backed by no
   * sample — the drift direction `gen-tool-routing` is structurally blind to.
   */
  | { kind: 'orphan'; intentLabel: string; toolName: string; tier: string }
  /** The row is stale: the pairs moved and the seed was never re-run. */
  | { kind: 'changed'; intentLabel: string; fields: FieldDrift[] };

/**
 * What the seeder WOULD write for each pair, recomputed from the frozen sample.
 *
 * Uses `auditPair` rather than the pair's recorded `expectedVerdict` on purpose:
 * the point is to compare the database against the EVIDENCE, not against another
 * hand-recorded claim. (`seedSubstitutionRegistry` refuses to write when those
 * two disagree, so a drift run that reaches here has already agreed with itself.)
 */
/**
 * The tier this pair OWNS, or `undefined` when the database owns it.
 *
 * Routed through `assertPolicyTier` rather than reading `pair.policyTier`
 * directly so the expectation is computed by the SAME authorization function the
 * seeder writes through: a pair that reaches for a tier it is not entitled to
 * throws here exactly as it would there, instead of the drift check quietly
 * expecting a value the seeder would have refused to write.
 */
function ownedTierFor(pair: PairWithFixture['pair']): SubstitutionTier | undefined {
  return pair.policyTier === undefined ? undefined : assertPolicyTier(pair);
}

export function expectedRows(fixtures: PairWithFixture[]): ExpectedRow[] {
  return fixtures.map(({ pair, fixture }) => {
    // A pair whose population is below the audit floor has no evidence to
    // recompute FROM, so the honest expected row records `unaudited` rather than
    // a verdict — auditing it would throw and take the whole drift check with it.
    // Everything else on the row still comes from the pair, because the ROW is
    // real even when the verdict is not: `deps.unsafe-install` is enforced at
    // `deny` on D-003's independent authority, and dropping it here would let the
    // registry quietly diverge from the pairs for exactly the rows that are gated
    // hardest. (Reached at P-002, when the D-047 atomizer fix took that pair's
    // population from 28 atoms to 18.)
    if (!meetsAuditFloor(fixture.sample.length, fixture)) {
      return {
        intentLabel: pair.intentLabel,
        bashPattern: pair.bashPattern.source,
        bashPatternFlags: normalizeRegistryFlags(pair.bashPattern.flags),
        toolName: pair.toolName,
        advisoryText: pair.advisoryText,
        equivalenceVerdict: 'unaudited' as const,
        // The below-floor branch is where every policy row lands (D-003 grants
        // its tier from a pre-existing rule, not from a sample), so this is the
        // arm that actually carries a tier expectation in practice.
        tier: ownedTierFor(pair),
      };
    }
    // Pass the fixture as the POPULATION so a homogeneous-but-high-volume pair
    // (few distinct spellings, many real commands) is audited as a census rather
    // than rejected as under-sampled — see auditPair's census note.
    const audit = auditPair(pair, fixture.sample, fixture);
    return {
      intentLabel: audit.intentLabel,
      bashPattern: audit.bashPattern,
      bashPatternFlags: audit.bashPatternFlags,
      toolName: audit.toolName,
      advisoryText: pair.advisoryText,
      equivalenceVerdict: audit.verdict,
      // Ordinary audited pairs declare no policyTier, so this is `undefined` and
      // their earned tier stays uncompared. Computed here anyway rather than
      // hardcoded: a future policy pair that clears the audit floor must still
      // have its tier checked, and an arm that silently skips it would be the
      // same half-mirror of seed.ts this change exists to remove.
      tier: ownedTierFor(pair),
    };
  });
}

const COMPARED_FIELDS: Array<keyof ExpectedRow> = [
  'toolName',
  'equivalenceVerdict',
  'advisoryText',
  'bashPattern',
  'bashPatternFlags',
];

/**
 * Every disagreement between the pairs and the seeded rows.
 *
 * Empty result ⇒ the registry the hooks enforce is exactly what the committed
 * evidence supports. Non-empty ⇒ re-run the seeder (or, for an `orphan`, delete
 * the row / add the pair that justifies it).
 */
export function diffRegistry(expected: ExpectedRow[], actual: SubstitutionRow[]): RowDrift[] {
  const actualByLabel = new Map(actual.map((r) => [r.intentLabel, r]));
  const drifts: RowDrift[] = [];

  for (const want of expected) {
    const got = actualByLabel.get(want.intentLabel);
    if (!got) {
      drifts.push({ kind: 'missing', intentLabel: want.intentLabel, expected: want });
      continue;
    }
    const fields: FieldDrift[] = [];
    for (const field of COMPARED_FIELDS) {
      // `advisory_text` is nullable in the table; normalise so a NULL row reads
      // as an empty-string drift rather than throwing or comparing `null` to a
      // sentence and reporting nothing useful.
      const actualValue = field === 'advisoryText' ? (got.advisoryText ?? '') : String(got[field] ?? '');
      if (actualValue !== want[field]) {
        fields.push({ field, expected: want[field], actual: actualValue });
      }
    }
    if (fields.length > 0) drifts.push({ kind: 'changed', intentLabel: want.intentLabel, fields });
  }

  const expectedLabels = new Set(expected.map((e) => e.intentLabel));
  for (const got of actual) {
    if (!expectedLabels.has(got.intentLabel)) {
      drifts.push({ kind: 'orphan', intentLabel: got.intentLabel, toolName: got.toolName, tier: got.tier });
    }
  }

  return drifts;
}

/** Human-readable drift report — one block per row, truncated for terminals. */
export function formatDrift(drifts: RowDrift[]): string {
  if (drifts.length === 0) return '✓ bash_tool_substitutions matches the audited pairs\n';

  const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines: string[] = [`✗ ${drifts.length} registry row(s) drifted from the audited pairs:\n`];

  for (const d of drifts) {
    if (d.kind === 'missing') {
      lines.push(`  MISSING  ${d.intentLabel} → ${d.expected.toolName} (${d.expected.equivalenceVerdict})`);
      lines.push('           never seeded; the PreToolUse gate cannot enforce it');
    } else if (d.kind === 'orphan') {
      lines.push(`  ORPHAN   ${d.intentLabel} → ${d.toolName} (tier=${d.tier})`);
      lines.push('           row has no pair behind it: enforced, but resting on no sample (D-001)');
    } else {
      lines.push(`  STALE    ${d.intentLabel}`);
      for (const f of d.fields) {
        lines.push(`           ${f.field}:`);
        lines.push(`             db    ${clip(f.actual)}`);
        lines.push(`             pairs ${clip(f.expected)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
