/**
 * change-ledger-record.test.ts — the PURE control-flow guards of
 * recordBehaviorChange (change-ledger.ts ~117-143), with getFlag + getOrgPg
 * mocked (the integration suite exercises the real PG round-trip).
 *
 * Pins three best-effort invariants the module doc promises ("a ledger write
 * must NEVER block the mutation it records"):
 *   - getFlag false → returns null and NEVER touches getOrgPg (the flag short-
 *     circuits before any pool open, ~119),
 *   - getOrgPg().sql throwing → returns null, NEVER throws (the ~136-142 catch),
 *   - mutationClass defaults per MUTATION_CLASS_FOR_SOURCE[source] (~120) unless
 *     overridden on the call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getOrgPg: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getOrgPg: h.getOrgPg };
});

import { recordBehaviorChange, MUTATION_CLASS_FOR_SOURCE } from './change-ledger';
import type { RecordBehaviorChangeInput } from './change-ledger';

const BASE: RecordBehaviorChangeInput = {
  workspaceId: 'ws-1',
  source: 'gym:accept',
  action: 'set',
  targetKind: 'prompt-override',
  target: 'gym-h/worker',
};

/** A tagged-template `sql` that records the INSERT's interpolated values + returns one id row. */
function fakeSql(captured: { values?: unknown[] }) {
  return (_strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.values = values;
    return Promise.resolve([{ id: 'row-1' }]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordBehaviorChange — flag kill-switch', () => {
  it('getFlag false → returns null WITHOUT opening the org pool', async () => {
    h.getFlag.mockResolvedValue(false);
    const id = await recordBehaviorChange(BASE);
    expect(id).toBeNull();
    expect(h.getOrgPg).not.toHaveBeenCalled();
  });
});

describe('recordBehaviorChange — never throws (best-effort)', () => {
  it('getOrgPg().sql throwing → returns null, never throws', async () => {
    h.getFlag.mockResolvedValue(true);
    h.getOrgPg.mockReturnValue({
      sql: () => {
        throw new Error('pool exhausted');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordBehaviorChange(BASE)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled(); // warned loudly (the EKG-hole notice)
    warn.mockRestore();
  });

  it('getFlag itself rejecting → still returns null (the try wraps the flag read too)', async () => {
    h.getFlag.mockRejectedValue(new Error('flag backend down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordBehaviorChange(BASE)).resolves.toBeNull();
    expect(h.getOrgPg).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('recordBehaviorChange — mutationClass default per source', () => {
  it("defaults mutationClass to MUTATION_CLASS_FOR_SOURCE[source] ('gym' for gym:accept)", async () => {
    h.getFlag.mockResolvedValue(true);
    const cap: { values?: unknown[] } = {};
    h.getOrgPg.mockReturnValue({ sql: fakeSql(cap) });

    const id = await recordBehaviorChange(BASE); // source gym:accept, no mutationClass
    expect(id).toBe('row-1');
    // The INSERT interpolates (workspace, source, mutation_class, …) in order; the
    // class is the 3rd value and must be the source's default, not undefined.
    expect(cap.values?.[2]).toBe(MUTATION_CLASS_FOR_SOURCE['gym:accept']);
    expect(cap.values?.[2]).toBe('gym');
  });

  it('honors an explicit mutationClass override on the call', async () => {
    h.getFlag.mockResolvedValue(true);
    const cap: { values?: unknown[] } = {};
    h.getOrgPg.mockReturnValue({ sql: fakeSql(cap) });

    await recordBehaviorChange({ ...BASE, source: 'manual', mutationClass: 'ablation' });
    expect(cap.values?.[2]).toBe('ablation'); // override wins over MUTATION_CLASS_FOR_SOURCE.manual
  });

  it('returns null when the INSERT deduped (no RETURNING row)', async () => {
    h.getFlag.mockResolvedValue(true);
    h.getOrgPg.mockReturnValue({ sql: () => Promise.resolve([]) }); // ON CONFLICT DO NOTHING
    const id = await recordBehaviorChange(BASE);
    expect(id).toBeNull();
  });
});
