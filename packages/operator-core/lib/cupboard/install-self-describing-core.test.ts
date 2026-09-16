/**
 * No-clobber controls for every concrete self-describing Cupboard installer.
 *
 * The shared core is consumed by rubric, plan-template, and recipe installers.
 * These tests intentionally use each public kind-specific core entrypoint so a
 * future consumer cannot accidentally bypass the existing-target guard while the
 * generic core tests remain green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalTreeDigest, type TreeDigestEntry } from '@papercusp/artifact-registry';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import type { ContentPinRef } from './install-self-describing-core';
import { installPlanFromCupboardCore } from './install-plan-core';
import { installRecipeFromCupboardCore } from './install-recipe-core';
import { installRubricFromCupboardCore } from './install-rubric-core';

let root: string;
let fixtureRepo: string;
let previousPapercuspHome: string | undefined;

const GITHUB_URL = 'https://github.com/acme/cupboard-library';

function planMarkdown(slug: string, marker: string): string {
  return `---
title: ${marker} plan
slug: ${slug}
status: draft
---

# ${marker} plan

## Phase 1 — build

- **P-001** \`todo\` ${marker} work
`;
}

async function writeRubric(ref: string, marker: string): Promise<void> {
  const dir = join(fixtureRepo, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'rubric.json'),
    `${JSON.stringify(
      {
        rubricId: ref,
        title: `${marker} rubric`,
        characteristic: 'no-clobber',
        description: 'No-clobber regression fixture.',
        ratingScale: ['pass', 'fail'],
        methodRef: ref,
        criteria: [
          {
            key: 'preserve',
            title: 'Preserves existing content',
            model: 'An existing install remains intact.',
            method: 'Install twice and inspect the first result.',
            driftMarkers: 'The second install replaces the first result.',
          },
        ],
        version: '1.0.0',
        source: 'installed',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'rubric' })}\n`, 'utf8');
  await fs.writeFile(join(dir, 'METHOD.md'), `${marker} method\n`, 'utf8');
}

async function writePlan(ref: string, marker: string): Promise<void> {
  const dir = join(fixtureRepo, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'plan.md'), planMarkdown(ref, marker), 'utf8');
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'plan', version: '1.0.0' })}\n`, 'utf8');
}

async function writeRecipe(ref: string, marker: string): Promise<void> {
  const dir = join(fixtureRepo, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'recipe.json'),
    `${JSON.stringify(
      {
        id: ref,
        title: `${marker} recipe`,
        description: 'No-clobber regression fixture.',
        script: `return '${marker}';`,
        toolsUsed: [],
        tags: ['no-clobber'],
        authorityUnresolved: false,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'recipe', version: '1.0.0' })}\n`, 'utf8');
}

/** git's own blob id for `content` — what `git ls-tree` (the real listTreeBlobs) reports,
 *  so the fake digests the same (path, sha) pairs the publisher hashed from GitHub. */
function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Every blob under `<dir>/<ref>/` as `<ref>/`-prefixed repo paths — the shape the
 *  Worker pins at publish (P-001) and the real `git ls-tree -r <sha> -- <ref>` yields. */
async function listFixtureBlobs(dir: string, ref: string): Promise<TreeDigestEntry[]> {
  const base = join(dir, ref);
  if (!existsSync(base)) return [];
  const out: TreeDigestEntry[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
      const nextAbs = join(abs, ent.name);
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(nextAbs, nextRel);
      else out.push({ path: `${ref}/${nextRel}`, sha: gitBlobSha(await fs.readFile(nextAbs)) });
    }
  };
  await walk(base, '');
  return out;
}

function deps() {
  const calls = { cloneRepo: [] as string[][], fetchAtSha: [] as string[][] };
  return {
    calls,
    cloneRepo: async (url: string, dest: string) => {
      calls.cloneRepo.push([url, dest]);
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    // The fixture repo IS "the pinned commit": fetching any sha materialises it as-is.
    // A test that wants a content-address mismatch mutates the fixture AFTER pinning.
    fetchAtSha: async (url: string, dest: string, sha: string) => {
      calls.fetchAtSha.push([url, dest, sha]);
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    listTreeBlobs: async (cloneDir: string, _sha: string, ref: string) => listFixtureBlobs(cloneDir, ref),
    tmpDir: () => root,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-self-describing-core-'));
  fixtureRepo = join(root, 'mirror');
  await fs.mkdir(fixtureRepo, { recursive: true });
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = join(root, 'papercusp');
  _resetPapercuspRootForTests();
});

afterEach(async () => {
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('install-self-describing-core no-clobber contract', () => {
  it('refuses a second rubric install and preserves the existing directory', async () => {
    const ref = 'no-clobber-rubric';
    await writeRubric(ref, 'original');
    await installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps());

    const target = join(process.env.PAPERCUSP_HOME!, 'rubrics', ref);
    await fs.writeFile(join(target, 'local-note.md'), 'keep this local file\n', 'utf8');
    await writeRubric(ref, 'replacement');

    await expect(
      installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps()),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('refusing to overwrite') });
    expect(await fs.readFile(join(target, 'METHOD.md'), 'utf8')).toBe('original method\n');
    expect(await fs.readFile(join(target, 'local-note.md'), 'utf8')).toBe('keep this local file\n');
    expect(await fs.readFile(join(target, 'rubric.json'), 'utf8')).toContain('original rubric');
  });

  it('refuses a second plan-template install and preserves the existing directory', async () => {
    const ref = 'no-clobber-plan';
    await writePlan(ref, 'original');
    await installPlanFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps());

    const target = join(process.env.PAPERCUSP_HOME!, 'plan-templates', ref);
    await fs.writeFile(join(target, 'local-note.md'), 'keep this local file\n', 'utf8');
    await writePlan(ref, 'replacement');

    await expect(
      installPlanFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps()),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('refusing to overwrite') });
    expect(await fs.readFile(join(target, 'plan.md'), 'utf8')).toContain('original plan');
    expect(await fs.readFile(join(target, 'local-note.md'), 'utf8')).toBe('keep this local file\n');
    expect(await fs.readFile(join(target, 'plan.md'), 'utf8')).not.toContain('replacement plan');
  });

  it('refuses a second recipe install and preserves the existing directory', async () => {
    const ref = 'no-clobber-recipe';
    await writeRecipe(ref, 'original');
    await installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps());

    const target = join(process.env.PAPERCUSP_HOME!, 'recipes', ref);
    await fs.writeFile(join(target, 'local-note.md'), 'keep this local file\n', 'utf8');
    await writeRecipe(ref, 'replacement');

    await expect(
      installRecipeFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, deps()),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('refusing to overwrite') });
    expect(JSON.parse(await fs.readFile(join(target, 'recipe.json'), 'utf8'))).toMatchObject({
      title: 'original recipe',
      script: "return 'original';",
    });
    expect(await fs.readFile(join(target, 'local-note.md'), 'utf8')).toBe('keep this local file\n');
    expect(existsSync(join(target, 'replacement-only.md'))).toBe(false);
  });
});

describe('install-self-describing-core content pin (P-002 — install verifies the pin)', () => {
  const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  /** The pin the Worker would have recorded for `<ref>/` as the fixture stands NOW. */
  async function pinFor(ref: string): Promise<{ pin: ContentPinRef; fileCount: number }> {
    const entries = await listFixtureBlobs(fixtureRepo, ref);
    return { pin: { commitSha: COMMIT, treeDigest: await canonicalTreeDigest(entries) }, fileCount: entries.length };
  }

  it('fetches exactly the pinned commit (never the tip), verifies the digest, and reports the verified pin', async () => {
    const ref = 'pinned-rubric';
    await writeRubric(ref, 'pinned');
    const { pin, fileCount } = await pinFor(ref);
    const d = deps();

    const result = await installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin }, d);

    expect(fileCount).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: true, ref, pin: { ...pin, fileCount } });
    expect(d.calls.fetchAtSha).toEqual([[GITHUB_URL, expect.stringContaining(root), COMMIT]]);
    expect(d.calls.cloneRepo).toEqual([]);
    expect(existsSync(join(process.env.PAPERCUSP_HOME!, 'rubrics', ref, 'rubric.json'))).toBe(true);
  });

  it('copies `<ref>/` from the pinned commit even when the branch tip has since moved', async () => {
    const ref = 'moved-tip-rubric';
    await writeRubric(ref, 'pinned');
    const { pin, fileCount } = await pinFor(ref);
    // Freeze "the pinned commit", then move the branch tip past it: a tip clone would
    // now yield the 'moved' bytes, a fetch-by-sha the 'pinned' ones.
    const pinnedCommit = join(root, 'pinned-commit');
    await fs.cp(fixtureRepo, pinnedCommit, { recursive: true });
    await writeRubric(ref, 'moved');
    const d = deps();
    const tipMoved = {
      ...d,
      fetchAtSha: async (url: string, dest: string, sha: string) => {
        d.calls.fetchAtSha.push([url, dest, sha]);
        await fs.cp(sha === COMMIT ? pinnedCommit : fixtureRepo, dest, { recursive: true });
      },
    };

    const result = await installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin }, tipMoved);

    expect(result.pin).toEqual({ ...pin, fileCount });
    expect(d.calls.fetchAtSha).toEqual([[GITHUB_URL, expect.stringContaining(root), COMMIT]]);
    expect(d.calls.cloneRepo).toEqual([]);
    const installed = await fs.readFile(join(process.env.PAPERCUSP_HOME!, 'rubrics', ref, 'rubric.json'), 'utf8');
    expect(installed).toContain('pinned rubric');
    expect(installed).not.toContain('moved rubric');
  });

  it('refuses content-address-mismatch when the fetched tree differs from the pin, and places nothing', async () => {
    const ref = 'tampered-rubric';
    await writeRubric(ref, 'approved');
    const { pin } = await pinFor(ref);
    // The mirror moved after the Worker pinned it — the classic post-approval tamper.
    await writeRubric(ref, 'tampered');

    await expect(
      installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin }, deps()),
    ).rejects.toMatchObject({
      status: 422,
      code: 'content-address-mismatch',
      message: expect.stringContaining('content-address-mismatch'),
    });
    expect(existsSync(join(process.env.PAPERCUSP_HOME!, 'rubrics', ref))).toBe(false);
  });

  it('digests `<ref>/`-prefixed repo paths — a pin computed over bare paths does not verify', async () => {
    const ref = 'prefix-rubric';
    await writeRubric(ref, 'prefixed');
    const bare = (await listFixtureBlobs(fixtureRepo, ref)).map((e) => ({
      ...e,
      path: e.path.slice(ref.length + 1),
    }));
    const pin: ContentPinRef = { commitSha: COMMIT, treeDigest: await canonicalTreeDigest(bare) };

    await expect(
      installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin }, deps()),
    ).rejects.toMatchObject({ status: 422, code: 'content-address-mismatch' });
  });

  it('refuses a malformed pin with 400 malformed_pin BEFORE any fetch', async () => {
    const ref = 'malformed-rubric';
    await writeRubric(ref, 'malformed');
    const { pin } = await pinFor(ref);

    for (const bad of [
      { ...pin, commitSha: 'not-a-git-object-id' },
      { ...pin, treeDigest: 'not-a-sha256' },
      { ...pin, treeDigest: pin.treeDigest.toUpperCase() },
    ]) {
      const d = deps();
      await expect(
        installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin: bad }, d),
      ).rejects.toMatchObject({ status: 400, code: 'malformed_pin' });
      expect(d.calls.fetchAtSha).toEqual([]);
      expect(d.calls.cloneRepo).toEqual([]);
    }
  });

  it('refuses a pinned ref that has no blobs at the pinned commit (422 listing_ref_missing)', async () => {
    const ref = 'ghost-rubric';
    const pin: ContentPinRef = { commitSha: COMMIT, treeDigest: await canonicalTreeDigest([]) };

    await expect(
      installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref, pin }, deps()),
    ).rejects.toMatchObject({ status: 422, code: 'listing_ref_missing' });
  });

  it('applies the same pin contract to every self-describing kind (plan, recipe)', async () => {
    await writePlan('pinned-plan', 'pinned');
    await writeRecipe('pinned-recipe', 'pinned');
    const plan = await pinFor('pinned-plan');
    const recipe = await pinFor('pinned-recipe');

    const planResult = await installPlanFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'pinned-plan', pin: plan.pin },
      deps(),
    );
    const recipeResult = await installRecipeFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'pinned-recipe', pin: recipe.pin },
      deps(),
    );
    expect(planResult.pin).toEqual({ ...plan.pin, fileCount: plan.fileCount });
    expect(recipeResult.pin).toEqual({ ...recipe.pin, fileCount: recipe.fileCount });

    await writeRecipe('pinned-recipe', 'tampered');
    await expect(
      installRecipeFromCupboardCore(
        { githubUrl: GITHUB_URL, listingRef: 'pinned-recipe', targetRef: 'pinned-recipe-2', pin: recipe.pin },
        deps(),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'content-address-mismatch' });
  });

  it('an unpinned install takes the tip-clone path and reports pin: null — never a silent "verified"', async () => {
    const ref = 'unpinned-rubric';
    await writeRubric(ref, 'unpinned');
    const d = deps();

    const result = await installRubricFromCupboardCore({ githubUrl: GITHUB_URL, listingRef: ref }, d);

    expect(result.pin).toBeNull();
    expect(d.calls.cloneRepo).toHaveLength(1);
    expect(d.calls.fetchAtSha).toEqual([]);
  });
});
