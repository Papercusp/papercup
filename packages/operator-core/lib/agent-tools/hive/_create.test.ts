/**
 * createHiveHarness (hive-tool-namespace-2026-06-08 P-009, D-005). PG-free: the
 * registry, schema scaffold, trigger materialization and blueprint resolution
 * are mocked; a real tmp dir backs the FS steps. Asserts the two load-bearing
 * claims: (1) the home-harness registry entry is stamped harness_kind:'hive'
 * (the gap harness:create leaves — without it resolveHive can't find the hive),
 * and (2) a failure mid-provision ROLLS BACK fully (no orphan registry entry or
 * dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Entry = { slug: string; path: string; harness_kind?: string; [k: string]: unknown };
let registry: { projects: Entry[] };
let scaffoldImpl: () => Promise<void>;
let tmpParent: string;

beforeEach(() => {
  vi.resetModules();
  registry = { projects: [] };
  scaffoldImpl = async () => {};
  tmpParent = mkdtempSync(join(tmpdir(), 'hive-create-test-'));

  vi.doMock('../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: registry.projects.map((p) => ({ ...p })) }),
    saveHarnessRegistry: async (reg: { projects: Entry[] }) => {
      registry.projects = reg.projects.map((p) => ({ ...p }));
    },
  }));
  vi.doMock('../../scaffold-harness-schema', () => ({ scaffoldHarnessSchema: () => scaffoldImpl() }));
  vi.doMock('../../blueprint/materialize-triggers', () => ({ materializeBlueprintTriggers: async () => [] }));
  vi.doMock('../blueprint/_resolve', () => ({
    resolveAndValidate: () => ({
      ok: true,
      parseError: null,
      blueprint: { id: 'pot', version: '0', knobs: { requiresRepo: false }, dependencies: {} },
    }),
  }));
});

afterEach(() => {
  vi.doUnmock('../../harness-registry');
  vi.doUnmock('../../scaffold-harness-schema');
  vi.doUnmock('../../blueprint/materialize-triggers');
  vi.doUnmock('../blueprint/_resolve');
  try {
    rmSync(tmpParent, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('createHiveHarness', () => {
  it('provisions a home harness stamped harness_kind:hive (no wake)', async () => {
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({ slug: 'test-hive', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(true);
    expect(res.waked).toBe(false);
    const entry = registry.projects.find((p) => p.slug === 'test-hive');
    expect(entry).toBeTruthy();
    expect(entry?.harness_kind).toBe('hive'); // the gap-closer
    expect(existsSync(join(res.path!, '.papercusp', 'blueprint.yaml'))).toBe(true);
  });

  it('rolls back fully when schema provisioning fails — no orphan entry or dir', async () => {
    scaffoldImpl = async () => {
      throw new Error('schema boom');
    };
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({ slug: 'rollback-hive', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('create_failed');
    expect(registry.projects.find((p) => p.slug === 'rollback-hive')).toBeUndefined();
    expect(existsSync(join(tmpParent, 'rollback-hive'))).toBe(false);
  });

  it('refuses a duplicate slug before any side effect', async () => {
    registry.projects.push({ slug: 'dup', path: '/x', harness_kind: 'hive' });
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({ slug: 'dup', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('slug_exists');
    expect(existsSync(join(tmpParent, 'dup'))).toBe(false);
  });
});
