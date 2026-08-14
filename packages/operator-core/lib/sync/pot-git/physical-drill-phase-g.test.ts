import { beforeAll, describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import {
  PHASE_G_INPUT_SCHEMA,
  PHASE_G_PLAN_ITEM,
  executePhysicalPhaseG,
  validatePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';

const RUN = 'p505-physical-phase-g-0001';
const START = '2026-08-13T20:00:00.000Z';
const OBSERVED = '2026-08-13T20:30:00.000Z';
const END = '2026-08-13T21:00:00.000Z';

let baseline: PhysicalPhaseGInput;

beforeAll(async () => {
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const result = await executePhysicalPhaseG(
    { runId: RUN, towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    { now: () => OBSERVED },
  );
  baseline = {
    schemaVersion: PHASE_G_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: START, finishedAt: END },
    identities: { towerDeviceKey: tower.pubkeyBase64, vmDeviceKey: vm.pubkeyBase64 },
    result,
  };
}, 60_000);

function validInput(): PhysicalPhaseGInput {
  return structuredClone(baseline);
}

describe('fixed physical Phase G chaos adapter', () => {
  it('executes all four production-seam records and validates the detailed result', () => {
    const input = validInput();
    const verdict = validatePhysicalPhaseG(input);
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: { phase: 'G', planItem: PHASE_G_PLAN_ITEM, status: 'complete', complete: true },
    });
    expect(input.result.authorityFence.staleAcceptance).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    expect(input.result.retryPersistence).toMatchObject({
      beforeRetry: 41,
      duringUnknownSha: 41,
      unknownShaReason: 'unknown-sha',
      duringUngrantedEpoch: 41,
      ungrantedEpochReason: 'ungranted-epoch',
      afterAccept: 42,
      acceptedCount: 1,
    });
    expect(input.result.pgAndPushRecovery.pushAttempts.length).toBeGreaterThanOrEqual(2);
    expect(input.result.restartRoundTrip.oldCoreKey).not.toBe(input.result.restartRoundTrip.newCoreKey);
  });

  it('keeps real physical attesters separate from all internally generated signers', () => {
    const input = validInput();
    const physical = new Set([input.identities.towerDeviceKey, input.identities.vmDeviceKey]);
    expect(input.result.physicalExecutionBinding.provenance).toBe('outer-manifest-host-receipts');
    expect(input.result.protocolIdentities.provenance).toBe('ephemeral-adapter-keypairs');
    expect([
      input.result.protocolIdentities.oldAuthority,
      input.result.protocolIdentities.survivor,
      input.result.protocolIdentities.stableRestartIdentity,
    ].every((key) => !physical.has(key))).toBe(true);
  });

  it('rejects rebinding an ephemeral authority signature to a physical host', () => {
    const input = validInput();
    input.result.protocolIdentities.oldAuthority = input.identities.towerDeviceKey;
    const verdict = validatePhysicalPhaseG(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase G ephemeral protocol signers must not be represented as physical hosts');
  });

  it('rejects consuming a retryable row before its missing evidence arrives', () => {
    const input = validInput();
    input.result.retryPersistence.duringUnknownSha = 42;
    const verdict = validatePhysicalPhaseG(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase G retryable unknown-sha must hold the fed-event cursor');
  });

  it('rejects a recovery record that used a force push', () => {
    const input = validInput();
    input.result.pgAndPushRecovery.noForcePush = false;
    const verdict = validatePhysicalPhaseG(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase G non-FF recovery must never use force push');
  });

  it('rejects restart evidence that reuses the old Hypercore key', () => {
    const input = validInput();
    input.result.restartRoundTrip.newCoreKey = input.result.restartRoundTrip.oldCoreKey;
    const verdict = validatePhysicalPhaseG(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase G restart must create a different Hypercore key');
  });
});
