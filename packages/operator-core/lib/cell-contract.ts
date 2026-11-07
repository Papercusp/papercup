/**
 * cell-contract.ts — the shared vocabulary of the agent state-cell contract
 * (unified-agent-state-plane-2026-07-27 #D-038).
 *
 * THE CANONICAL HOME. A cell that needs one of these types imports it from here;
 * it does NOT re-declare its own copy. Re-declaring is precisely the defect this
 * module exists to fix — see below — and it is also what axis 5 (one derivation,
 * many lenses) forbids one level up, at the resolver.
 *
 * ── WHY AN ENUM AND NOT A STRING (D-038 axis 2, corollary) ───────────────────
 *
 * Axis 2 of the contract: a cell is three-valued, and `null` must never be read
 * as a positive verdict. The corollary is that the unknown must be reported IN
 * BAND — a bare `null` cannot distinguish "this question does not apply here"
 * from "I tried to measure and failed", and a caller will read the friendlier
 * one.
 *
 * Three surfaces, written independently by different authors for different
 * domains, reached that conclusion on their own AND THEN MADE THE SAME MISTAKE:
 * each reported the reason as FREE TEXT (`git-pipeline-position.ts`,
 * `candidate-contains.ts`, `scout/success-metrics.ts`). Prose cannot be branched
 * on, so the field preserved the distinction for a human reader and destroyed it
 * for a program — and the two main cases demand OPPOSITE caller behaviour:
 * `not-applicable` is a final answer, `resolver-failed` is retry-or-escalate.
 *
 * That convergence is the argument for putting this in the contract rather than
 * leaving it to resolver quality: left to individual judgement, three
 * independent teams got the same half right and the same half wrong. A contract
 * term has to be mechanically checkable — a registry can refuse a cell whose
 * nullable verdict carries no enumerated reason; it cannot check "the resolver
 * is good". As D-038 puts it: a rule whose breach is undetectable by the party
 * it protects is not a contract term, it is a hope.
 */

/**
 * WHY a cell's value is unknown. Four codes, chosen because each one implies a
 * DIFFERENT correct caller response — a distinction that is worthless unless the
 * caller can branch on it:
 *
 *  - `not-applicable`   — the question does not apply to this subject at all.
 *                         A FINAL answer: retrying changes nothing, and there is
 *                         no lever. (A path compiled into the desktop binary has
 *                         no server process, so "is the server current?" has no
 *                         meaning for it.)
 *  - `resolver-failed`  — the measurement was attempted and did not succeed.
 *                         RETRY-OR-ESCALATE: the value may well exist, and a
 *                         later read may get it.
 *  - `not-measured`     — the resolver deliberately did not look (an opt-in leg
 *                         that was not enabled, a probe skipped for cost). The
 *                         lever is to ask for it, not to retry the same call.
 *  - `insufficient-data`— the measurement partly succeeded but cannot support a
 *                         verdict (one of two operands read; a denominator too
 *                         small to divide by). More INPUT is the lever, not a
 *                         retry and not a different question.
 *
 * Deliberately NOT extensible by convention: adding a fifth code is a contract
 * change, because every caller's branch set changes with it.
 */
import type { CellRead } from './cell-read';

export type CellUnknownCode = 'not-applicable' | 'resolver-failed' | 'not-measured' | 'insufficient-data';

export type CellComparisonTarget = 'measurement' | 'assessment' | 'material';

/** Persisted in the existing fact dependency JSON. Missing/unknown versions need
 * a new observation; a raw digest cannot establish semantic freshness. */
export interface CellObservationAnchor {
  version: 1;
  target: CellComparisonTarget;
  identityDigest: string;
  qualifierDigest: string;
  selectedDigest: string;
}

export function parseCellObservationAnchor(raw: unknown): CellObservationAnchor | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (a.version !== 1 || !['measurement', 'assessment', 'material'].includes(String(a.target))) return undefined;
  for (const key of ['identityDigest', 'qualifierDigest', 'selectedDigest']) {
    if (typeof a[key] !== 'string' || !/^[a-f0-9]{16}$/.test(a[key])) return undefined;
  }
  return {
    version: 1,
    target: a.target as CellComparisonTarget,
    identityDigest: a.identityDigest as string,
    qualifierDigest: a.qualifierDigest as string,
    selectedDigest: a.selectedDigest as string,
  };
}

/** A lens on ONE completed read, shared by capture and subsequent comparison.
 * Evidence values may contain telemetry; only their availability/measuredness
 * qualifies a selected value. The declared uncertainty channel remains data. */
export function projectCellComparison(
  read: CellRead,
  subject?: string,
  requestedTarget?: CellComparisonTarget,
):
  | { status: 'unknown'; unknown: CellUnknownCode | 'absent' }
  | { status: 'value'; target: CellComparisonTarget; selected: unknown; identity: unknown; qualifiers: unknown } {
  if (read.status === 'absent') return { status: 'unknown', unknown: 'absent' };
  if (read.status === 'unknown') return { status: 'unknown', unknown: read.unknown.code };
  if (read.assessment?.status === 'unavailable') return { status: 'unknown', unknown: read.assessment.unknown.code };
  if (read.unknownHoist?.drifted || read.unknownHoist?.truncatedByDoor) {
    return { status: 'unknown', unknown: 'insufficient-data' };
  }
  const target = requestedTarget ?? (read.material ? 'material' : 'measurement');
  if ((target === 'material' && !read.material) || (target === 'assessment' && !read.assessment)) {
    return { status: 'unknown', unknown: 'insufficient-data' };
  }
  const evidence = read.assessment?.evidence ?? [];
  if (evidence.some((e) => e.drifted || e.truncatedByDoor || e.measuredBy?.drifted)) {
    return { status: 'unknown', unknown: 'insufficient-data' };
  }
  return {
    status: 'value',
    target,
    selected: target === 'material' ? read.material!.value : target === 'assessment' ? read.assessment!.code : read.value,
    identity: {
      cell: read.cell,
      subject: subject ?? null,
      resolver: read.resolver,
      measurementPath: read.measurementPath ?? null,
      target,
      materialPath: read.material?.path ?? null,
      assessmentPath: read.assessment?.path ?? null,
      sourcePath: read.source?.path ?? null,
      uncertaintyPath: read.unknownHoist?.key ?? null,
      evidencePaths: evidence.map((e) => [e.path, e.measuredBy?.path ?? null]).sort(),
    },
    qualifiers: {
      assessment: read.assessment
        ? { status: read.assessment.status, code: read.assessment.code, meaning: read.assessment.meaning, safeAction: read.assessment.safeAction }
        : null,
      source: read.source ? { value: read.source.value, authoritative: read.source.authoritative } : null,
      uncertainty: read.unknownHoist ? { value: read.unknownHoist.value, nullTerminated: read.unknownHoist.nullTerminated === true } : null,
      evidence: evidence.map((e) => ({
        path: e.path,
        nullTerminated: e.nullTerminated === true,
        measuredBy: e.measuredBy ? { value: e.measuredBy.value, nullTerminated: e.measuredBy.nullTerminated === true } : null,
      })).sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}

/**
 * The in-band unknown. `code` is the branchable fact; `detail` is the human
 * sentence — the prose these fields used to carry ON THEIR OWN, preserved rather
 * than discarded, because it is genuinely useful to an agent reading a report.
 *
 * `detail` is optional by the contract but strongly encouraged: `code` tells a
 * program what to do, `detail` tells a reader why. Supplying only `code` is
 * legal and lossy; supplying only prose is what this type exists to prevent.
 */
export interface CellUnknown {
  code: CellUnknownCode;
  detail?: string;
}

/**
 * Terse constructor — keeps a producing call site to one line so that reporting
 * the unknown properly is never the inconvenient option. (Every site that got
 * this wrong had prose sitting right there; make the correct form the cheap one.)
 */
export function cellUnknown(code: CellUnknownCode, detail?: string): CellUnknown {
  return detail === undefined ? { code } : { code, detail };
}

/**
 * Render an unknown for a prose surface (a report line, a tool `summary`). Falls
 * back to the code when no detail was supplied, so a human-facing surface never
 * renders `undefined` or silently drops the fact that the value is unknown.
 */
export function formatCellUnknown(u: CellUnknown): string {
  return u.detail ?? UNKNOWN_CODE_PROSE[u.code];
}

/** Last-resort prose per code, for a cell that supplied no `detail`. */
const UNKNOWN_CODE_PROSE: Record<CellUnknownCode, string> = {
  'not-applicable': 'This question does not apply to this subject.',
  'resolver-failed': 'The value could not be measured (the resolver failed).',
  'not-measured': 'The value was not measured on this read.',
  'insufficient-data': 'There was not enough data to reach a verdict.',
};

/**
 * Every `CellUnknownCode`, as a runtime value.
 *
 * DERIVED from the prose map rather than written out a second time, so the list and
 * the type cannot drift: `UNKNOWN_CODE_PROSE` is a `Record<CellUnknownCode, …>`, so
 * the compiler already forces it to be exhaustive, and reading its keys inherits that
 * guarantee for free. A hand-maintained sibling array is exactly the second copy of a
 * truth the code already owns that this repo's derived-truth rule exists to prevent.
 *
 * Consumer (D-008): the cell registry rejects an assessment enum that reuses one of
 * these. Read-health and domain meaning are different vocabularies — a cell answering
 * `resolver-failed` as though it were a domain verdict would let an apparatus failure
 * masquerade as a measured finding about the subject.
 */
export const CELL_UNKNOWN_CODES: readonly CellUnknownCode[] = Object.freeze(
  Object.keys(UNKNOWN_CODE_PROSE) as CellUnknownCode[],
);
