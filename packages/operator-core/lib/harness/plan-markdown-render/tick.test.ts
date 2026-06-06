import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runPlanRenderTick, type RenderFs, type RenderTarget } from './tick';

const PLANS = '/repo/apps/operator/docs/plans';
const ARCHIVE = '/repo/apps/operator/docs/plans/archive';
const SETTLE = 15_000;
const NOW = 1_000_000;
const sha = (s: string): string => createHash('sha1').update(s).digest('hex');

/** In-memory {@link RenderFs} + write/remove counters. */
class FakeFs implements RenderFs {
  files = new Map<string, string>();
  writes = 0;
  removes = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async readFile(p: string): Promise<string | null> {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content);
    this.writes++;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async remove(p: string): Promise<void> {
    if (this.files.delete(p)) this.removes++;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async listMarkdown(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const p of this.files.keys()) {
      // direct children of `dir` only (not nested), ending in .md
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest.includes('/') && rest.endsWith('.md')) out.push(rest);
    }
    return out;
  }
}

/** A tiny in-memory plan store standing in for harness_plans. */
interface FakePlan {
  content: string;
  archived: boolean;
  updatedAtMs: number;
}

function makeDeps(opts: {
  fs: FakeFs;
  store: Map<string, FakePlan>;
  now?: number;
  renderedHashes?: Map<string, string>;
}) {
  const { fs, store } = opts;
  return {
    fs,
    plansDir: PLANS,
    archiveDir: ARCHIVE,
    nowMs: opts.now ?? NOW,
    settleWindowMs: SETTLE,
    listTargets: async (): Promise<RenderTarget[]> =>
      [...store.entries()].map(([slug, p]) => ({
        slug,
        contentHash: sha(p.content),
        archived: p.archived,
        updatedAtMs: p.updatedAtMs,
      })),
    getContent: async (slug: string): Promise<string | null> => store.get(slug)?.content ?? null,
    hash: sha,
    renderedHashes: opts.renderedHashes ?? new Map<string, string>(),
  };
}

describe('runPlanRenderTick', () => {
  let fs: FakeFs;
  let store: Map<string, FakePlan>;
  let wm: Map<string, string>;
  beforeEach(() => {
    fs = new FakeFs();
    store = new Map();
    wm = new Map();
  });

  it('renders a settled new plan to the active path with exact content', async () => {
    store.set('alpha', { content: '# Alpha\nbody', archived: false, updatedAtMs: NOW - SETTLE });
    const r = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r.rendered).toEqual(['alpha']);
    expect(fs.files.get(join(PLANS, 'alpha.md'))).toBe('# Alpha\nbody');
    expect(fs.writes).toBe(1);
    expect(wm.get('alpha')).toBe(`${sha('# Alpha\nbody')}|x`);
  });

  it('is idempotent — a second tick with no change writes nothing', async () => {
    store.set('alpha', { content: 'X', archived: false, updatedAtMs: NOW - SETTLE });
    await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    fs.writes = 0;
    const r2 = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r2.rendered).toEqual([]);
    expect(r2.adopted).toEqual([]);
    expect(fs.writes).toBe(0);
  });

  it('adopts an already-correct on-disk file on a cold start (no write, no content fetch)', async () => {
    store.set('alpha', { content: 'Y', archived: false, updatedAtMs: NOW - SETTLE });
    fs.files.set(join(PLANS, 'alpha.md'), 'Y'); // mirror already fresh; watermark empty (restart)
    let fetched = 0;
    const deps = makeDeps({ fs, store, renderedHashes: wm });
    const r = await runPlanRenderTick({
      ...deps,
      getContent: async (slug) => {
        fetched++;
        return deps.getContent(slug);
      },
    });
    expect(r.adopted).toEqual(['alpha']);
    expect(r.rendered).toEqual([]);
    expect(fs.writes).toBe(0);
    expect(fetched).toBe(0); // adopted WITHOUT a DB content fetch
    expect(wm.get('alpha')).toBe(`${sha('Y')}|x`);
  });

  it('settle-guards a changed plan written within the window, then renders once settled', async () => {
    store.set('alpha', { content: 'fresh', archived: false, updatedAtMs: NOW - 1_000 }); // 1s ago
    const r1 = await runPlanRenderTick(makeDeps({ fs, store, now: NOW, renderedHashes: wm }));
    expect(r1.skippedUnsettled).toEqual(['alpha']);
    expect(fs.writes).toBe(0);
    // 20s later → settled → renders
    const r2 = await runPlanRenderTick(makeDeps({ fs, store, now: NOW + 20_000, renderedHashes: wm }));
    expect(r2.rendered).toEqual(['alpha']);
    expect(fs.files.get(join(PLANS, 'alpha.md'))).toBe('fresh');
  });

  it('re-renders when content changes', async () => {
    store.set('alpha', { content: 'v1', archived: false, updatedAtMs: NOW - SETTLE });
    await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    store.set('alpha', { content: 'v2', archived: false, updatedAtMs: NOW - SETTLE });
    fs.writes = 0;
    const r = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r.rendered).toEqual(['alpha']);
    expect(fs.files.get(join(PLANS, 'alpha.md'))).toBe('v2');
    expect(fs.writes).toBe(1);
  });

  it('relocates active → archive (writes archive copy, removes the active orphan, keeps watermark)', async () => {
    store.set('alpha', { content: 'doc', archived: false, updatedAtMs: NOW - SETTLE });
    await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(fs.files.has(join(PLANS, 'alpha.md'))).toBe(true);
    // archive it (same content)
    store.set('alpha', { content: 'doc', archived: true, updatedAtMs: NOW - SETTLE });
    const r = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r.rendered).toEqual(['alpha']);
    expect(fs.files.has(join(ARCHIVE, 'alpha.md'))).toBe(true);
    expect(fs.files.has(join(PLANS, 'alpha.md'))).toBe(false); // active orphan swept
    expect(wm.get('alpha')).toBe(`${sha('doc')}|a`); // watermark relocated, not dropped
  });

  it('removes the file + watermark for a plan that no longer exists (sweep still has live plans)', async () => {
    store.set('alpha', { content: 'doc', archived: false, updatedAtMs: NOW - SETTLE });
    store.set('beta', { content: 'doc2', archived: false, updatedAtMs: NOW - SETTLE });
    await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(wm.has('alpha')).toBe(true);
    store.delete('alpha'); // alpha gone; beta remains so the list is non-empty
    const r = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r.removedOrphans).toEqual([join('active', 'alpha.md')]);
    expect(fs.files.has(join(PLANS, 'alpha.md'))).toBe(false);
    expect(fs.files.has(join(PLANS, 'beta.md'))).toBe(true); // live plan untouched
    expect(wm.has('alpha')).toBe(false);
    expect(wm.has('beta')).toBe(true);
  });

  it('NEVER mass-deletes on a transient empty target list', async () => {
    fs.files.set(join(PLANS, 'alpha.md'), 'doc');
    fs.files.set(join(ARCHIVE, 'beta.md'), 'doc2');
    const r = await runPlanRenderTick(makeDeps({ fs, store /* empty */, renderedHashes: wm }));
    expect(r.orphanSweepSkipped).toBe(true);
    expect(r.removedOrphans).toEqual([]);
    expect(fs.files.size).toBe(2); // nothing deleted
  });

  it('preserves a README.md in the mirror dir (not a plan orphan)', async () => {
    store.set('alpha', { content: 'doc', archived: false, updatedAtMs: NOW - SETTLE });
    fs.files.set(join(PLANS, 'README.md'), '# generated');
    const r = await runPlanRenderTick(makeDeps({ fs, store, renderedHashes: wm }));
    expect(r.removedOrphans).toEqual([]);
    expect(fs.files.has(join(PLANS, 'README.md'))).toBe(true);
  });

  it('skips a plan whose content vanished between list and fetch (no crash, no write)', async () => {
    store.set('ghost', { content: 'doc', archived: false, updatedAtMs: NOW - SETTLE });
    const deps = makeDeps({ fs, store, renderedHashes: wm });
    const r = await runPlanRenderTick({ ...deps, getContent: async () => null });
    expect(r.rendered).toEqual([]);
    expect(fs.writes).toBe(0);
  });
});
