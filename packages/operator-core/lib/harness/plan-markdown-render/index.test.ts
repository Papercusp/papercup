import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { nodeRenderFs } from './index';
import { runPlanRenderTick, type RenderTarget } from './tick';

/**
 * Real-filesystem coverage for the `nodeRenderFs` adapter (read/write/remove/
 * listMarkdown over an actual temp dir) driving the real tick logic. The data
 * layer is injected (no PG) so this stays unit-tier.
 */
const sha = (s: string): string => createHash('sha1').update(s).digest('hex');
const SETTLE = 15_000;
const NOW = 1_000_000;

describe('nodeRenderFs + runPlanRenderTick (real fs)', () => {
  let root: string;
  let plansDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(os.tmpdir(), 'plan-render-'));
    plansDir = join(root, 'plans');
    archiveDir = join(root, 'plans', 'archive');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function deps(store: Map<string, { content: string; archived: boolean }>, wm: Map<string, string>) {
    return {
      fs: nodeRenderFs,
      plansDir,
      archiveDir,
      nowMs: NOW,
      settleWindowMs: SETTLE,
      listTargets: async (): Promise<RenderTarget[]> =>
        [...store.entries()].map(([slug, p]) => ({
          slug,
          contentHash: sha(p.content),
          archived: p.archived,
          updatedAtMs: NOW - SETTLE,
        })),
      getContent: async (slug: string) => store.get(slug)?.content ?? null,
      hash: sha,
      renderedHashes: wm,
    };
  }

  it('writes a plan file to disk (creating the dir), then is idempotent', async () => {
    const store = new Map([['alpha', { content: '---\ntitle: A\n---\n# Alpha\n', archived: false }]]);
    const wm = new Map<string, string>();
    const r1 = await runPlanRenderTick(deps(store, wm));
    expect(r1.rendered).toEqual(['alpha']);
    const onDisk = await fs.readFile(join(plansDir, 'alpha.md'), 'utf8');
    expect(onDisk).toBe('---\ntitle: A\n---\n# Alpha\n');

    // fresh watermark (simulating a restart) → file already correct → adopted, no rewrite
    const r2 = await runPlanRenderTick(deps(store, new Map()));
    expect(r2.rendered).toEqual([]);
    expect(r2.adopted).toEqual(['alpha']);
  });

  it('relocates active → archive on disk and sweeps the active orphan', async () => {
    const store = new Map([['alpha', { content: 'doc', archived: false }]]);
    const wm = new Map<string, string>();
    await runPlanRenderTick(deps(store, wm));
    expect(await fs.readFile(join(plansDir, 'alpha.md'), 'utf8')).toBe('doc');

    store.set('alpha', { content: 'doc', archived: true });
    // keep beta so the orphan sweep runs (non-empty list)
    store.set('beta', { content: 'b', archived: false });
    const r = await runPlanRenderTick(deps(store, wm));
    expect(r.rendered).toContain('alpha');
    expect(await fs.readFile(join(archiveDir, 'alpha.md'), 'utf8')).toBe('doc');
    await expect(fs.access(join(plansDir, 'alpha.md'))).rejects.toThrow(); // active orphan gone
  });

  it('listMarkdown returns [] for a missing dir and ignores non-.md / nested files', async () => {
    expect(await nodeRenderFs.listMarkdown(join(root, 'nope'))).toEqual([]);
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(join(plansDir, 'a.md'), '1');
    await fs.writeFile(join(plansDir, 'notes.txt'), '2');
    await fs.mkdir(join(plansDir, 'archive'), { recursive: true });
    await fs.writeFile(join(plansDir, 'archive', 'b.md'), '3');
    expect((await nodeRenderFs.listMarkdown(plansDir)).sort()).toEqual(['a.md']);
  });
});
