/**
 * End-to-end proof of the closed install loop
 * (tool-distribution-discovery-2026-06-08 P-003).
 *
 * Composes the REAL pieces — `resolveAndInstallDeps` (the loop),
 * `installPluginFromCupboardCore` (the install core), `assemblePackCatalog`
 * (the catalog), and the REAL first-party `example-tool-pack` fixture — to
 * prove the full cycle:
 *
 *   declared tool `example-tool-pack.word_count` is NOT available
 *     → the loop resolves it to the Cupboard pack listing
 *     → installs the pack (the core git-clones + copies it into global-plugins)
 *     → the re-derived catalog now resolves the tool as AVAILABLE.
 *
 * Only the two true-IO seams are injected: the git clone (copies the real
 * fixture dir) and the Cupboard listing-resolve (a stub). Everything else runs
 * for real. The publish half (a kind:'pack' listing's wire body) is proven in
 * cupboard-publish-pack.test.ts; the prod CF-worker deploy stays owner-gated
 * (D-003), so this proves the loop against an in-memory Cupboard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPluginFromCupboardCore } from './install-plugin-core';
import { assemblePackCatalog, type CupboardUnitRow, type InstalledUnitInput } from './pack-catalog';
import { resolveToolProvider } from '@papercusp/blueprint-distribution';
import { resolveAndInstallDeps, type InstallableUnitRef } from './resolve-and-install';

const FIXTURE_PACK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/plugins/example-tool-pack',
);
const PACK_NAME = 'example-tool-pack';
const PACK_TOOL = 'example-tool-pack.word_count';

let workDir: string;
let globalPluginsDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'loop-e2e-'));
  globalPluginsDir = join(workDir, 'global-plugins');
  await fs.mkdir(globalPluginsDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** Read installed pack manifests from the temp global-plugins dir. */
async function scanInstalled(): Promise<InstalledUnitInput[]> {
  const out: InstalledUnitInput[] = [];
  for (const entry of await fs.readdir(globalPluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const m = JSON.parse(await fs.readFile(join(globalPluginsDir, entry.name, 'papercusp.json'), 'utf8'));
      out.push(m);
    } catch {
      /* not a plugin dir */
    }
  }
  return out;
}

/** Build a catalog from the temp dir: the Cupboard lists the pack until it's installed. */
async function deriveTempCatalog() {
  const installed = await scanInstalled();
  const haveIt = installed.some((m) => m.name === PACK_NAME);
  const cupboardUnits: CupboardUnitRow[] = haveIt
    ? []
    : [{ name: PACK_NAME, kind: 'pack', listingId: 'lst-example', providesTools: [PACK_TOOL, 'example-tool-pack.slugify'] }];
  return assemblePackCatalog({
    installed,
    projectedTools: [],
    legacyCatalogNames: [],
    cupboardUnits,
    cupboardReachable: true,
  });
}

/** The real install core, with the git-clone seam copying the real fixture dir. */
async function installViaCore(unit: InstallableUnitRef) {
  const result = await installPluginFromCupboardCore(
    { githubUrl: `https://github.com/papercusp/${unit.name}`, listingRef: unit.name },
    {
      cloneRepo: async (_url, dest) => {
        await fs.cp(FIXTURE_PACK, dest, { recursive: true });
      },
      globalPluginsDir: () => globalPluginsDir,
      tmpDir: () => workDir,
      grant: async () => {},
      invalidateHost: () => {},
    },
  );
  return { ok: true as const, declaredDeps: result.installableDependencies };
}

describe('install loop — end-to-end with the real example-tool-pack', () => {
  it('the fixture pack exists on disk (sanity)', async () => {
    const manifest = JSON.parse(await fs.readFile(join(FIXTURE_PACK, 'papercusp.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: PACK_NAME, kind: 'pack' });
  });

  it('a declared pack tool is unavailable → loop installs the pack → tool resolves available', async () => {
    // Before: the tool resolves as INSTALLABLE (Cupboard provides it), not available.
    const before = await deriveTempCatalog();
    expect(resolveToolProvider(PACK_TOOL, before.view).status).toBe('installable');

    // Run the loop on a blueprint-style declared dep.
    const res = await resolveAndInstallDeps(
      { tools: [PACK_TOOL] },
      { deriveCatalog: deriveTempCatalog, installUnit: installViaCore },
    );

    expect(res.ok).toBe(true);
    expect(res.installed.map((u) => u.name)).toEqual([PACK_NAME]);
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [] });

    // The real install core physically placed the pack in global-plugins.
    const onDisk = JSON.parse(await fs.readFile(join(globalPluginsDir, PACK_NAME, 'papercusp.json'), 'utf8'));
    expect(onDisk).toMatchObject({ name: PACK_NAME, kind: 'pack' });

    // After: the re-derived catalog resolves the tool as AVAILABLE (installed pack).
    const after = await deriveTempCatalog();
    const resolved = resolveToolProvider(PACK_TOOL, after.view);
    expect(resolved.status).toBe('available');
    expect(resolved.provider).toMatchObject({ kind: 'pack', name: PACK_NAME });
  });

  it('is idempotent — re-running the loop after install does nothing', async () => {
    await resolveAndInstallDeps({ tools: [PACK_TOOL] }, { deriveCatalog: deriveTempCatalog, installUnit: installViaCore });
    const second = await resolveAndInstallDeps(
      { tools: [PACK_TOOL] },
      { deriveCatalog: deriveTempCatalog, installUnit: installViaCore },
    );
    expect(second.ok).toBe(true);
    expect(second.installed).toEqual([]); // already satisfied
    expect(second.rounds).toBe(0);
  });
});
