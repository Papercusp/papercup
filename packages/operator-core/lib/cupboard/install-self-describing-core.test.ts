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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPapercuspRootForTests } from '../papercusp-root';
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

function deps() {
  return {
    cloneRepo: async (_url: string, dest: string) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
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
