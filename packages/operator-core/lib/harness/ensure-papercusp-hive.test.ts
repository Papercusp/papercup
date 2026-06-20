/**
 * ensure-papercusp-hive.test.ts — P-029 (domain-generic-hive-architecture-2026-06-18).
 * Pins the idempotent / best-effort / no-op-when-absent contract of the
 * "ship Papercusp as a shared hive by default" bootstrap helper, with INJECTED
 * deps (no PG / keychain / filesystem). Slug `papercusp` (papercup→papercusp rebrand).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ensurePapercuspHive,
  PAPERCUSP_HIVE_SLUG,
  type EnsurePapercuspHiveDeps,
} from './ensure-papercusp-hive';

const baseDeps = (over: Partial<EnsurePapercuspHiveDeps> = {}): EnsurePapercuspHiveDeps => ({
  detectRoot: () => '/repo/papercup',
  ensureWorkspace: () => {},
  loadRegistry: async () => ({ projects: [] }),
  createHive: async () => ({ ok: true }),
  ...over,
});

describe('ensurePapercuspHive — P-029 ship-as-shared-hive bootstrap', () => {
  it('slug is the rebranded `papercusp` (not legacy papercup-hive)', () => {
    expect(PAPERCUSP_HIVE_SLUG).toBe('papercusp');
  });

  it('no papercup root (packaged install) → skipped, no create attempted', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercuspHive({}, baseDeps({ detectRoot: () => null, createHive }));
    expect(res.state).toBe('skipped');
    expect(res.slug).toBeNull();
    expect(createHive).not.toHaveBeenCalled();
  });

  it('hive already registered → already-present, idempotent (no create)', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercuspHive(
      {},
      baseDeps({
        loadRegistry: async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG }] }),
        createHive,
      }),
    );
    expect(res).toEqual({ state: 'already-present', slug: PAPERCUSP_HIVE_SLUG });
    expect(createHive).not.toHaveBeenCalled();
  });

  it('absent → creates the generic coding shared hive (newly-created)', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercuspHive({}, baseDeps({ createHive }));
    expect(res).toEqual({ state: 'newly-created', slug: PAPERCUSP_HIVE_SLUG });
    expect(createHive).toHaveBeenCalledWith({
      slug: PAPERCUSP_HIVE_SLUG,
      workspaceId: 'papercusp-workspace',
      createdBy: 'system:dogfood-bootstrap',
      // B-merge (owner-directed papercup→papercusp): papercusp links the detected repo
      // root in place as its own repo (existingPath), so it is ONE entry = the hive+repo.
      existingPath: '/repo/papercup',
    });
  });

  it('create returns slug_exists (race) → already-present, never fails', async () => {
    const res = await ensurePapercuspHive(
      {},
      baseDeps({ createHive: async () => ({ ok: false, error: 'slug_exists' }) }),
    );
    expect(res).toEqual({ state: 'already-present', slug: PAPERCUSP_HIVE_SLUG });
  });

  it('create fails for another reason → skipped with reason (best-effort, no throw)', async () => {
    const res = await ensurePapercuspHive(
      {},
      baseDeps({ createHive: async () => ({ ok: false, error: 'blueprint_invalid', message: 'boom' }) }),
    );
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('blueprint_invalid');
  });

  it('ensureWorkspace throwing → skipped (best-effort), no create', async () => {
    const createHive = vi.fn(async () => ({ ok: true }));
    const res = await ensurePapercuspHive(
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
    const res = await ensurePapercuspHive(
      { pathOverride: '/repo/papercup' },
      baseDeps({ detectRoot: () => null }),
    );
    expect(res.state).toBe('newly-created');
  });
});
