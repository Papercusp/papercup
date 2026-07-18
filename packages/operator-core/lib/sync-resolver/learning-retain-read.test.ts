/**
 * learning-retain-read tests (WI-5412) — the graceful-degradation contract
 * (every leg fails independently, the snapshot always comes back shaped) +
 * the insight-doc frontmatter parse.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseInsightFrontmatter,
  readRecentInsightDocs,
  readRetainExtras,
  type RetainExtrasDeps,
} from './learning-retain-read';

/** A postgres-tag stub: every sql`…` call resolves via the injected handler. */
function sqlStub(handler: (text: string) => unknown[]): never {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(handler(strings.join('?')));
  return fn as never;
}

const okDeps: RetainExtrasDeps = {
  listRubrics: async () => [
    { slug: 'r-old', title: 'Old rubric', status: 'active', updatedAt: '2026-07-01T00:00:00.000Z' },
    { slug: 'r-new', title: 'New rubric', status: 'proposed', updatedAt: '2026-07-18T00:00:00.000Z' },
  ],
  listRecipes: async () => [{ id: 'rec-1', title: 'A recipe', runCount: 4, lastRunAt: '2026-07-17T00:00:00.000Z' }],
  readLensWeights: async () => ({ analogical: 2, reframing: 1 }),
  readInsightDocs: async () => [{ slug: 'a-doc', title: 'A doc', discovered: '2026-07-18' }],
};

describe('readRetainExtras', () => {
  it('returns every leg + counts on the happy path, rubrics newest-updated first', async () => {
    const sql = sqlStub(() => [{ n: 3 }]);
    const snap = await readRetainExtras(sql, 'ws-1', okDeps);
    expect(snap.banked).toEqual({ improvementsFiled7d: 3, plansDrafted7d: 3 });
    expect(snap.lensWeights).toEqual({ analogical: 2, reframing: 1 });
    expect(snap.rubricChanges.map((r) => r.slug)).toEqual(['r-new', 'r-old']);
    expect(snap.insightDocs).toEqual([{ slug: 'a-doc', title: 'A doc', discovered: '2026-07-18' }]);
    expect(snap.recipes).toEqual([{ id: 'rec-1', title: 'A recipe', runCount: 4, lastRunAt: '2026-07-17T00:00:00.000Z' }]);
  });

  it('degrades each failing leg independently — never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    const deps: RetainExtrasDeps = {
      listRubrics: async () => {
        throw new Error('rubrics down');
      },
      listRecipes: async () => {
        throw new Error('recipes down');
      },
      readLensWeights: async () => {
        throw new Error('weights down');
      },
      readInsightDocs: async () => {
        throw new Error('docs down');
      },
    };
    const snap = await readRetainExtras(sql, 'ws-1', deps);
    expect(snap.banked).toEqual({ improvementsFiled7d: null, plansDrafted7d: null });
    expect(snap.lensWeights).toBeNull();
    expect(snap.rubricChanges).toEqual([]);
    expect(snap.insightDocs).toEqual([]);
    expect(snap.recipes).toEqual([]);
    warn.mockRestore();
  });

  it('empty lens weights read as null (none recorded), not {}', async () => {
    const sql = sqlStub(() => [{ n: 0 }]);
    const snap = await readRetainExtras(sql, 'ws-1', { ...okDeps, readLensWeights: async () => ({}) });
    expect(snap.lensWeights).toBeNull();
  });
});

describe('parseInsightFrontmatter', () => {
  it('extracts title + discovered', () => {
    const doc = parseInsightFrontmatter(
      'my-doc',
      '---\ntitle: The runbook title\ndescription: x\ndiscovered: 2026-06-14\n---\nbody',
    );
    expect(doc).toEqual({ slug: 'my-doc', title: 'The runbook title', discovered: '2026-06-14' });
  });

  it('falls back to the slug on a missing title, null on a missing date', () => {
    expect(parseInsightFrontmatter('slug-x', '---\nstatus: active\n---')).toEqual({
      slug: 'slug-x',
      title: 'slug-x',
      discovered: null,
    });
  });
});

describe('readRecentInsightDocs', () => {
  it('lists newest docs by discovered date, capped', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'insights-'));
    const mk = async (name: string, discovered: string, mtimeSec: number) => {
      const p = path.join(dir, name);
      await writeFile(p, `---\ntitle: ${name}\ndiscovered: ${discovered}\n---\n`);
      await utimes(p, mtimeSec, mtimeSec);
    };
    await mk('a.mdx', '2026-07-01', 1_700_000_100);
    await mk('b.mdx', '2026-07-18', 1_700_000_200);
    await mk('c.md', '2026-07-10', 1_700_000_300);
    await writeFile(path.join(dir, 'ignored.txt'), 'not a doc');
    const docs = await readRecentInsightDocs(dir, 2);
    expect(docs.map((d) => d.slug)).toEqual(['b', 'c']);
  });
});
