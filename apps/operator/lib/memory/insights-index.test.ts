import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseFrontmatter,
  readInsight,
  readInsightsDir,
  renderInsightsPrelude,
  type InsightEntry,
} from './insights-index';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-index-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('parseFrontmatter', () => {
  it('parses string scalars', () => {
    const fm = parseFrontmatter('---\ntitle: My Title\ndescription: One sentence.\n---\nbody\n');
    expect(fm).toEqual({ title: 'My Title', description: 'One sentence.' });
  });

  it('strips quoted strings', () => {
    const fm = parseFrontmatter('---\ntitle: "Quoted title"\nstatus: \'active\'\n---\nbody\n');
    expect(fm).toEqual({ title: 'Quoted title', status: 'active' });
  });

  it('parses inline array of tags', () => {
    const fm = parseFrontmatter('---\ntags: [postgres, sse, sync]\n---\nbody\n');
    expect(fm).toEqual({ tags: ['postgres', 'sse', 'sync'] });
  });

  it('skips nested fields (sidebar: with two-space indent children)', () => {
    const fm = parseFrontmatter(
      '---\ntitle: T\nsidebar:\n  order: 13\n---\nbody\n',
    );
    expect(fm).toEqual({ title: 'T', sidebar: '' });
  });

  it('returns null when missing frontmatter', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
    expect(parseFrontmatter('---\nnever closed')).toBeNull();
  });
});

describe('readInsight', () => {
  it('reads a valid insight', async () => {
    const fp = write('foo.mdx', '---\ntitle: Foo Title\ndescription: A short desc.\nstatus: active\ntags: [a, b]\n---\nbody\n');
    const r = await readInsight(fp);
    expect(r).toEqual({
      slug: 'foo',
      title: 'Foo Title',
      description: 'A short desc.',
      status: 'active',
      tags: ['a', 'b'],
    });
  });

  it('skips index.mdx', async () => {
    const fp = write('index.mdx', '---\ntitle: Section landing\n---\nbody\n');
    expect(await readInsight(fp)).toBeNull();
  });

  it('returns null when title missing', async () => {
    const fp = write('no-title.mdx', '---\ndescription: just a desc\n---\nbody\n');
    expect(await readInsight(fp)).toBeNull();
  });

  it('defaults missing status to active', async () => {
    const fp = write('a.mdx', '---\ntitle: T\ndescription: D\n---\nbody\n');
    const r = await readInsight(fp);
    expect(r?.status).toBe('active');
  });
});

describe('readInsightsDir', () => {
  it('lists all valid insights, filters retired/superseded, sorts alpha', async () => {
    write('zz.mdx', '---\ntitle: Z\ndescription: dz\n---\n');
    write('aa.mdx', '---\ntitle: A\ndescription: da\n---\n');
    write('mm.mdx', '---\ntitle: M\ndescription: dm\nstatus: retired\n---\n');
    write('nn.mdx', '---\ntitle: N\ndescription: dn\nstatus: superseded\n---\n');
    write('index.mdx', '---\ntitle: landing\n---\n');
    write('not-mdx.txt', 'ignored');

    const entries = await readInsightsDir(tmpRoot);
    expect(entries.map((e) => e.slug)).toEqual(['aa', 'zz']);
  });

  it('returns [] when directory missing', async () => {
    expect(await readInsightsDir(path.join(tmpRoot, 'no-such-dir'))).toEqual([]);
  });
});

describe('renderInsightsPrelude', () => {
  it('renders compact list with first-sentence descriptions', () => {
    const entries: InsightEntry[] = [
      { slug: 'foo', title: 'Foo', description: 'First sentence. Second sentence.', status: 'active', tags: [] },
      { slug: 'bar', title: 'Bar', description: 'Only one.', status: 'active', tags: [] },
    ];
    const out = renderInsightsPrelude(entries);
    expect(out).toContain('## Agent insights');
    expect(out).toContain("docs:get { slugs: ['<slug>'] }");
    expect(out).toContain('- foo — First sentence.');
    expect(out).toContain('- bar — Only one.');
    // does NOT include second sentence
    expect(out).not.toContain('Second sentence');
  });

  it('falls back to title when description is empty', () => {
    const entries: InsightEntry[] = [
      { slug: 'x', title: 'My Title', description: '', status: 'active', tags: [] },
    ];
    expect(renderInsightsPrelude(entries)).toContain('- x — My Title');
  });

  it('returns null for empty list', () => {
    expect(renderInsightsPrelude([])).toBeNull();
  });
});

describe('integration — read real insights dir', () => {
  it('reads the actual papercup agent-insights/ dir', async () => {
    // Locate the real apps/operator-docs/src/content/docs/agent-insights/ dir
    // by walking up from this test file. Skip gracefully if not found
    // (e.g. when running this test in an extracted slice of the repo).
    let cur = __dirname;
    let real: string | null = null;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(
        cur,
        'apps',
        'operator-docs',
        'src',
        'content',
        'docs',
        'agent-insights',
      );
      try {
        if (fs.statSync(candidate).isDirectory()) {
          real = candidate;
          break;
        }
      } catch { /* keep walking */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    if (!real) {
      // dir not findable from this checkout layout — skip
      return;
    }
    const entries = await readInsightsDir(real);
    expect(entries.length).toBeGreaterThan(0);
    // Sanity: every entry has the expected shape
    for (const e of entries) {
      expect(typeof e.slug).toBe('string');
      expect(typeof e.title).toBe('string');
      expect(['active'].includes(e.status) || ['draft', 'review', 'wip'].includes(e.status)).toBe(true);
    }

    const prelude = renderInsightsPrelude(entries);
    expect(prelude).toBeTruthy();
    expect(prelude!.split('\n').length).toBeGreaterThan(5);
  });
});
