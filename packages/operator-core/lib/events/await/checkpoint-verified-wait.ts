import { gitPipelineSnapshot, type GitPipelineSnapshot } from '../../git-pipeline-stats';
import type { ProducerHealthCertificate, ProducerHealthObservation } from './verified-wait';
import { PRODUCER_HEALTH_CERTIFICATE_VERSION } from './verified-wait';

export interface CheckpointProducerDetails extends Record<string, unknown> {
  pipeline: string;
  candidateSha?: string;
  runId?: string;
}

function matchingVerdict(
  snapshot: GitPipelineSnapshot,
  issuedAtMs: number,
  details: CheckpointProducerDetails,
) {
  return snapshot.recent.find((event) => {
    if (event.kind !== 'green_checkpoint' || event.createdAtMs < issuedAtMs) return false;
    const candidate = typeof event.detail.candidate === 'string' ? event.detail.candidate : null;
    const candidateMatches =
      !details.candidateSha ||
      (candidate != null &&
        (candidate.startsWith(details.candidateSha) || details.candidateSha.startsWith(candidate)));
    const runMatches = !details.runId || event.detail.runId === details.runId;
    return candidateMatches && runMatches;
  });
}

export function checkpointProducerCertificate(input: {
  pipeline: string;
  candidateSha?: string;
  runId?: string;
  ownerId: string;
  workItemId?: string | null;
  issuedAtMs: number;
  expectedCadenceMs: number;
  verificationDeadlineMs: number;
  snapshot: GitPipelineSnapshot;
}): ProducerHealthCertificate {
  return {
    version: PRODUCER_HEALTH_CERTIFICATE_VERSION,
    producer: {
      kind: 'green-checkpoint',
      id: input.runId ?? input.snapshot.activeRun?.candidate ?? input.candidateSha ?? input.pipeline,
    },
    owner: { ownerId: input.ownerId, workItemId: input.workItemId ?? null },
    issuedAtMs: input.issuedAtMs,
    lastProgressAtMs: input.snapshot.activeRun?.startedAtMs ?? input.snapshot.routines.greenCheckpoint?.lastFiredAtMs ?? null,
    lastFireAtMs: matchingVerdict(input.snapshot, 0, input)?.createdAtMs ?? null,
    expectedCadenceMs: input.expectedCadenceMs,
    verificationDeadlineMs: input.verificationDeadlineMs,
    details: {
      pipeline: input.pipeline,
      ...(input.candidateSha ? { candidateSha: input.candidateSha } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    },
  };
}

export async function observeCheckpointProducer(
  certificate: ProducerHealthCertificate,
  deps: { snapshot?: (pipeline: string) => Promise<GitPipelineSnapshot> } = {},
): Promise<ProducerHealthObservation> {
  const details = certificate.details as CheckpointProducerDetails | undefined;
  if (!details?.pipeline) throw new Error('checkpoint producer certificate is missing details.pipeline');
  const snapshot = await (deps.snapshot ?? ((pipeline) => gitPipelineSnapshot(pipeline, { includeActiveRun: true })))(
    details.pipeline,
  );
  const verdict = matchingVerdict(snapshot, certificate.issuedAtMs, details);
  const producerPresent = snapshot.activeRun?.active === true || snapshot.routines.greenCheckpoint?.active === true;
  return {
    checkedAtMs: snapshot.generatedAtMs,
    producerPresent,
    lastProgressAtMs: snapshot.activeRun?.startedAtMs ?? snapshot.routines.greenCheckpoint?.lastFiredAtMs ?? null,
    lastFireAtMs: verdict?.createdAtMs ?? null,
    completedAtMs: verdict?.createdAtMs ?? null,
    evidence: {
      pipeline: details.pipeline,
      active: snapshot.activeRun?.active ?? false,
      candidate: snapshot.activeRun?.candidate ?? null,
      verdictStatus: verdict?.status ?? null,
    },
  };
}
