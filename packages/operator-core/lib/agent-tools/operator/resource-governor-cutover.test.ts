/** Focused contract for governor:admission_cutover (P-005 / D-008). */
import { describe, expect, it, vi } from 'vitest';
import type { AdmissionCutoverCensus } from '../../resource-governor/admission-cutover-store';
import tool, {
  admissionCutoverArgsSchema,
  runAdmissionCutoverOperation,
  type AdmissionCutoverDeps,
} from './resource-governor-cutover';

function census(overrides: Partial<AdmissionCutoverCensus> = {}): AdmissionCutoverCensus {
  return {
    cutoverLatched: true,
    cutoverAtMs: 1_000,
    legacyWritersRetired: false,
    legacyWritersRetiredAtMs: null,
    ledgerTotal: 10,
    ledgerActive: 2,
    legacyTotal: 4,
    legacyActive: 1,
    legacyTerminal: 3,
    legacyNewestCreatedMs: 900,
    legacyCreatedAfterCutover: 0,
    legacyCreatedAfterRetirement: 0,
    terminalLegacyDeletionReady: false,
    ...overrides,
  };
}

function deps(before: AdmissionCutoverCensus, after = before) {
  const readCutoverCensus = vi.fn(async () => before);
  const markLegacyWritersRetired = vi.fn(async () => after);
  const value: AdmissionCutoverDeps = {
    workspaceId: () => 'ws-cutover',
    store: () => ({ readCutoverCensus, markLegacyWritersRetired }),
  };
  return { value, readCutoverCensus, markLegacyWritersRetired };
}

describe('governor:admission_cutover', () => {
  it('status reads the canonical store census without mutating retirement', async () => {
    const d = deps(census());
    await expect(runAdmissionCutoverOperation({ op: 'status' }, d.value)).resolves.toMatchObject({
      ok: true,
      op: 'status',
      workspaceId: 'ws-cutover',
      applied: false,
      census: { legacyActive: 1, legacyWritersRetired: false },
      next: expect.stringContaining('every writer plane'),
    });
    expect(d.readCutoverCensus).toHaveBeenCalledOnce();
    expect(d.markLegacyWritersRetired).not.toHaveBeenCalled();
  });

  it('the mutation schema requires both writer-plane attestation and explicit confirmation', () => {
    expect(
      admissionCutoverArgsSchema.safeParse({
        op: 'retire_legacy_writers',
        expectedLegacyNewestCreatedMs: 900,
      }).success,
    ).toBe(false);
    expect(
      admissionCutoverArgsSchema.safeParse({
        op: 'retire_legacy_writers',
        expectedLegacyNewestCreatedMs: 900,
        writerPlanesLedgerOnly: true,
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it('refuses a stale caller watermark before invoking the serialized store mutation', async () => {
    const d = deps(census({ legacyNewestCreatedMs: 901 }));
    await expect(
      runAdmissionCutoverOperation(
        {
          op: 'retire_legacy_writers',
          expectedLegacyNewestCreatedMs: 900,
          writerPlanesLedgerOnly: true,
          confirm: true,
        },
        d.value,
      ),
    ).rejects.toThrow(/stale census.*measured 901/i);
    expect(d.markLegacyWritersRetired).not.toHaveBeenCalled();
  });

  it('delegates the exact watermark to the existing lock/CAS store and returns its verified census', async () => {
    const after = census({
      legacyWritersRetired: true,
      legacyWritersRetiredAtMs: 2_000,
      legacyActive: 0,
      legacyTerminal: 4,
      terminalLegacyDeletionReady: true,
    });
    const d = deps(census(), after);
    await expect(
      runAdmissionCutoverOperation(
        {
          op: 'retire_legacy_writers',
          expectedLegacyNewestCreatedMs: 900,
          writerPlanesLedgerOnly: true,
          confirm: true,
        },
        d.value,
      ),
    ).resolves.toMatchObject({
      applied: true,
      census: { legacyWritersRetired: true, terminalLegacyDeletionReady: true },
      next: expect.stringContaining('migration 1077'),
    });
    expect(d.markLegacyWritersRetired).toHaveBeenCalledWith(900);
  });

  it('is idempotent after another caller has already established retirement', async () => {
    const d = deps(
      census({
        legacyWritersRetired: true,
        legacyWritersRetiredAtMs: 2_000,
        legacyActive: 0,
        terminalLegacyDeletionReady: true,
      }),
    );
    await expect(
      runAdmissionCutoverOperation(
        {
          op: 'retire_legacy_writers',
          expectedLegacyNewestCreatedMs: 900,
          writerPlanesLedgerOnly: true,
          confirm: true,
        },
        d.value,
      ),
    ).resolves.toMatchObject({ applied: false, census: { legacyWritersRetired: true } });
    expect(d.markLegacyWritersRetired).not.toHaveBeenCalled();
  });

  it('gates retirement authority before constructing a live store', async () => {
    await expect(
      tool.handler(
        {
          op: 'retire_legacy_writers',
          expectedLegacyNewestCreatedMs: null,
          writerPlanesLedgerOnly: true,
          confirm: true,
        },
        { role: 'cup' } as never,
      ),
    ).rejects.toThrow(/requires su or an operator-config write role/i);
  });
});
