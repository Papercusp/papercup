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
let ensureCalls: Array<[string, string]>;
let deleteHiveCalls: Array<[string, string]>;
let provisionCalls: Array<{ workspaceId: string; hiveSlug: string }>;

beforeEach(() => {
  vi.resetModules();
  registry = { projects: [] };
  scaffoldImpl = async () => {};
  tmpParent = mkdtempSync(join(tmpdir(), 'hive-create-test-'));
  ensureCalls = [];
  deleteHiveCalls = [];
  provisionCalls = [];

  vi.doMock('../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: registry.projects.map((p) => ({ ...p })) }),
    saveHarnessRegistry: async (reg: { projects: Entry[] }) => {
      registry.projects = reg.projects.map((p) => ({ ...p }));
    },
  }));
  vi.doMock('../../scaffold-harness-schema', () => ({
    scaffoldHarnessSchema: () => scaffoldImpl(),
    dropHarnessSchema: async () => {},
  }));
  vi.doMock('../../blueprint/materialize-triggers', () => ({ materializeBlueprintTriggers: async () => [] }));
  vi.doMock('../blueprint/_resolve', () => ({
    // Kind-aware so the P-019 not-a-hive guard can be exercised: the chosen blueprint
    // id rides `childObj.extends`; `research` resolves to kind:'harness', everything
    // else (the default hive / generic-hive) to kind:'hive'.
    resolveAndValidate: (childObj: { extends?: string }) => ({
      ok: true,
      parseError: null,
      blueprint: {
        id: 'hive',
        kind: childObj?.extends === 'research' ? 'harness' : 'hive',
        version: '0',
        knobs: { requiresRepo: false },
        dependencies: {},
      },
    }),
  }));
  // The first-class Hive identity mint (PG + keychain) is mocked — this test is
  // PG-free; the keypair->store->topic seam is covered by its own integration test.
  vi.doMock('../../hive-identity', () => ({
    ensureHiveIdentity: async (ws: string, slug: string) => {
      ensureCalls.push([ws, slug]);
      return { record: {}, created: true };
    },
  }));
  vi.doMock('../../hive-store', () => ({
    deleteHive: async (ws: string, slug: string) => {
      deleteHiveCalls.push([ws, slug]);
      return true;
    },
  }));
  // learning-packs P-005: the seed step is mocked (its own behavior is pinned in
  // lib/learning-packs/seed.test.ts); the flag gate resolves ON deterministically.
  vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
  vi.doMock('../../learning-packs/load-packs', () => ({
    loadLearningPack: async () => ({
      pack: {
        manifest: { id: 'papercusp-default', title: 'T', description: 'd', version: '1.0.0' },
        items: [{ id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'a' }],
      },
      source: 'builtin',
      warnings: [],
    }),
  }));
  vi.doMock('../../learning-packs/seed', () => ({
    shapesFromDetection: () => undefined,
    seedPackIntoHive: async () => ({
      ok: true,
      packId: 'papercusp-default',
      packVersion: '1.0.0',
      seeded: 1,
      ids: ['mem-1'],
      skippedByShape: 0,
      failed: 0,
      undo: async () => {},
    }),
  }));
  // P-020: the per-hive learning-loop provision step is mocked (its own behavior is
  // pinned in lib/hive/provision-learning-loop.test.ts). It ignores the sql it's
  // handed, so the real getOrgPg flows through untouched (the wake-defaults step
  // shares that pool). The flag gate resolves ON via the @papercusp/flags/server
  // mock above.
  vi.doMock('../../hive/provision-learning-loop', () => ({
    provisionHiveLearningLoop: async (input: { workspaceId: string; hiveSlug: string }) => {
      provisionCalls.push({ workspaceId: input.workspaceId, hiveSlug: input.hiveSlug });
      return { ok: true, hiveSlug: input.hiveSlug, gymAutoloop: true, scoutRoutine: true, scoutMaxCostUsd: 0.5, undo: async () => {} };
    },
  }));
});

afterEach(() => {
  vi.doUnmock('../../harness-registry');
  vi.doUnmock('../../scaffold-harness-schema');
  vi.doUnmock('../../blueprint/materialize-triggers');
  vi.doUnmock('../blueprint/_resolve');
  vi.doUnmock('../../hive-identity');
  vi.doUnmock('../../hive-store');
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../learning-packs/load-packs');
  vi.doUnmock('../../learning-packs/seed');
  vi.doUnmock('../../hive/provision-learning-loop');
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
    // The Hive's first-class identity (Ed25519 keypair + entity row) is minted as
    // part of create (shared-hive-federation P-002).
    expect(ensureCalls).toEqual([['default', 'test-hive']]);
    // learning-packs P-005: the default pack seeded into the new hive's pool.
    expect(res.seededLearnings).toEqual({ packId: 'papercusp-default', packVersion: '1.0.0', count: 1 });
    // per-hive-learning-loops P-020: the per-hive loop is provisioned, keyed to the
    // hive's OWN slug, and reported in the result.
    expect(provisionCalls).toEqual([{ workspaceId: 'default', hiveSlug: 'test-hive' }]);
    expect(res.provisionedLoop).toEqual({ gymAutoloop: true, scoutRoutine: true, scoutMaxCostUsd: 0.5 });
  });

  it('provisionLearningLoop:false skips the per-hive loop entirely', async () => {
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({
      slug: 'no-loop-hive',
      workspaceId: 'default',
      parentDir: tmpParent,
      provisionLearningLoop: false,
    });
    expect(res.ok).toBe(true);
    expect(provisionCalls).toEqual([]);
    expect(res.provisionedLoop).toBeUndefined();
  });

  it('learningPack: null skips seeding entirely', async () => {
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({
      slug: 'no-seed-hive',
      workspaceId: 'default',
      parentDir: tmpParent,
      learningPack: null,
    });
    expect(res.ok).toBe(true);
    expect(res.seededLearnings).toBeUndefined();
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
    // Identity was minted (step 2b) then rolled back (deleteHive) when the later
    // schema step failed — no orphan hives row.
    expect(ensureCalls).toEqual([['default', 'rollback-hive']]);
    expect(deleteHiveCalls).toEqual([['default', 'rollback-hive']]);
  });

  it('refuses a duplicate slug before any side effect', async () => {
    registry.projects.push({ slug: 'dup', path: '/x', harness_kind: 'hive' });
    const { createHiveHarness } = await import('./_create');
    const res = await createHiveHarness({ slug: 'dup', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('slug_exists');
    expect(existsSync(join(tmpParent, 'dup'))).toBe(false);
    expect(ensureCalls).toEqual([]); // no identity minted on the early reject
  });

  it('rejects a non-hive blueprint (kind:harness) + lists the hive templates, before any side effect (P-019)', async () => {
    const { createHiveHarness } = await import('./_create');
    // `research` is a real built-in blueprint but kind:'harness' — a hive needs kind:'hive'.
    const res = await createHiveHarness({
      slug: 'wrong-kind',
      workspaceId: 'default',
      parentDir: tmpParent,
      blueprintId: 'research',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_a_hive_blueprint');
    expect(res.message).toMatch(/generic-hive/); // surfaces the available hive templates
    expect(existsSync(join(tmpParent, 'wrong-kind'))).toBe(false); // no side effect
    expect(ensureCalls).toEqual([]); // rejected before identity mint
  });
});
