/**
 * P-003 — lifecycle BAR contract evaluator.
 *
 * `AcceptanceBarContractSnapshot` is the one bounded read model. This module is
 * deliberately pure: each lifecycle door supplies the snapshot it already read
 * and chooses the phase whose obligations it is about to make true. Keeping the
 * phase policy here prevents rubric/start/vetting/grading/ship callers from
 * growing subtly different partial joins.
 */
import type {
  AcceptanceBarContractSnapshot,
  AcceptanceBarSnapshotCode,
  AcceptanceBarTrace,
} from './acceptance-bar-contract-snapshot';
import { readAcceptanceBarContractSnapshot } from './acceptance-bar-contract-snapshot';
import type { EvidenceCurrentInput } from './agent-tools/plans/spec-evidence-store';
import { deriveNonCodeItemProofs, type NonCodeItemProof } from './plan-requirement-realization';

export type AcceptanceBarLifecyclePhase = 'pre-start' | 'pre-vetting' | 'pre-grading' | 'ship';

export interface AcceptanceBarLifecycleVerdict {
  phase: AcceptanceBarLifecyclePhase;
  applicable: boolean;
  satisfied: boolean;
  codes: AcceptanceBarSnapshotCode[];
  blockingBars: Array<{ barKey: string; codes: AcceptanceBarSnapshotCode[] }>;
  nextRepair: AcceptanceBarContractSnapshot['readiness']['nextRepair'];
  message: string | null;
  /** Same snapshot's exact current operational proof, shared with the activation join. */
  nonCodeItemProofs?: NonCodeItemProof[];
}

const POSITIVE_PASS_FORBIDDEN = new Set([
  'unknown',
  'unassessable',
  'not-assessable',
  'not-assessed',
  'not-measured',
  'not-observed',
  'not-observable',
  'indeterminate',
  'inconclusive',
  'unverified',
  'unavailable',
  'no-verdict',
  'not-applicable',
  'na',
  'broken',
  'degraded',
  'fail',
  'failed',
  'failing',
  'error',
  'waived',
]);

function token(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^n\/a$/, 'na');
}

function addCode(codes: AcceptanceBarSnapshotCode[], code: AcceptanceBarSnapshotCode): void {
  if (!codes.includes(code)) codes.push(code);
}

function allSnapshotCodes(snapshot: AcceptanceBarContractSnapshot): AcceptanceBarSnapshotCode[] {
  return [
    ...new Set([
      ...snapshot.completeness.problems
        .filter((problem) => problem.severity === 'error')
        .map((problem) => problem.code),
      ...snapshot.bars.flatMap((bar) => bar.readiness.codes),
    ]),
  ];
}

function phaseSnapshotCodes(
  snapshot: AcceptanceBarContractSnapshot,
  phase: AcceptanceBarLifecyclePhase,
): AcceptanceBarSnapshotCode[] {
  const deferred = new Set<AcceptanceBarSnapshotCode>([
    'bar_snapshot_method_missing',
    'bar_snapshot_work_contract_missing',
    'bar_snapshot_work_contract_stale',
    'bar_snapshot_proof_missing',
    'bar_snapshot_proof_stale',
    'bar_snapshot_proof_uncertain',
    'bar_snapshot_proof_depth_missing',
    'bar_snapshot_proof_inadequate',
    'bar_snapshot_evidence_plane_unmet',
    'bar_snapshot_grading_missing',
    'bar_snapshot_grading_stale',
    'bar_snapshot_grading_not_pass',
    'bar_snapshot_vetting_missing',
    'bar_snapshot_vetting_stale',
    'bar_snapshot_author_verdict_missing',
    'bar_snapshot_author_verdict_stale',
    'bar_snapshot_author_rejected',
  ]);
  return allSnapshotCodes(snapshot).filter((code) => {
    if (!deferred.has(code)) return true;
    if (phase === 'ship') return true;
    if (phase === 'pre-grading')
      return code === 'bar_snapshot_vetting_missing' || code === 'bar_snapshot_vetting_stale';
    return false;
  });
}

function baseBarCodes(snapshot: AcceptanceBarContractSnapshot, bar: AcceptanceBarTrace): AcceptanceBarSnapshotCode[] {
  const codes: AcceptanceBarSnapshotCode[] = [];
  for (const code of bar.readiness.codes) {
    // These are execution/ship obligations, not pre-start obligations. The
    // phase below adds them when they become relevant.
    if (
      ![
        'bar_snapshot_method_missing',
        'bar_snapshot_work_contract_missing',
        'bar_snapshot_work_contract_stale',
        'bar_snapshot_proof_missing',
        'bar_snapshot_proof_stale',
        'bar_snapshot_proof_depth_missing',
        'bar_snapshot_proof_inadequate',
        'bar_snapshot_grading_missing',
        'bar_snapshot_grading_stale',
        'bar_snapshot_grading_not_pass',
      ].includes(code)
    )
      addCode(codes, code);
  }
  if (!bar.barHash) addCode(codes, 'bar_snapshot_bar_hash_missing');
  if (!bar.model.trim()) addCode(codes, 'bar_snapshot_bar_hash_missing');
  if (!bar.falsifier.trim()) addCode(codes, 'bar_snapshot_falsifier_missing');
  if (!bar.provenance) addCode(codes, 'bar_snapshot_bar_provenance_missing');
  if (!bar.evidencePlane || !['tree', 'deployed', 'live'].includes(bar.evidencePlane)) {
    addCode(codes, 'bar_snapshot_scope_invalid');
  }
  if (bar.requiredScope.length === 0) addCode(codes, 'bar_snapshot_scope_invalid');

  const role = bar.role;
  if (role !== 'outcome' && role !== 'disclosure') addCode(codes, 'bar_snapshot_role_invalid');
  if (role === 'outcome') {
    if (bar.mandatory !== true) addCode(codes, 'bar_snapshot_mandatory_invalid');
    const scale = new Set((snapshot.rubric?.ratingScale ?? []).map(token));
    const passRatings = bar.passRatings.map(token).filter(Boolean);
    if (
      passRatings.length === 0 ||
      passRatings.some((rating) => !scale.has(rating) || POSITIVE_PASS_FORBIDDEN.has(rating))
    ) {
      addCode(codes, 'bar_snapshot_pass_ratings_invalid');
    }
  } else if (role === 'disclosure') {
    if (bar.mandatory === true || bar.passRatings.length > 0 || bar.coversBarKeys.length === 0) {
      addCode(codes, 'bar_snapshot_coverage_invalid');
    }
    const outcomeKeys = new Set(
      snapshot.bars.filter((candidate) => candidate.role === 'outcome').map((candidate) => candidate.barKey),
    );
    if (bar.coversBarKeys.some((key) => !outcomeKeys.has(key))) addCode(codes, 'bar_snapshot_coverage_invalid');
  }
  return codes;
}

function executionBarCodes(bar: AcceptanceBarTrace, phase: AcceptanceBarLifecyclePhase): AcceptanceBarSnapshotCode[] {
  const codes: AcceptanceBarSnapshotCode[] = [];
  if (phase === 'pre-start') return codes;
  if (!bar.method.trim()) addCode(codes, 'bar_snapshot_method_missing');
  if (!bar.check) addCode(codes, 'bar_snapshot_check_missing');
  else if (bar.check.kind === 'instrument' && !bar.check.instrumentKey.trim())
    addCode(codes, 'bar_snapshot_check_invalid');
  // An instrument:'none' check is the explicit manual contract. It still needs
  // a non-empty METHOD (checked above), while runnable checks carry their own
  // file/instrument/probe/cargo binding in the structured check.
  if (phase === 'ship') {
    if (bar.role === 'outcome') {
      if (!bar.requiredTestLayers?.length) addCode(codes, 'bar_snapshot_proof_depth_missing');
      else if (bar.proof.adequacy?.state !== 'pass') addCode(codes, 'bar_snapshot_proof_inadequate');
    }
    if (bar.proof.state === 'missing') addCode(codes, 'bar_snapshot_proof_missing');
    if (bar.proof.state === 'stale' || bar.proof.state === 'truncated') addCode(codes, 'bar_snapshot_proof_stale');
    if (bar.proof.uncertainEvidence > 0) addCode(codes, 'bar_snapshot_proof_uncertain');
    if (bar.evidencePlane !== 'tree' && !bar.proof.evidencePlanes.some((plane) => token(plane) === bar.evidencePlane)) {
      addCode(codes, 'bar_snapshot_evidence_plane_unmet');
    }
    if (bar.grading.state === 'missing' || bar.grading.state === 'truncated')
      addCode(codes, 'bar_snapshot_grading_missing');
    if (bar.grading.state === 'stale') addCode(codes, 'bar_snapshot_grading_stale');
    if (bar.grading.state === 'not-pass') addCode(codes, 'bar_snapshot_grading_not_pass');
  }
  return codes;
}

/** Evaluate one immutable snapshot at a named lifecycle door. */
export function evaluateAcceptanceBarLifecycle(
  snapshot: AcceptanceBarContractSnapshot,
  phase: AcceptanceBarLifecyclePhase,
): AcceptanceBarLifecycleVerdict {
  if (!snapshot.applicable) {
    return {
      phase,
      applicable: false,
      satisfied: true,
      codes: [],
      blockingBars: [],
      nextRepair: null,
      message: null,
    };
  }

  const codes: AcceptanceBarSnapshotCode[] = [];
  // A post-epoch plan must never turn an unavailable/truncated source into an
  // empty successful contract. Every source/completeness error blocks every
  // applicable phase, including the early BAR-only phase.
  for (const code of phaseSnapshotCodes(snapshot, phase)) addCode(codes, code);
  const blockingBars: AcceptanceBarLifecycleVerdict['blockingBars'] = [];
  for (const bar of snapshot.bars) {
    const barCodes = [...new Set([...baseBarCodes(snapshot, bar), ...executionBarCodes(bar, phase)])];
    if (barCodes.length > 0) {
      blockingBars.push({ barKey: bar.barKey, codes: barCodes });
      for (const code of barCodes) addCode(codes, code);
    }
  }

  const pureInvestigation = snapshot.rubric?.classRef === 'plan-class-investigation' && snapshot.bars.length === 0;
  if (snapshot.bars.length === 0 && !pureInvestigation) addCode(codes, 'bar_snapshot_bar_set_empty');
  if (phase === 'pre-grading' || phase === 'ship') {
    const hasCriteria = snapshot.bars.length > 0;
    if (hasCriteria && snapshot.grading.vetting.state !== 'current') {
      addCode(
        codes,
        snapshot.grading.vetting.state === 'stale' ? 'bar_snapshot_vetting_stale' : 'bar_snapshot_vetting_missing',
      );
    }
  }
  if (phase === 'ship') {
    if (!pureInvestigation) {
      if (snapshot.grading.authorVerdict.state === 'missing') addCode(codes, 'bar_snapshot_author_verdict_missing');
      if (snapshot.grading.authorVerdict.state === 'stale') addCode(codes, 'bar_snapshot_author_verdict_stale');
      if (snapshot.grading.authorVerdict.state === 'rejected') addCode(codes, 'bar_snapshot_author_rejected');
    }
  }

  const nextRepair =
    snapshot.readiness.nextRepair ??
    (() => {
      const first = codes[0];
      return first
        ? { code: first, barKey: blockingBars.find((bar) => bar.codes.includes(first))?.barKey ?? null, action: first }
        : null;
    })();
  const phaseLabel =
    phase === 'pre-start'
      ? 'start'
      : phase === 'pre-vetting'
        ? 'vetting'
        : phase === 'pre-grading'
          ? 'grading'
          : 'ship';
  return {
    phase,
    applicable: true,
    satisfied: codes.length === 0,
    codes,
    blockingBars,
    nextRepair,
    message: codes.length === 0 ? null : `acceptance BAR contract is not ready for ${phaseLabel}: ${codes.join(', ')}`,
  };
}

export const evaluateAcceptanceBarContract = evaluateAcceptanceBarLifecycle;

/** I/O convenience for doors that do not already hold a snapshot. */
export async function readAndEvaluateAcceptanceBarLifecycle(
  planSlug: string,
  phase: AcceptanceBarLifecyclePhase,
  options: { expectedApplicable?: boolean; current?: EvidenceCurrentInput[] } = {},
): Promise<AcceptanceBarLifecycleVerdict> {
  const snapshot = await readAcceptanceBarContractSnapshot(planSlug, {}, { current: options.current });
  // Callers that already know the subject carries the adoption marker (rubric
  // grading/vetting and the ship gate) set expectedApplicable=true, preserving
  // fail-closed behavior when a source read is unavailable. Generic start doors
  // do not carry that marker in their lightweight PlanRow; an absent snapshot
  // plan there is treated as legacy/unknown rather than blocking every start.
  if ((!snapshot.plan || snapshot.plan.adoptionEpoch == null) && options.expectedApplicable !== true) {
    return {
      phase,
      applicable: false,
      satisfied: true,
      codes: [],
      blockingBars: [],
      nextRepair: null,
      message: null,
    };
  }
  // A caller that already proved the adoption marker (for example the rubric
  // writer or terminal ship gate) must not let a failed plan-row read become a
  // false non-applicable result. Force the evaluator into the strict branch so
  // the source-unavailable/plan-missing codes remain visible and blocking.
  return {
    ...evaluateAcceptanceBarLifecycle(
      options.expectedApplicable === true && !snapshot.applicable ? { ...snapshot, applicable: true } : snapshot,
      phase,
    ),
    nonCodeItemProofs: deriveNonCodeItemProofs(snapshot),
  };
}
