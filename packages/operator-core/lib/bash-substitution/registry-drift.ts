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

import { auditPair } from './equivalence';
import type { SubstitutionRow } from './match';
import type { PairWithFixture } from './seed';
import type { EquivalenceVerdict } from './types';

/**
 * The registry fields the seeder DERIVES from a pair, and therefore the only
 * ones drift is meaningful for.
 *
 * Deliberately excludes `tier`, `false_positive_count` and `observed_since`:
 * those are PROMOTION state earned by an observation window (P-020), which the
 * seeder's `ON CONFLICT` clause pointedly does not overwrite. Reporting a
 * promoted row as "drifted" because its tier is no longer `observe` would flag
 * the system working correctly, and would train whoever reads the report to
 * ignore it.
 */
export interface ExpectedRow {
  intentLabel: string;
  bashPattern: string;
  bashPatternFlags: string;
  toolName: string;
  advisoryText: string;
  equivalenceVerdict: EquivalenceVerdict;
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
export function expectedRows(fixtures: PairWithFixture[]): ExpectedRow[] {
  return fixtures.map(({ pair, fixture }) => {
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
