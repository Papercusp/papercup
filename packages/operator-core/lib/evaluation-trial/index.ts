/**
 * The canonical evaluation-trial contract (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-004).
 *
 * One versioned identity + evidence envelope shared by every measurement family,
 * projected from the rows those families already write. P-001 (WI-41656) proved
 * extension viable and this module honours that verdict literally: no new table,
 * no new column, no competing authority.
 *
 * Typical use:
 *
 *     const trial = trialFromLlmTestRun(row);
 *     const id = computeTrialIdentity(trial);
 *     if (!areComparable(id, priorId)) {
 *       // refuse to reuse the prior verdict; explainIncomparability(id, priorId)
 *       // says whether the bindings differ or a binding was never recorded.
 *     }
 */
export type {
  EvaluationTrial,
  EvidenceEnvelope,
  GraderKind,
  PrivacyClass,
  TrialBudgets,
  TrialConfiguration,
  TrialFamily,
  TrialGrader,
  TrialLineage,
  TrialOutcome,
  TrialStatus,
  TrialSubject,
  TrialSystemIdentity,
  TrialUsage,
} from './schema';

export {
  EVALUATION_TRIAL_CONTRACT_LABEL,
  EVALUATION_TRIAL_CONTRACT_SHAPE,
  EVALUATION_TRIAL_CONTRACT_VERSION,
  EVALUATION_TRIAL_IDENTITY_DOMAIN,
  TRIAL_BINDING_FIELDS,
  areComparable,
  computeTrialIdentity,
  explainIncomparability,
  type TrialIdentity,
} from './identity';

export {
  fingerprint,
  trialFromHiveEvalRun,
  trialFromLlmTestRun,
  trialFromScorecard,
  trialFromTaskRunResult,
  type LlmTestRunRow,
} from './adapters';
