import { describe, expect, it } from 'vitest';
import {
  PHASE_F_INPUT_SCHEMA,
  PHASE_F_PLAN_ITEM,
  executePhysicalPhaseFHost,
  validatePhysicalPhaseF,
  type PhysicalPhaseFHostResult,
  type PhysicalPhaseFInput,
} from './physical-drill-phase-f';

const RUN = 'p505-physical-phase-f-0001';
const TOWER = Buffer.alloc(32, 1).toString('base64');
const VM = Buffer.alloc(32, 2).toString('base64');
const START = '2026-08-13T20:00:00.000Z';
const END = '2026-08-13T21:00:00.000Z';

async function validInput(): Promise<PhysicalPhaseFInput> {
  const now = () => '2026-08-13T20:30:00.000Z';
  const tower = await executePhysicalPhaseFHost(
    { hostId: 'tower', deviceKey: TOWER, peerDeviceKey: VM, runId: RUN },
    { now },
  );
  const vm = await executePhysicalPhaseFHost(
    { hostId: 'vm', deviceKey: VM, peerDeviceKey: TOWER, runId: RUN },
    { now },
  );
  return {
    schemaVersion: PHASE_F_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: START, finishedAt: END },
    identities: { towerDeviceKey: TOWER, vmDeviceKey: VM },
    hostResults: [tower, vm],
  };
}

describe('fixed physical Phase F lifecycle adapter', () => {
  it('executes G-9 and G-10 against real temporary bare repos on both host roles', async () => {
    const input = await validInput();
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: { phase: 'F', planItem: PHASE_F_PLAN_ITEM, status: 'complete', complete: true },
    });
    for (const host of input.hostResults) {
      expect(host.productionSurfaces).toEqual(['gcHiveGitRepo', 'checkPublishGuard']);
      expect(host.gc.result.errors).toEqual([]);
      expect(host.guards.clean).toMatchObject({ ok: true, refusalCode: null });
      expect(host.guards.secret).toMatchObject({ ok: false, refusalCode: 'secrets' });
      expect(host.guards.oversized).toMatchObject({ ok: false, refusalCode: 'blob-over-cap' });
      expect(host.temporaryReposRemoved).toBe(true);
    }
  }, 30_000);

  it('rejects a summary-only result that omits one physical host', async () => {
    const input = await validInput();
    input.hostResults = [input.hostResults[0]] as unknown as [PhysicalPhaseFHostResult, PhysicalPhaseFHostResult];
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F must contain exactly one lifecycle result from each physical host');
    expect(verdict.errors).toContain('Phase F is missing the vm physical-host result');
  }, 30_000);

  it('rejects a host result rebound to a non-attesting device', async () => {
    const input = await validInput();
    input.hostResults[1].deviceKey = Buffer.alloc(32, 9).toString('base64');
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F vm result is not bound to the two physical identities');
  }, 30_000);

  it('rejects pruning the always-kept work ref', async () => {
    const input = await validInput();
    input.hostResults[0].gc.afterRefs = input.hostResults[0].gc.afterRefs.filter(
      (ref) => !ref.endsWith('/refs/heads/work'),
    );
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F tower post-GC refs violate retention');
  }, 30_000);

  it('rejects a planted credential reported as admitted', async () => {
    const input = await validInput();
    input.hostResults[0].guards.secret.ok = true;
    input.hostResults[0].guards.secret.refusalCode = null;
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F tower planted credential must be refused as secrets');
  }, 30_000);

  it('rejects an oversized blob without the exact hard-refusal code', async () => {
    const input = await validInput();
    input.hostResults[1].guards.oversized.refusalCode = 'total-over-cap';
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F vm oversized blob must be refused at the fixed boundary');
  }, 30_000);

  it('rejects observations outside the same physical-run window', async () => {
    const input = await validInput();
    input.hostResults[0].observedAt = '2026-08-13T22:00:00.000Z';
    const verdict = validatePhysicalPhaseF(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('Phase F tower observation must fall inside the same-run window');
  }, 30_000);
});
