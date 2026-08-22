import { z } from 'zod';
import { gitPipelineSnapshot } from '../../git-pipeline-stats';
import { checkpointProducerCertificate } from '../../events/await/checkpoint-verified-wait';
import type { ProducerHealthCertificate } from '../../events/await/verified-wait';

export const producerHealthInputSchema = z
  .object({
    kind: z.literal('green-checkpoint'),
    pipeline: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
      ),
    candidate_sha: z.string().min(1).max(128).optional(),
    run_id: z.string().min(1).max(200).optional(),
    expected_cadence_sec: z.number().int().positive().max(7 * 24 * 60 * 60),
    owner_id: z.string().min(1).max(200).optional(),
    work_item_id: z.string().min(1).max(200).optional(),
  })
  .describe(
    'Opt into a verified wait backed by authoritative producer health. The push event remains primary; at the bounded deadline the sweeper re-checks this producer, re-parks progress, or wakes with stalled/absent diagnosis. Currently supports green-checkpoint.',
  );

export type ProducerHealthInput = z.infer<typeof producerHealthInputSchema>;

export async function resolveProducerHealthCertificate(input: {
  producerHealth: ProducerHealthInput;
  subscriberId: string;
  timeoutSec?: number;
  nowMs?: number;
}): Promise<ProducerHealthCertificate> {
  const producer = input.producerHealth;
  const issuedAtMs = input.nowMs ?? Date.now();
  const expectedCadenceMs = producer.expected_cadence_sec * 1_000;
  const verificationDeadlineMs = issuedAtMs + (input.timeoutSec == null ? expectedCadenceMs : input.timeoutSec * 1_000);
  const snapshot = await gitPipelineSnapshot(producer.pipeline, { includeActiveRun: true });
  if (!snapshot.routines.greenCheckpoint && !snapshot.activeRun) {
    throw new Error(
      `producer health — unknown green-checkpoint pipeline: ${producer.pipeline}. ` +
        'Use the sanitized integration-root basename from the event key (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint"; no wait was registered.',
    );
  }
  return checkpointProducerCertificate({
    pipeline: producer.pipeline,
    candidateSha: producer.candidate_sha,
    runId: producer.run_id,
    ownerId: producer.owner_id ?? null,
    workItemId: producer.work_item_id ?? null,
    issuedAtMs,
    expectedCadenceMs,
    verificationDeadlineMs,
    snapshot,
  });
}
