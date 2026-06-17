/**
 * Unit coverage for the GAIA backlog seam (gaia-backlog-support.ts) — the three
 * swaps vs the SWE-bench coding path: the brief builder (gaiaBrief), the
 * clone-equivalent (gaiaCloneTask: mkdtemp + git init + stage attachment), and
 * the answer extraction (extractGaiaAnswer: read answer.txt, never throw).
 *
 * All IO is injected, so this runs with no git / no fs.
 */
import { describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import {
  GAIA_ANSWER_FILE,
  extractGaiaAnswer,
  gaiaBrief,
  gaiaCloneTask,
  type GaiaCloneDeps,
} from './gaia-backlog-support';
import type { BenchTask, TaskCheckout } from './types';

const task = (over: Partial<BenchTask> = {}): BenchTask =>
  ({ problemStatement: 'What is the capital of France?', graderMeta: {}, ...over }) as BenchTask;

// ── gaiaBrief ────────────────────────────────────────────────────────────────

describe('gaiaBrief', () => {
  it('embeds the question + the answer.txt instruction', () => {
    const brief = gaiaBrief(task({ problemStatement: 'How many moons does Mars have?' }));
    expect(brief).toContain('How many moons does Mars have?');
    expect(brief).toContain(GAIA_ANSWER_FILE);
    expect(brief).toMatch(/GAIA benchmark/);
    expect(brief).toMatch(/work_items:complete/);
  });

  it('omits the attachment line when the task has no filePath', () => {
    const brief = gaiaBrief(task({ graderMeta: {} }));
    expect(brief).not.toMatch(/ATTACHED FILE/);
  });

  it('adds the attachment line using fileName when present', () => {
    const brief = gaiaBrief(task({ graderMeta: { filePath: '/data/abc123.xlsx', fileName: 'sales.xlsx' } }));
    expect(brief).toMatch(/ATTACHED FILE staged in your current working directory: "sales\.xlsx"/);
  });

  it('falls back to basename(filePath) for the attachment name when fileName is absent', () => {
    const fp = '/tmp/store/9f8e7d.xlsx';
    const brief = gaiaBrief(task({ graderMeta: { filePath: fp } }));
    expect(brief).toContain(`"${basename(fp)}"`);
  });
});

// ── gaiaCloneTask ────────────────────────────────────────────────────────────

function cloneSpy(over: Partial<GaiaCloneDeps> = {}) {
  const calls = { git: [] as { args: string[]; cwd?: string }[], copied: [] as [string, string][], removed: [] as string[] };
  const deps: GaiaCloneDeps = {
    git: async (args, cwd) => { calls.git.push({ args, cwd }); },
    mkdtemp: async (prefix) => `${prefix}XXXX`,
    rm: async (p) => { calls.removed.push(p); },
    copyFile: async (s, d) => { calls.copied.push([s, d]); },
    ...over,
  };
  return { deps, calls };
}

describe('gaiaCloneTask', () => {
  it('mkdtemps a scratch dir, git-inits it, and returns a repo-less checkout', async () => {
    const { deps, calls } = cloneSpy();
    const checkout = await gaiaCloneTask(task(), deps);
    expect(checkout.repo).toBe('');
    expect(checkout.baseCommit).toBe('');
    expect(checkout.dir).toMatch(/gaia-bench-/);
    expect(calls.git[0]).toMatchObject({ args: ['init', '--quiet'], cwd: checkout.dir });
    expect(calls.copied).toHaveLength(0); // no attachment to stage
  });

  it('stages the attachment into the checkout dir when filePath is set', async () => {
    const { deps, calls } = cloneSpy();
    const checkout = await gaiaCloneTask(task({ graderMeta: { filePath: '/data/q.pdf', fileName: 'q.pdf' } }), deps);
    expect(calls.copied).toHaveLength(1);
    expect(calls.copied[0][0]).toBe('/data/q.pdf');
    expect(calls.copied[0][1]).toContain('q.pdf');
    expect(calls.copied[0][1].startsWith(checkout.dir)).toBe(true);
  });

  it('a failed attachment copy does NOT abort the clone (best-effort staging)', async () => {
    const { deps } = cloneSpy({ copyFile: async () => { throw new Error('EACCES'); } });
    const checkout = await gaiaCloneTask(task({ graderMeta: { filePath: '/data/x.bin' } }), deps);
    expect(checkout.dir).toMatch(/gaia-bench-/); // resolved, not thrown
  });

  it('removes the scratch dir and rethrows when git init fails', async () => {
    const { deps, calls } = cloneSpy({ git: async () => { throw new Error('git not found'); } });
    await expect(gaiaCloneTask(task(), deps)).rejects.toThrow(/git not found/);
    expect(calls.removed).toHaveLength(1); // cleaned up on failure
  });

  it('checkout.cleanup() removes the dir', async () => {
    const { deps, calls } = cloneSpy();
    const checkout = await gaiaCloneTask(task(), deps);
    await checkout.cleanup();
    expect(calls.removed).toContain(checkout.dir);
  });
});

// ── extractGaiaAnswer ────────────────────────────────────────────────────────

describe('extractGaiaAnswer', () => {
  const checkout = { dir: '/scratch/gaia', repo: '', baseCommit: '', cleanup: async () => {} } as TaskCheckout;

  it('reads answer.txt and returns the trimmed body', async () => {
    const out = await extractGaiaAnswer(checkout, { readFile: async () => '  42\n' });
    expect(out).toBe('42');
  });

  it('reads from <dir>/answer.txt', async () => {
    let seen = '';
    await extractGaiaAnswer(checkout, { readFile: async (p) => { seen = p; return 'x'; } });
    expect(seen).toBe(`/scratch/gaia/${GAIA_ANSWER_FILE}`);
  });

  it('returns "" and never throws when answer.txt is absent (a no-answer run, not an infra error)', async () => {
    const out = await extractGaiaAnswer(checkout, { readFile: async () => { throw new Error('ENOENT'); } });
    expect(out).toBe('');
  });
});
