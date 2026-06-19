/**
 * ensure-papercup-hive.test.ts — P-029 (domain-generic-hive-architecture-2026-06-18).
 * Pins the idempotent / best-effort / no-op-when-absent contract of the
 * "ship Papercusp as a shared hive by default" bootstrap helper, with INJECTED
 * deps (no PG / keychain / filesystem).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ensurePapercupHive,
  PAPERCUP_HIVE_SLUG,
  type EnsurePapercupHiveDeps,
} from './ensure-papercup-hive';

const baseDeps = (over: Partial<EnsurePapercupHiveDeps> = {}): EnsurePapercupHiveDeps => ({
  detectRoot: () => '/repo/papercup',
  ensureWorkspace: () => {},
  loadRegistry: async () => ({ projects: [] }),
  createHive: async () => ({ ok: true }),
  ...over,
});

describe('ensurePapercupHive — P-029 ship-as-shared-hive bootstrap', () => {
  it('no papercup root (packaged install) → skipped, no create attempted', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercupHive({}, baseDeps({ detectRoot: () => null, createHive }));
    expect(res.state).toBe('skipped');
    expect(res.slug).toBeNull();
    expect(createHive).not.toHaveBeenCalled();
  });

  it('hive already registered → already-present, idempotent (no create)', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercupHive(
      {},
      baseDeps({
        loadRegistry: async () => ({ projects: [{ slug: PAPERCUP_HIVE_SLUG }] }),
        createHive,
      }),
    );
    expect(res).toEqual({ state: 'already-present', slug: PAPERCUP_HIVE_SLUG });
    expect(createHive).not.toHaveBeenCalled();
  });

  it('absent → creates the generic coding shared hive (newly-created)', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercupHive({}, baseDeps({ createHive }));
    expect(res).toEqual({ state: 'newly-created', slug: PAPERCUP_HIVE_SLUG });
    expect(createHive).toHaveBeenCalledWith({
      slug: PAPERCUP_HIVE_SLUG,
      workspaceId: 'papercusp-workspace',
      createdBy: 'system:dogfood-bootstrap',
    });
  });

  it('create returns slug_exists (race) → already-present, never fails', async () => {
    const res = await ensurePapercupHive(
      {},
      baseDeps({ createHive: async () => ({ ok: false, error: 'slug_exists' }) }),
    );
    expect(res).toEqual({ state: 'already-present', slug: PAPERCUP_HIVE_SLUG });
  });

  it('create fails for another reason → skipped with reason (best-effort, no throw)', async () => {
    const res = await ensurePapercupHive(
      {},
      baseDeps({ createHive: async () => ({ ok: false, error: 'blueprint_invalid', message: 'boom' }) }),
    );
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('blueprint_invalid');
  });

  it('ensureWorkspace throwing → skipped (best-effort), no create', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercupHive(
      {},
      baseDeps({
        ensureWorkspace: () => {
          throw new Error('registry unwritable');
        },
        createHive,
      }),
    );
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('registry unwritable');
    expect(createHive).not.toHaveBeenCalled();
  });

  it('pathOverride forces detection even if detectRoot would return null', async () => {
    const res = await ensurePapercupHive(
      { pathOverride: '/repo/papercup' },
      baseDeps({ detectRoot: () => null }),
    );
    expect(res.state).toBe('newly-created');
  });
});
