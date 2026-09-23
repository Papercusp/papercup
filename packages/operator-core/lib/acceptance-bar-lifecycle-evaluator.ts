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
import { barRequiresAutomatedProof, readAcceptanceBarContractSnapshot } from './acceptance-bar-contract-snapshot';
import type { EvidenceCurrentInput } from './agent-tools/plans/spec-evidence-store';
import { deriveNonCodeItemProofs, type NonCodeItemProof } from './plan-requirement-realization';

export type AcceptanceBarLifecyclePhase = 'pre-start' | 'pre-vetting' | 'pre-grading' | 'ship';

export interface AcceptanceBarLifecycleVerdict {
  phase: AcceptanceBarLifecyclePhase;
  applicable: boolean;
  satisfied: boolean;
  codes: AcceptanceBarSnapshotCode[];
  blockingBars: Array<{ barKey: string; codes: AcceptanceBarSnapshotCode[] }>;
  /**
   * P-001: the half of `codes` that no BAR owns — source/completeness failures and
   * whole-contract obligations (bar set, vetting, author verdict). `blockingBars`
   * already carried the other half; without this the two were indistinguishable in
   * the flat `codes` list, so one blocked BAR read as a whole-contract regression.
   */
  contractCodes: AcceptanceBarSnapshotCode[];
  /** Every blocking code with the BAR keys that produced it; empty keys mean contract-level. */
  codeAttribution: Array<{ code: AcceptanceBarSnapshotCode; barKeys: string[] }>;
  /**
   * WI-10002509: the authoritative grading card that a `bar_snapshot_grading_stale`
   * BAR has judged stale, or null when no gating BAR reports one.
   *
   * The ship door defers its refusal on a stale grading specifically so an
   * independent re-grader gets recruited, but it re-derived "is this card current"
   * from the rubric revision/criteriaHash alone. A BAR also goes stale when the
   * EVIDENCE COHORT moved under an unchanged rubric (`cohortChangedSinceGrading`),
   * and such a card passed that narrower test — so the door saw a complete grading,
   * never reached `acceptance_ungraded`, and the re-grade the BAR lifecycle asks for
   * was unreachable. Carrying the BAR's own verdict keeps ONE staleness judgment:
   * the door must not re-implement the cohort fingerprint and drift from it.
   */
  staleGradingScorecardId: string | null;
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

// The manual-BAR predicate now lives beside the field it reads, in
// acceptance-bar-contract-snapshot, so the requirement-realization gate can share this
// exact definition instead of re-deriving one that never learned about the explicitly
// manual case (WI-10002089). Imported under the historic local name to keep call sites
// unchanged; the fail-closed fallback for pre-field snapshots moved with it.
const automatedProofRequired = barRequiresAutomatedProof;

/**
 * P-001: attribute every blocking code to the BAR(s) that produced it.
 *
 * A code reaches the verdict from two independent places — a BAR's own readiness
 * (directly, or re-derived per phase into `blockingBars`) and the whole-contract
 * completeness/lifecycle checks. The flat `codes` union erases which, so a plan
 * whose R-1..R-5 carry zero codes and whose R-6 owns six of them reported the same
 * string as a plan whose whole contract had regressed. That misreading has an
 * expensive wrong next action (`rubrics:amend`, which destroys an in-flight grading
 * card), so the attribution is computed here rather than left to the caller.
 */
function attributeCodes(
  snapshot: AcceptanceBarContractSnapshot,
  codes: readonly AcceptanceBarSnapshotCode[],
  blockingBars: AcceptanceBarLifecycleVerdict['blockingBars'],
): { contractCodes: AcceptanceBarSnapshotCode[]; codeAttribution: AcceptanceBarLifecycleVerdict['codeAttribution'] } {
  const barKeysByCode = new Map<AcceptanceBarSnapshotCode, string[]>();
  const own = (code: AcceptanceBarSnapshotCode, barKey: string) => {
    const keys = barKeysByCode.get(code);
    if (!keys) barKeysByCode.set(code, [barKey]);
    else if (!keys.includes(barKey)) keys.push(barKey);
  };
  // A BAR's raw readiness codes count as owned even when the phase re-derived a
  // different set for `blockingBars` — otherwise a deferred execution code that
  // only reaches `codes` through the snapshot fold would read as contract-level.
  for (const bar of snapshot.bars) for (const code of bar.readiness.codes) own(code, bar.barKey);
  for (const bar of blockingBars) for (const code of bar.codes) own(code, bar.barKey);

  const codeAttribution = codes.map((code) => ({ code, barKeys: barKeysByCode.get(code) ?? [] }));
  return {
    contractCodes: codeAttribution.filter((entry) => entry.barKeys.length === 0).map((entry) => entry.code),
    codeAttribution,
  };
}

/**
 * Render the attributed verdict. Contract-level codes are labelled as such, and the
 * clean-BAR count is stated explicitly so "one BAR is blocked" cannot be read as
 * "the contract has regressed".
 */
function attributedMessage(
  snapshot: AcceptanceBarContractSnapshot,
  phaseLabel: string,
  blockingBars: AcceptanceBarLifecycleVerdict['blockingBars'],
  contractCodes: readonly AcceptanceBarSnapshotCode[],
  // PHASE-FILTERED, never snapshot.readiness.nextRepair directly: the caller narrows
  // that to a repair whose code is actually in THIS phase's blocking set. Rendering the
  // contract-wide one can name a repair that is not among the codes printed beside it.
  nextRepair: AcceptanceBarLifecycleVerdict['nextRepair'],
): string {
  const segments = blockingBars.map((bar) => `${bar.barKey}: ${bar.codes.join(', ')}`);
  if (contractCodes.length > 0) segments.push(`contract-level: ${contractCodes.join(', ')}`);
  const total = snapshot.bars.length;
  const scope =
    total === 0
      ? 'no BARs declared'
      : `${blockingBars.length} of ${total} BAR(s) blocking, ${total - blockingBars.length} clean`;
  const head = `acceptance BAR contract is not ready for ${phaseLabel} — ${scope}: ${segments.join('; ')}`;

  // A refusal that names CODES but no VERB is the outlier among this repo's gates
  // (facts:assert names the exact overage, the arg validators print a CORRECTED CALL).
  // The repair text already exists — nextRepair() computes the prioritised action and
  // the snapshot carries it — it was simply dropped at the last render step, so every
  // caller had to go read the evaluator to learn what to do next.
  const repair = nextRepair;
  const repairLine = repair?.action
    ? `\nNEXT REPAIR${repair.barKey ? ` (${repair.barKey}, ${repair.code})` : ` (${repair.code})`}: ${repair.action}`
    : '';

  // The second omission that cost real time: this refusal does not recruit a grader,
  // and nothing said so. Recruitment fires only for ACCEPTANCE_GRADER_GATE_CODES
  // ({acceptance_ungraded, self_graded_only}) — deliberately, so a malformed rubric
  // cannot spawn agents. Every code rendered HERE is a contract code, so recruitment
  // is categorically not in play and the author owns every repair above.
  const recruitmentLine =
    '\nThis refusal does NOT recruit a grader: grader recruitment fires only on acceptance_ungraded / '
    + 'self_graded_only. These repairs are the plan author\'s alone — do not recruit or wake a peer for them.';

  return `${head}${repairLine}${recruitmentLine}`;
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
    if (bar.role === 'outcome' && automatedProofRequired(bar)) {
      if (!bar.requiredTestLayers?.length) addCode(codes, 'bar_snapshot_proof_depth_missing');
      else if (bar.proof.adequacy?.state !== 'pass') addCode(codes, 'bar_snapshot_proof_inadequate');
    }
    if (bar.proof.state === 'missing') addCode(codes, 'bar_snapshot_proof_missing');
    if (bar.proof.state === 'stale' || bar.proof.state === 'truncated') addCode(codes, 'bar_snapshot_proof_stale');
    if (bar.proof.uncertainEvidence > 0) addCode(codes, 'bar_snapshot_proof_uncertain');
    if (bar.evidencePlane !== 'tree' && !bar.proof.evidencePlanes.some((plane) => token(plane) === bar.evidencePlane)) {
      addCode(codes, 'bar_snapshot_evidence_plane_unmet');
    }
    const gatesShipping = bar.role === 'outcome' && bar.mandatory === true;
    if (gatesShipping && (bar.grading.state === 'missing' || bar.grading.state === 'truncated'))
      addCode(codes, 'bar_snapshot_grading_missing');
    if (gatesShipping && bar.grading.state === 'stale') addCode(codes, 'bar_snapshot_grading_stale');
    if (gatesShipping && bar.grading.state === 'not-pass') addCode(codes, 'bar_snapshot_grading_not_pass');
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
      contractCodes: [],
      codeAttribution: [],
      nextRepair: null,
      staleGradingScorecardId: null,
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
  // P-002: when the snapshot could not RESOLVE the rubric, its bar set is unknown,
  // not empty. Asserting bar_set_empty here would re-introduce the accusatory half
  // of the pair the projection just stopped emitting.
  const rubricUnresolved = codes.includes('bar_snapshot_rubric_unresolved');
  if (snapshot.bars.length === 0 && !pureInvestigation && !rubricUnresolved) {
    addCode(codes, 'bar_snapshot_bar_set_empty');
  }
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

  // The snapshot's repair is computed for the complete contract, while this
  // evaluator adds and defers codes according to the lifecycle door. Reuse the
  // richer snapshot action only when its code still blocks this phase; an
  // earlier-door repair (for example proof depth before pre-grading vetting)
  // would otherwise send the caller toward an irrelevant mutation.
  const nextRepair =
    (snapshot.readiness.nextRepair && codes.includes(snapshot.readiness.nextRepair.code)
      ? snapshot.readiness.nextRepair
      : null) ??
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
  const { contractCodes, codeAttribution } = attributeCodes(snapshot, codes, blockingBars);
  // WI-10002509: report the card the BAR judged stale, not merely THAT one is stale.
  // `bar_snapshot_grading_stale` is emitted against the single authoritative grading
  // (`authoritativeGrading` resolves one card per contract; only its per-BAR verdict
  // varies), so that id is what the ship door must exclude to reach
  // `acceptance_ungraded` and recruit the re-grade. A `not-pass` grading deliberately
  // does NOT appear here: a genuine unchanged fail stays terminal rather than
  // re-recruiting a grader on every ship attempt.
  const staleGradingScorecardId = codes.includes('bar_snapshot_grading_stale')
    ? snapshot.grading.authoritativeScorecardId
    : null;
  return {
    phase,
    applicable: true,
    satisfied: codes.length === 0,
    codes,
    blockingBars,
    contractCodes,
    codeAttribution,
    nextRepair,
    staleGradingScorecardId,
    message:
      codes.length === 0
        ? null
        : attributedMessage(snapshot, phaseLabel, blockingBars, contractCodes, nextRepair),
  };
}

export const evaluateAcceptanceBarContract = evaluateAcceptanceBarLifecycle;

/** I/O convenience for doors that do not already hold a snapshot. */
export async function readAndEvaluateAcceptanceBarLifecycle(
  planSlug: string,
  phase: AcceptanceBarLifecyclePhase,
  options: { expectedApplicable?: boolean; current?: EvidenceCurrentInput[]; harnessSlug?: string } = {},
): Promise<AcceptanceBarLifecycleVerdict> {
  const snapshot = await readAcceptanceBarContractSnapshot(planSlug, {}, {
    current: options.current,
    ...(options.harnessSlug ? { harnessSlug: options.harnessSlug } : {}),
  });
  // Only a positively identified legacy plan may bypass the contract. A missing,
  // unavailable, ambiguous, or truncated subject read cannot establish legacy
  // status, even when a generic start door has no adoption-marker assertion.
  const knownLegacy =
    snapshot.plan != null &&
    snapshot.plan.adoptionEpoch == null &&
    !snapshot.completeness.problems.some((problem) => problem.source === 'plan' && problem.severity === 'error');
  if (knownLegacy && options.expectedApplicable !== true) {
    return {
      phase,
      applicable: false,
      satisfied: true,
      codes: [],
      blockingBars: [],
      contractCodes: [],
      codeAttribution: [],
      nextRepair: null,
      staleGradingScorecardId: null,
      message: null,
    };
  }
  // Unknown applicability is not non-applicability. Preserve the reader's
  // blocking source diagnostics through the strict evaluator, including when a
  // caller explicitly expects an adopted plan but the second read disagrees.
  return {
    ...evaluateAcceptanceBarLifecycle(
      snapshot.applicable ? snapshot : { ...snapshot, applicable: true },
      phase,
    ),
    nonCodeItemProofs: deriveNonCodeItemProofs(snapshot),
  };
}
