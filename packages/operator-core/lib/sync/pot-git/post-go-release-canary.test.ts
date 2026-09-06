import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import {
  PHASE_G_INPUT_SCHEMA,
  executePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';
import {
  POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
  POST_GO_RELEASE_CANARY_SCHEMA,
  validatePostGoReleaseCanary,
  type PostGoReleaseCanaryInput,
} from './post-go-release-canary';

const CANDIDATE = 'a'.repeat(40);
const RUN = 'p524-post-go-phase-g-0001';
const GO_AT = '2026-08-10T19:59:59.000Z';
const CANARY_START = '2026-08-10T20:00:00.000Z';
const CANARY_FINISH = '2026-08-13T20:00:00.000Z';
const PHASE_G_START = '2026-08-13T20:00:00.000Z';
const PHASE_G_OBSERVED = '2026-08-13T20:30:00.000Z';
const PHASE_G_FINISH = '2026-08-13T21:00:00.000Z';
const EVALUATED_AT = '2026-08-13T21:01:00.000Z';

let phaseG: PhysicalPhaseGInput;

beforeAll(async () => {
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const result = await executePhysicalPhaseG(
    {
      runId: RUN,
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
    },
    { now: () => PHASE_G_OBSERVED },
  );
  phaseG = {
    schemaVersion: PHASE_G_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: PHASE_G_START, finishedAt: PHASE_G_FINISH },
    identities: {
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
    },
    result,
  };
}, 60_000);

function validInput(): PostGoReleaseCanaryInput {
  return {
    schemaVersion: POST_GO_RELEASE_CANARY_SCHEMA,
    candidateSha: CANDIDATE,
    independentGo: {
      decision: 'GO',
      candidateSha: CANDIDATE,
      approvedAt: GO_AT,
      reviewerOwnerId: 'su-independent-reviewer',
      implementationOwnerId: 'su-implementation-owner',
      attestationRef: 'p2p-public-release-endgame-2026-09-01#P-401',
    },
    canary: {
      candidateSha: CANDIDATE,
      startedAt: CANARY_START,
      finishedAt: CANARY_FINISH,
    },
    ownerFreezeChaos: {
      candidateSha: CANDIDATE,
      window: { startedAt: PHASE_G_START, finishedAt: PHASE_G_FINISH },
      duringOwnerOutage: {
        protectedEffects: 'frozen',
        nonOwnerAttempt: 'refused',
        reason: 'missing-hive-authority',
      },
      afterOwnerRecovery: {
        owningHiveProof: 'restored',
        protectedEffects: 'resumed',
      },
      phaseG: structuredClone(phaseG),
    },
    evaluatedAt: EVALUATED_AT,
  };
}

describe('post-GO public-release canary readiness', () => {
  it('does not accept future-dated elapsed time from a caller-supplied receipt', () => {
    const input = validInput();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CANARY_FINISH) - 1);
    try {
      const premature = validatePostGoReleaseCanary(input);
      expect(premature.ok).toBe(false);
      expect(premature.errors).toContain('evaluatedAt cannot be in the future relative to the verifier clock');
      // The identical receipt becomes eligible only once its stated observation
      // time is in the past; do not weaken the actual 72-hour duration check.
      clock.mockReturnValue(Date.parse(EVALUATED_AT));
      expect(validatePostGoReleaseCanary(input).ok).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('accepts an exact 72-hour post-GO canary followed by validated owner-freeze chaos', () => {
    const verdict = validatePostGoReleaseCanary(validInput());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        candidateSha: CANDIDATE,
        status: 'ready-for-default-mode-decision',
        planItems: ['P-501', 'P-502', 'P-503'],
        canaryDurationMs: POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
        ownerFreezeVerified: true,
        ownerRecoveryVerified: true,
      },
    });
  });

  it('rejects a canary that starts before the independent GO', () => {
    const input = validInput();
    input.independentGo.approvedAt = '2026-08-10T20:00:00.001Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'canary cannot start before the independent GO',
    );
  });

  it('rejects a canary even one millisecond short of 72 hours', () => {
    const input = validInput();
    input.canary.finishedAt = '2026-08-13T19:59:59.999Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'canary must run for an actual minimum of 72 hours',
    );
  });

  it('rejects candidate rebinding anywhere in the post-GO sequence', () => {
    const input = validInput();
    input.canary.candidateSha = 'b'.repeat(40);
    input.ownerFreezeChaos.candidateSha = 'c'.repeat(40);
    expect(validatePostGoReleaseCanary(input).errors).toEqual(
      expect.arrayContaining([
        'canary must bind the exact independently approved candidate',
        'owner-freeze chaos must bind the exact canary candidate',
      ]),
    );
  });

  it('requires an independent reviewer rather than an implementation self-GO', () => {
    const input = validInput();
    input.independentGo.reviewerOwnerId = input.independentGo.implementationOwnerId;
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'independent GO reviewer must differ from the implementation owner',
    );
  });

  it('rejects owner-freeze chaos that begins before the canary completes', () => {
    const input = validInput();
    input.canary.finishedAt = '2026-08-13T20:00:00.001Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'owner-freeze chaos cannot execute before the 72-hour canary finishes',
    );
  });

  it('rejects narrative freeze claims when the Phase G authority evidence is invalid', () => {
    const input = validInput();
    input.ownerFreezeChaos.phaseG.result.authorityFence.deviceOnlyAcceptance = {
      ok: true,
      reason: null,
    };
    expect(validatePostGoReleaseCanary(input).errors).toEqual(
      expect.arrayContaining([
        'Phase G: Phase G device-only advance must be rejected without owning hive authority',
        'owner-freeze chaos must contain complete validated P-308 Phase G evidence',
      ]),
    );
  });

  it('rejects resumption until owning-hive proof is restored', () => {
    const input = validInput();
    Object.assign(input.ownerFreezeChaos.afterOwnerRecovery, {
      owningHiveProof: 'missing',
      protectedEffects: 'resumed',
    });
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'protected effects may resume only after owning-hive proof is restored',
    );
  });
});
