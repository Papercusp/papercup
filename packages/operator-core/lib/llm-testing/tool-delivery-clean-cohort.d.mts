/** Types for the tracked native-ESM launcher; this does not authorize execution. */
export interface CleanCohortApproval {
  experimentId: string;
  portableSha256: string;
  buildSha: string;
  plan: { version: number; contentHash: string };
  auditSeq: number;
  rubric: { revision: number; criteriaHash: string };
  critic: string;
}
export interface CleanCohortAuthority {
  buildSha: string;
  readerSourceSha256: string;
  plan: CleanCohortApproval['plan'];
  audit: CleanCohortApproval['plan'] & { seq: number };
  rubric: CleanCohortApproval['rubric'] & { criteriaCount: number; selections: Record<string, string> };
  vetting: { satisfied: boolean; reason: string; attestedRevision: number; attestedCriteriaHash: string;
    critique: { critics: string[] } };
  implementer: string;
  r10: Array<{ specId: string; verdict: string; wouldBlock: string[];
    mechanicalProof: { verdict: string; gaps: string[] } }>;
}
export function assertCleanCohortAuthority(registration: {
  experiment: { id: string };
  measurementAmendment: { sourceReplacements: Record<string, { sha256: string }> };
}, portableSha256: string, expected: CleanCohortApproval | undefined, live: CleanCohortAuthority): void;
export function claimCleanCohort(directory: string, marker: Record<string, unknown>): void;
export function assertCleanCohortCatalogDefinitions(actual: unknown, expected: unknown): void;
export function assertCleanCohortCapturedInputs(input: {
  captured?: { installSha256: string; executableSha256: string; nodeVersion: string; moduleHashes: Record<string, string> };
  actual: { installSha256: string; executableSha256: string; nodeVersion: string; moduleHashes: Record<string, string> };
  amendment: { addedFiles: Record<string, string>; sourceReplacements: Record<string, { sha256: string }> };
  fixture: string; portableSha256: string; readHash: (path: string) => string;
}): void;
export function parseCleanCohortArgs(argv: string[]): {
  experimentId?: string; fixture?: string; readinessPath?: string; capturePath?: string;
};
export interface CleanCohortCaptureRequest {
  baselineExperimentId: string;
  experimentId: string;
  arms: { compactArm: string; fullArm: string };
  decisionRef: string;
  privateCaptureFile: string;
  portableFile: string;
  receiptDirectory: string;
}
export function validateCleanCohortCaptureRequest(request: CleanCohortCaptureRequest,
  baseline: { experiment: { id: string }; configuration: { replicationsPerArm: number; neverRetryMeasuredReplication: boolean } }): void;
export function cleanCohortCaptureDelta(before: Record<string, unknown>, after: Record<string, unknown>):
  Record<string, { beforeSha256: string; afterSha256: string; unchanged?: boolean; before?: unknown; after?: unknown }>;
export function captureCleanCohortRequest(input: { SuTarget: unknown; prompt: string; variant: unknown; model: string }): Promise<Record<string, unknown>>;
export interface CleanCohortCaptureDeltaEntry {
  beforeSha256: string; afterSha256: string; unchanged?: boolean; before?: unknown; after?: unknown; custody?: string;
}
export interface CleanCohortPortableCapture {
  [key: string]: unknown;
  capture: { [key: string]: unknown; privateCapture: { originalSha256: string; custody: string } };
  treatmentDelta: { basisExperimentId: string; previousPrivateSha256: string;
    components: Record<string, CleanCohortCaptureDeltaEntry> };
}
export function buildCleanCohortCapture(input: { request: CleanCohortCaptureRequest; baseline: unknown;
  baselinePrivateCapture: Buffer; catalogs: unknown; requests: unknown; expectedModel: { id: string; effort: string };
  boundary: unknown; controllerBoundary: unknown; sourcePins: unknown; createdAt: string }):
  { privateCapture: Buffer; portable: CleanCohortPortableCapture };
export function main(argv?: string[]): Promise<Record<string, unknown>>;
