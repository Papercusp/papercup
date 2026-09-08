/**
 * scripts/templates-mirror-sync.mjs — drift-engine + CLI contract tests
 * (template-supply-chain-repair-2026-08-10 P-006 / WI-37775).
 *
 * WHY THIS FILE EXISTS. templates/README.md advertised a mirror drift guard —
 * `npm run mirror:check` that "exits non-zero on ANY drift" — for five weeks
 * while no such script existed in this repo, and the public mirror duly went
 * stale AND pre-rename (it still serves `hive-app-seam/`, so the ops-pots
 * Tier-B MUST pointed at a 404). The script had in fact been written, but it
 * was auto-committed in a side clone that was never pushed, so nothing here
 * ran it and nothing here could see it. A guard nobody executes is
 * indistinguishable from a guard nobody wrote — this test is what makes the
 * restored one real.
 *
 * Every case drives a SYNTHETIC tree under tmpdir. Nothing here mutates the
 * shared checkout: a probe that edits the real tree can be committed by the
 * git-sync sweep even when nothing goes wrong (house rule — "proving a guard
 * is falsifiable, never by mutating the shared tree").
 */
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBundleManifest } from './cupboard/bundle-manifest-io';
// eslint-disable-next-line import/no-relative-packages
import {
  VENDORED,
  buildExpected,
  buildActual,
  computeDrift,
  driftTotal,
} from '../../../scripts/templates-mirror-sync.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/templates-mirror-sync.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOBILE_TEMPLATE_REFS = [
  'papercusp-mobile-base',
  'papercusp-android-shell',
  'papercusp-android-app',
  'papercusp-iphone-shell',
  'papercusp-iphone-app',
] as const;

let tmp: string;

/** A minimal but structurally faithful canonical tree + mirror clone. */
async function makeCanonicalRoot(root: string, vendored: string[] = VENDORED) {
  await fs.mkdir(join(root, 'templates/papercusp-ops-pots'), { recursive: true });
  await fs.writeFile(join(root, 'templates/papercusp-ops-pots/GUIDE.md'), 'guide body\n');
  await fs.writeFile(join(root, 'templates/README.md'), 'templates readme\n');
  await fs.mkdir(join(root, 'rubrics/pot-coordination-health'), { recursive: true });
  await fs.writeFile(join(root, 'rubrics/pot-coordination-health/rubric.json'), '{}\n');
  await fs.mkdir(join(root, 'content-bundles/workspace-host'), { recursive: true });
  await fs.writeFile(join(root, 'content-bundles/workspace-host/bundle.yaml'), 'name: workspace-host\n');
  for (const pkg of vendored) {
    const dir = join(root, 'libs/generic', pkg);
    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.writeFile(join(dir, 'package.json'), `{"name":"@papercusp/${pkg}"}\n`);
    await fs.writeFile(join(dir, 'tsconfig.json'), '{}\n');
    await fs.writeFile(join(dir, 'src/index.ts'), `export const x = '${pkg}';\n`);
    // *.test.ts is deliberately excluded from the vendored surface.
    await fs.writeFile(join(dir, 'src/index.test.ts'), 'should never be vendored\n');
  }
}

/** Materialize a mirror that is perfectly in sync with `root`. */
async function makeMirrorInSync(root: string, mirror: string) {
  const { expected } = await buildExpected(root, VENDORED);
  for (const [rel, src] of expected) {
    const dst = join(mirror, rel);
    await fs.mkdir(join(dst, '..'), { recursive: true });
    await fs.copyFile(src, dst);
  }
  // Mirror-OWNED plumbing the guard must never flag.
  await fs.writeFile(join(mirror, 'package.json'), '{"name":"templates-mirror"}\n');
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mirror-sync-test-'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('VENDORED — the hive->pot rename regression guard', () => {
  it('vendors pot-app-seam and NOT the retired hive-app-seam', () => {
    // The live mirror still carries hive-app-seam/, which is exactly why the
    // ops-pots MUST 404s. If this list ever regresses to the old name the
    // guard would call the stale mirror "in sync" and the 404 would persist.
    expect(VENDORED).toContain('pot-app-seam');
    expect(VENDORED).not.toContain('hive-app-seam');
    expect(VENDORED).toContain('template-kit');
  });
});

describe('official mobile template mirror closure', () => {
  it('maps all five mobile template directories and their published entry files', async () => {
    const { expected, templateIds } = await buildExpected(REPO_ROOT, []);
    for (const ref of MOBILE_TEMPLATE_REFS) {
      expect(templateIds).toContain(ref);
      for (const rel of ['GUIDE.md', 'listing.json', 'template.yaml']) {
        expect(expected.has(`${ref}/${rel}`), `mirror map should publish ${ref}/${rel}`).toBe(true);
      }
    }
  });
});

describe('workspace-host content mirror closure', () => {
  it('maps every official rubric plus the bundle manifest onto the existing public mirror', async () => {
    const { expected, rubricIds } = await buildExpected(REPO_ROOT, []);
    const canonicalRubrics = (await fs.readdir(join(REPO_ROOT, 'rubrics'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(rubricIds).toEqual(canonicalRubrics);
    for (const ref of canonicalRubrics) {
      expect(expected.has(`${ref}/rubric.json`), `mirror map should publish ${ref}/rubric.json`).toBe(true);
    }
    expect(expected.has('bundles/workspace-host/bundle.yaml')).toBe(true);
  });

  it('the official bundle enumerates every blueprint, template, and rubric through existing mirrors', async () => {
    const bundle = parseBundleManifest(
      await fs.readFile(join(REPO_ROOT, 'content-bundles/workspace-host/bundle.yaml'), 'utf8'),
    );
    const dirIds = async (root: string, manifest: string) => {
      const ids: string[] = [];
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (
          await fs.stat(join(root, entry.name, manifest)).then(
            () => true,
            () => false,
          )
        )
          ids.push(entry.name);
      }
      return ids.sort();
    };
    const blueprints = await dirIds(join(REPO_ROOT, 'libs/papercusp/packages/harness/blueprints'), 'blueprint.yaml');
    const templates = await dirIds(join(REPO_ROOT, 'templates'), 'template.yaml');
    const rubrics = await dirIds(join(REPO_ROOT, 'rubrics'), 'rubric.json');
    expect(bundle.blueprints?.map(({ id }) => id).sort()).toEqual(blueprints);
    expect(bundle.templates?.map(({ id }) => id).sort()).toEqual(templates);
    expect(bundle.rubrics?.map(({ id }) => id).sort()).toEqual(rubrics);
    expect(new Set(bundle.blueprints?.map(({ githubUrl }) => githubUrl))).toEqual(
      new Set(['https://github.com/Papercusp/blueprints']),
    );
    expect(new Set([...(bundle.templates ?? []), ...(bundle.rubrics ?? [])].map(({ githubUrl }) => githubUrl))).toEqual(
      new Set(['https://github.com/Papercusp/templates']),
    );
  });
});

describe('drift engine', () => {
  it('reports ZERO drift when the mirror matches the canonical tree', async () => {
    const root = join(tmp, 'sync/root');
    const mirror = join(tmp, 'sync/mirror');
    await makeCanonicalRoot(root);
    await fs.mkdir(mirror, { recursive: true });
    await makeMirrorInSync(root, mirror);

    const { expected } = await buildExpected(root, VENDORED);
    const actual = await buildActual(mirror, VENDORED);
    const drift = await computeDrift(expected, actual, mirror);

    expect(drift).toEqual({ missing: [], changed: [], extraneous: [] });
    expect(driftTotal(drift)).toBe(0);
  });

  it('excludes *.test.ts and mirror-OWNED root plumbing from the synced surface', async () => {
    const root = join(tmp, 'excl/root');
    const mirror = join(tmp, 'excl/mirror');
    await makeCanonicalRoot(root);
    await fs.mkdir(mirror, { recursive: true });
    await makeMirrorInSync(root, mirror);

    const { expected } = await buildExpected(root, VENDORED);
    expect([...expected.keys()]).not.toContain('template-kit/src/index.test.ts');

    // The mirror's own package.json exists but must not read as extraneous.
    const actual = await buildActual(mirror, VENDORED);
    const drift = await computeDrift(expected, actual, mirror);
    expect(drift.extraneous).toEqual([]);
  });

  it('catches all three drift shapes: missing, changed, extraneous', async () => {
    const root = join(tmp, 'drift/root');
    const mirror = join(tmp, 'drift/mirror');
    await makeCanonicalRoot(root);
    await fs.mkdir(mirror, { recursive: true });
    await makeMirrorInSync(root, mirror);

    // (a) a canonical file the mirror lacks
    await fs.writeFile(join(root, 'templates/papercusp-ops-pots/NEW.md'), 'new\n');
    // (b) a file whose bytes differ — the stale-mirror case
    await fs.writeFile(join(mirror, 'README.md'), 'STALE readme\n');
    // (c) a mirror dir with no canonical source — the pre-rename case
    await fs.mkdir(join(mirror, 'papercusp-ops-hives'), { recursive: true });
    await fs.writeFile(join(mirror, 'papercusp-ops-hives/GUIDE.md'), 'old name\n');

    const { expected } = await buildExpected(root, VENDORED);
    const actual = await buildActual(mirror, VENDORED);
    const drift = await computeDrift(expected, actual, mirror);

    expect(drift.missing).toContain('papercusp-ops-pots/NEW.md');
    expect(drift.changed).toContain('README.md');
    expect(drift.extraneous).toContain('papercusp-ops-hives/GUIDE.md');
    expect(driftTotal(drift)).toBe(3);
  });

  it('REFUSES when a vendored package source is missing, instead of reading it as empty', async () => {
    // The dangerous case: an uninitialized submodule makes the canonical
    // source look empty, so every vendored mirror file reads "extraneous" —
    // and --push would DELETE the lot. It must throw exit-code 2, not diff.
    const root = join(tmp, 'uninit/root');
    await makeCanonicalRoot(root, ['template-kit']); // pot-app-seam absent
    await expect(buildExpected(root, VENDORED)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('CLI contract', () => {
  it('exits 2 (not 0, not 1) when the mirror clone is absent', () => {
    const r = spawnSync('node', [SCRIPT, '--mirror', join(tmp, 'no-such-mirror')], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/mirror clone not found/);
    expect(r.stderr).toMatch(/git clone/);
  });

  it('exits 2 on unknown args rather than silently checking', () => {
    const r = spawnSync('node', [SCRIPT, '--bogus-flag'], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown args/);
  });
});

/**
 * A canonical package with NO tsconfig.json — the real shape of
 * libs/generic/pot-app-seam, which ships package.json + src/ and nothing else.
 *
 * buildExpected used to add `<pkg>/tsconfig.json` UNCONDITIONALLY, so this package
 * produced a `missing pot-app-seam/tsconfig.json` that no push could ever satisfy,
 * and `--push` then threw ENOENT out of fs.copyFile part-way through applying.
 *
 * The bug survived because `makeCanonicalRoot` above writes a tsconfig.json for
 * EVERY package — the fixture was more uniform than the tree it stands in for, so
 * the one real package that breaks the assumption was never represented.
 */
describe('a vendored package that ships no tsconfig.json (the pot-app-seam shape)', () => {
  async function makeRootWithoutTsconfig(root: string) {
    await fs.mkdir(join(root, 'templates/papercusp-ops-pots'), { recursive: true });
    await fs.writeFile(join(root, 'templates/papercusp-ops-pots/GUIDE.md'), 'guide body\n');
    await fs.writeFile(join(root, 'templates/README.md'), 'templates readme\n');
    await fs.mkdir(join(root, 'rubrics/pot-coordination-health'), { recursive: true });
    await fs.writeFile(join(root, 'rubrics/pot-coordination-health/rubric.json'), '{}\n');
    await fs.mkdir(join(root, 'content-bundles/workspace-host'), { recursive: true });
    await fs.writeFile(join(root, 'content-bundles/workspace-host/bundle.yaml'), 'name: workspace-host\n');
    const dir = join(root, 'libs/generic/pot-app-seam');
    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.writeFile(join(dir, 'package.json'), '{"name":"@papercusp/pot-app-seam"}\n');
    await fs.writeFile(join(dir, 'src/index.ts'), "export const x = 'seam';\n");
    // deliberately NO tsconfig.json
  }

  it('does not expect a tsconfig.json the canonical package does not have', async () => {
    const root = join(tmp, 'no-tsconfig-root');
    await makeRootWithoutTsconfig(root);
    const { expected } = await buildExpected(root, ['pot-app-seam']);
    expect([...expected.keys()]).toContain('pot-app-seam/package.json');
    expect([...expected.keys()]).toContain('pot-app-seam/src/index.ts');
    expect([...expected.keys()]).not.toContain('pot-app-seam/tsconfig.json');
  });

  it('every expected path resolves to a real file, so --push cannot ENOENT', async () => {
    // The push loop does `fs.copyFile(expected.get(rel), dst)` for every missing or
    // changed path. An expectation pointing at a nonexistent source is therefore not
    // a cosmetic false positive — it aborts the apply mid-way.
    const root = join(tmp, 'no-tsconfig-push');
    await makeRootWithoutTsconfig(root);
    const { expected } = await buildExpected(root, ['pot-app-seam']);
    for (const [rel, src] of expected) {
      await expect(fs.access(src), `expected "${rel}" -> missing source ${src}`).resolves.toBeUndefined();
    }
  });
});
