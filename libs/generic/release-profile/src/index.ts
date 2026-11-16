export type {
  ComponentCheckResult,
  ComponentEvaluation,
  ComponentRawVerdict,
  ComponentSpec,
  ComponentVerdict,
  EvidenceRef,
  LineageStamp,
  ReleaseProfileSpec,
  ReleaseProfileVerdict,
} from './types';
export { classifyRatingForGate, evaluateReleaseProfile, lineageMismatches, worstMemberVerdict, type EvaluateReleaseProfileOpts } from './evaluate';
