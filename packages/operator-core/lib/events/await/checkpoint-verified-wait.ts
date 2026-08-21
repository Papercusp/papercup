import { gitPipelineSnapshot, type GitPipelineSnapshot } from '../../git-pipeline-stats';
import type {
  ProducerHealthCertificate,
  ProducerHealthObservation,
  ProducerHealthObservationState,
} from './verified-wait';
import { PRODUCER_HEALTH_CERTIFICATE_VERSION } from './verified-wait';

export interface CheckpointProducerDetails extends Record<string, unknown> {
  pipeline: string;
  candidateSha?: string;
  runId?: string;
}

function checkpointProgressAtMs(snapshot: GitPipelineSnapshot): number | null {
  return (
    snapshot.activeRun?.progressAtMs ??
    snapshot.activeRun?.startedAtMs ??
    snapshot.routines?.greenCheckpoint?.lastFiredAtMs ??
    null
  );
}

function matchingVerdict(
  snapshot: GitPipelineSnapshot,
  issuedAtMs: number,
  details: CheckpointProducerDetails,
) {
  return (snapshot.recent ?? []).find((event) => {
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

function checkpointObservationState(
  snapshot: GitPipelineSnapshot,
  details: CheckpointProducerDetails,
): ProducerHealthObservationState | undefined {
  const routine = snapshot.routines?.greenCheckpoint;
  const activeRun = snapshot.activeRun;
  const candidateBound = Boolean(details.candidateSha || details.runId);
  const explicitlyPaused = routine?.pause?.reason != null;

  if (activeRun?.active === true) return 'active';

  // The live probe produced NO reading at all — not "confirmed not running", just
  // never observed (a skipped/unresolvable probe root, a swallowed probe exception,
  // or `includeActiveRun` never having been asked for it). That is genuinely unknown
  // regardless of whether the wait names a specific candidate: an absent observation
  // is not evidence the named run isn't there, and must not be allowed to fall through
  // to the timestamp-staleness heuristic below, which cannot distinguish "no signal"
  // from "a stale one" and can misclassify an active, un-probed writer as stalled
  // (EI-21045433666635330). This check MUST run before the candidate-bound early
  // return: that return exists to withhold `idle` (a real claim that no run is
  // expected), never to withhold `unknown` (a claim only that nothing was observed).
  if (activeRun == null) return 'unknown';

  // EI-20971831715218093: a candidate-bound wait cannot conclude a stalled/absent
  // producer merely because the checkpoint mechanism is not currently judging ANY
  // candidate (activeRun.candidate == null). That reading is "hasn't started judging
  // yet" every bit as much as "started and went quiet" -- the routine can sit with no
  // active candidate while unrelated, live upstream work (e.g. a separate affected-
  // test verifier task the checkpoint launch waits on) genuinely progresses. Falling
  // through to the timestamp-staleness heuristic below in that state misreads the
  // routine's own last-tick timestamp (which can be arbitrarily old on a slow cadence)
  // as evidence the producer went stale, and recommends an owner takeover for a
  // producer that was never stalled. Prefer the conservative `unknown` (re-await) —
  // never a positive `idle` claim, since a candidate-bound wait cannot safely assert
  // no run is expected for ITS candidate either.
  if (candidateBound && activeRun.candidate == null) return 'unknown';

  // A candidate-bound wait is asking about a specific run. Once we know a DIFFERENT
  // candidate is (or was) the one being judged, an idle routine still cannot safely
  // declare our candidate "expected idle"; keep the old stalled/absent diagnosis for
  // that targeted case — this only applies once we know the probe DID observe an
  // actual candidate (activeRun.candidate is non-null here).
  if (candidateBound) return undefined;

  // `active` on the routine is configuration/liveness of the scheduler, not
  // proof that a checkpoint is currently running. An explicit pause is even
  // stronger evidence that no run is expected right now.
  if ((routine?.active === true || explicitlyPaused) && activeRun.candidate == null) {
    return 'idle';
  }

  return undefined;
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
    lastProgressAtMs: checkpointProgressAtMs(input.snapshot),
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
  const producerPresent = snapshot.activeRun?.active === true || snapshot.routines?.greenCheckpoint?.active === true;
  const state = checkpointObservationState(snapshot, details);
  return {
    checkedAtMs: snapshot.generatedAtMs,
    producerPresent,
    ...(state ? { state } : {}),
    lastProgressAtMs: checkpointProgressAtMs(snapshot),
    lastFireAtMs: verdict?.createdAtMs ?? null,
    completedAtMs: verdict?.createdAtMs ?? null,
    evidence: {
      pipeline: details.pipeline,
      active: snapshot.activeRun?.active ?? false,
      candidate: snapshot.activeRun?.candidate ?? null,
      ...(state ? { producerState: state } : {}),
      routineActive: snapshot.routines?.greenCheckpoint?.active ?? false,
      routinePauseReason: snapshot.routines?.greenCheckpoint?.pause?.reason ?? null,
      verdictStatus: verdict?.status ?? null,
    },
  };
}
