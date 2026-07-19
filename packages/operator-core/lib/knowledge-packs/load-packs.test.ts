/**
 * migrateInstalledRoot — the boot-time move of the installed-packs root
 * `~/.papercusp/learning-packs/` → `~/.papercusp/knowledge-packs/`
 * (cupboard-public-release-2026-07-12 P-001 / knowledge-packs-2026-07-11 D-001).
 *
 * The rename is HARD (no read-time aliases), so the loader looks ONLY at the new
 * path. An existing install has real Comb-installed packs under the OLD name that
 * the new loader cannot see — without this move they don't error, they silently
 * VANISH. These tests pin the move and its two no-op cases, and exercise the real
 * filesystem against a temp PAPERCUSP_HOME rather than a mock, so a path bug
 * cannot hide behind a stubbed fs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.PAPERCUSP_HOME;
let root: string;

async function loadModule() {
  // Re-import per test: papercuspRoot() caches per-input, and PAPERCUSP_HOME
  // changes between tests.
  return await import('./load-packs');
}

async function seedPack(dir: string, id: string) {
  await fs.mkdir(join(dir, id), { recursive: true });
  await fs.writeFile(join(dir, id, 'manifest.yaml'), `id: ${id}\ntitle: ${id}\nversion: 1.0.0\n`, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pc-kp-root-'));
  process.env.PAPERCUSP_HOME = root;
});

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = ORIGINAL_HOME;
  await rm(root, { recursive: true, force: true });
});

describe('migrateInstalledRoot (P-001 installed-root move)', () => {
  it('MOVES a legacy learning-packs root to knowledge-packs, content intact', async () => {
    const { migrateInstalledRoot, installedKnowledgePacksRoot, legacyInstalledKnowledgePacksRoot } =
      await loadModule();

    await seedPack(legacyInstalledKnowledgePacksRoot(), 'my-pack');

    const r = await migrateInstalledRoot();
    expect(r.moved).toBe(true);

    // The packs are readable at the NEW path — the whole point of the move.
    const manifest = await fs.readFile(
      join(installedKnowledgePacksRoot(), 'my-pack', 'manifest.yaml'),
      'utf8',
    );
    expect(manifest).toContain('id: my-pack');

    // ...and the legacy dir is gone (a MOVE, not a copy — a lingering copy would
    // silently diverge from the live one on the next install/upgrade).
    await expect(fs.stat(legacyInstalledKnowledgePacksRoot())).rejects.toThrow();
  });

  it('is a clean no-op on a fresh install (no legacy dir)', async () => {
    const { migrateInstalledRoot } = await loadModule();
    const r = await migrateInstalledRoot();
    expect(r).toEqual({ moved: false, reason: 'no-legacy' });
  });

  it('is idempotent — a second boot after a completed migration does nothing', async () => {
    const { migrateInstalledRoot, legacyInstalledKnowledgePacksRoot } = await loadModule();
    await seedPack(legacyInstalledKnowledgePacksRoot(), 'my-pack');

    expect((await migrateInstalledRoot()).moved).toBe(true);
    // Every boot calls this; the second one must not throw or re-move.
    expect(await migrateInstalledRoot()).toEqual({ moved: false, reason: 'no-legacy' });
  });

  it('refuses to merge when BOTH roots exist — the new root wins, legacy is left for inspection', async () => {
    // Pathological but reachable (something wrote the new root before the move).
    // Merging could shadow a live installed pack with a stale same-id copy, so we
    // deliberately do NOT merge: the new root is authoritative and the legacy dir
    // is preserved rather than silently clobbering it.
    const { migrateInstalledRoot, installedKnowledgePacksRoot, legacyInstalledKnowledgePacksRoot } =
      await loadModule();

    await seedPack(legacyInstalledKnowledgePacksRoot(), 'stale');
    await seedPack(installedKnowledgePacksRoot(), 'live');

    const r = await migrateInstalledRoot();
    expect(r).toEqual({ moved: false, reason: 'already-migrated' });

    // Nothing was clobbered and nothing was silently merged.
    expect(await fs.stat(join(installedKnowledgePacksRoot(), 'live'))).toBeTruthy();
    expect(await fs.stat(join(legacyInstalledKnowledgePacksRoot(), 'stale'))).toBeTruthy();
    await expect(fs.stat(join(installedKnowledgePacksRoot(), 'stale'))).rejects.toThrow();
  });
});

describe('migrateFleetLessonsToSharedRoot (knowledge-pack-loop-integrity P-005)', () => {
  it('moves a per-workspace fleet-lessons dir into the shared root', async () => {
    const { migrateFleetLessonsToSharedRoot } = await loadModule();
    const fromRoot = join(root, 'ws-installed');
    const toRoot = join(root, 'shared-kp');
    await seedPack(fromRoot, 'fleet-lessons');

    const r = await migrateFleetLessonsToSharedRoot({ fromRoot, toRoot });
    expect(r).toEqual({
      moved: true,
      from: join(fromRoot, 'fleet-lessons'),
      to: join(toRoot, 'fleet-lessons'),
    });
    expect(await fs.stat(join(toRoot, 'fleet-lessons', 'manifest.yaml'))).toBeTruthy();
    await expect(fs.stat(join(fromRoot, 'fleet-lessons'))).rejects.toThrow();
  });

  it('is a clean no-op when there is nothing to migrate', async () => {
    const { migrateFleetLessonsToSharedRoot } = await loadModule();
    const r = await migrateFleetLessonsToSharedRoot({
      fromRoot: join(root, 'empty-installed'),
      toRoot: join(root, 'shared-kp-2'),
    });
    expect(r).toEqual({ moved: false, reason: 'no-legacy' });
  });

  it('never clobbers an existing shared copy — the per-workspace dir is left for inspection', async () => {
    const { migrateFleetLessonsToSharedRoot } = await loadModule();
    const fromRoot = join(root, 'ws-installed-3');
    const toRoot = join(root, 'shared-kp-3');
    await seedPack(fromRoot, 'fleet-lessons');
    await seedPack(toRoot, 'fleet-lessons');

    const r = await migrateFleetLessonsToSharedRoot({ fromRoot, toRoot });
    expect(r).toEqual({ moved: false, reason: 'already-migrated' });
    expect(await fs.stat(join(fromRoot, 'fleet-lessons'))).toBeTruthy();
    expect(await fs.stat(join(toRoot, 'fleet-lessons'))).toBeTruthy();
  });
});
