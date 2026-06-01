/**
 * resolveHarnessPlansDir — per-harness plans dir resolution
 * (P-009 + P-014 of per-harness-plans-and-docs-2026-05-23).
 *
 * Behavior under test:
 *   - With harnessSlug → uses that harness's path
 *   - papercup → legacy `apps/operator/docs/plans/`
 *   - other harnesses → `docs/plans/` (D-002R convention)
 *   - no harnessSlug → falls through to papercup (D-004R)
 *   - unknown slug → throws
 *   - P-014 runtime guard: papercup.path mismatch with detected root → throws
 *   - P-014 skipped when detection returns null (packaged install)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/harness-registry');
  vi.doUnmock('@/lib/harness/register-papercup');
  vi.doUnmock('@/lib/workspace-registry');
});

function mockRegistry(projects: Array<{ slug: string; path: string }>) {
  vi.doMock('@/lib/harness-registry', () => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects })),
  }));
}

function mockPapercupDetection(detected: string | null) {
  vi.doMock('@/lib/harness/register-papercup', () => ({
    PAPERCUP_HARNESS_SLUG: 'papercup',
    detectPapercupRoot: vi.fn(() => detected),
  }));
}

describe('resolveHarnessPlansDir', () => {
  it('resolves a non-papercup harness to `<path>/docs/plans/`', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/sheets-harness' }]);
    mockPapercupDetection(null);
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir('sheets');
    expect(result.harnessSlug).toBe('sheets');
    expect(result.plans).toBe(path.join('/tmp/sheets-harness', 'docs', 'plans'));
    expect(result.archive).toBe(path.join('/tmp/sheets-harness', 'docs', 'plans', 'archive'));
  });

  it('resolves papercup to legacy `<path>/apps/operator/docs/plans/`', async () => {
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir('papercup');
    expect(result.harnessSlug).toBe('papercup');
    expect(result.plans).toBe(path.join('/home/u/papercup', 'apps', 'operator', 'docs', 'plans'));
    expect(result.archive).toBe(
      path.join('/home/u/papercup', 'apps', 'operator', 'docs', 'plans', 'archive'),
    );
  });

  it('no harnessSlug → falls through to papercup (D-004R)', async () => {
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir();
    expect(result.harnessSlug).toBe('papercup');
    expect(result.plans).toContain(path.join('apps', 'operator', 'docs', 'plans'));
  });

  it('empty string harnessSlug → also falls through to papercup', async () => {
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir('  ');
    expect(result.harnessSlug).toBe('papercup');
  });

  it('no harness: path-matches the primary harness by repo root regardless of slug', async () => {
    // After dogfood Phase 4, the primary slug may be 'papercup-org' instead of
    // 'papercup'. The fallback must find it by path-match, not slug-match.
    mockRegistry([
      { slug: 'sheets', path: '/elsewhere/sheets' },
      { slug: 'papercup-org', path: '/home/u/papercup' },
    ]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir();
    expect(result.harnessSlug).toBe('papercup-org');
    // Renamed-slug still gets the legacy plans-dir because its PATH matches.
    expect(result.plans).toBe(
      path.join('/home/u/papercup', 'apps', 'operator', 'docs', 'plans'),
    );
  });

  it('no harness: throws when no path-match and no papercup slug', async () => {
    mockRegistry([{ slug: 'sheets', path: '/elsewhere/sheets' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir()).rejects.toThrow(/no primary harness findable/);
  });

  it("SU-wildcard harnessSlug='*' → falls through to papercup", async () => {
    // ?superuser=1 dispatch supplies harnessSlug='*' to mean "no
    // specific harness in scope". Without the wildcard handling,
    // plans:get under SU mode fails with "harness '*' not registered".
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir('*');
    expect(result.harnessSlug).toBe('papercup');
    expect(result.plans).toContain(path.join('apps', 'operator', 'docs', 'plans'));
  });

  it('throws when the resolved harness is not in the registry', async () => {
    mockRegistry([{ slug: 'other', path: '/x' }]);
    mockPapercupDetection(null);
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir('does-not-exist')).rejects.toThrow(
      /harness 'does-not-exist' not registered/,
    );
  });

  it("suggests 'papercup' when the unregistered slug is the classic 'papercusp' typo", async () => {
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir('papercusp')).rejects.toThrow(
      /harness 'papercusp' not registered in any workspace\. Did you mean 'papercup'\?/,
    );
  });

  it('resolves a slug registered in a DIFFERENT workspace (cross-workspace fallback)', async () => {
    // The active workspace has no harnesses; 'sheets' lives only in workspace B.
    // resolveProject's cross-workspace scan (delegated to) must find it instead
    // of hard-failing — the asymmetry the explicit-slug branch used to have.
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async (wsId?: string) => ({
        projects: wsId === 'B' ? [{ slug: 'sheets', path: '/b/sheets' }] : [],
      })),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      readRegistry: () => ({ workspaces: [{ id: 'A' }, { id: 'B' }] }),
      activeWorkspaceId: () => 'A',
    }));
    mockPapercupDetection(null);
    const mod = await import('../source');
    const result = await mod.resolveHarnessPlansDir('sheets'); // no pinned workspace → scans
    expect(result.harnessSlug).toBe('sheets');
    expect(result.plans).toContain('b/sheets');
  });

  it('P-014: papercup path mismatch with detection → throws', async () => {
    mockRegistry([{ slug: 'papercup', path: '/wrong/path/papercup' }]);
    mockPapercupDetection('/correct/path/papercup');
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir('papercup')).rejects.toThrow(
      /P-014 runtime guard.*does not match detected repo root/,
    );
  });

  it('P-014: papercup path matches detection → no throw', async () => {
    mockRegistry([{ slug: 'papercup', path: '/home/u/papercup' }]);
    mockPapercupDetection('/home/u/papercup');
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir('papercup')).resolves.toBeDefined();
  });

  it('P-014: skipped when detection returns null (packaged install)', async () => {
    mockRegistry([{ slug: 'papercup', path: '/anywhere/papercup' }]);
    mockPapercupDetection(null);
    const mod = await import('../source');
    await expect(mod.resolveHarnessPlansDir('papercup')).resolves.toBeDefined();
  });

  it('P-014 guard does not fire for non-papercup harnesses', async () => {
    mockRegistry([{ slug: 'sheets', path: '/anywhere/sheets' }]);
    mockPapercupDetection('/totally-different/papercup');
    const mod = await import('../source');
    // Should not throw — guard is papercup-specific
    await expect(mod.resolveHarnessPlansDir('sheets')).resolves.toBeDefined();
  });
});
