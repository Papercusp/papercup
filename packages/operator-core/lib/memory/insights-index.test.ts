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
import { isCanonicalDocStatus } from '@papercusp/docs-engine';

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

  it('normalizes legacy status aliases while reading', async () => {
    const current = write('current.mdx', '---\ntitle: Current\ndescription: D\nstatus: current\n---\nbody\n');
    const retired = write('retired.mdx', '---\ntitle: Retired\ndescription: D\nstatus: retired\n---\nbody\n');
    expect((await readInsight(current))?.status).toBe('active');
    expect((await readInsight(retired))?.status).toBe('superseded');
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

  it('bounds a large catalog and leaves a deterministic discovery pointer', () => {
    const entries: InsightEntry[] = Array.from({ length: 500 }, (_, i) => ({
      slug: `insight-${String(i).padStart(3, '0')}`,
      title: `Insight ${i}`,
      description: 'A deliberately long one-line description '.repeat(8),
      status: 'active',
      tags: [],
    }));

    const out = renderInsightsPrelude(entries);

    expect(out).toBeTruthy();
    expect(Buffer.byteLength(out!, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(out).toContain('additional insights omitted from this compact index');
    expect(out).toContain('`docs:search { query: "<topic>" }`');
    expect(out).toContain('then `docs:get`');
    expect(out).toContain('`docs:outline`');
    expect(out).toContain('- insight-000 — A deliberately long one-line description');
    expect(out).not.toContain('- insight-499 —');
  });

  it('uses byte length for UTF-8 entries and never splits a line', () => {
    const entries: InsightEntry[] = Array.from({ length: 500 }, (_, i) => ({
      slug: `utf8-${String(i).padStart(3, '0')}`,
      title: `UTF-8 ${i}`,
      description: 'é'.repeat(500),
      status: 'active',
      tags: [],
    }));

    const out = renderInsightsPrelude(entries)!;

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(out.split('\n').every((line) => !line.endsWith('�'))).toBe(true);
    expect(out).toContain('additional insights omitted from this compact index');
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
    // Sanity: every entry has the expected shape + a recognised VISIBLE status.
    // readInsightsDir drops retired/superseded (isVisible), so what's left must be
    // one of the canonical values from the shared docs-engine vocabulary. The
    // reader normalizes legacy aliases before returning entries, while this check
    // still catches a typo'd status in the corpus.
    for (const e of entries) {
      expect(typeof e.slug).toBe('string');
      expect(typeof e.title).toBe('string');
      // EI-6844: name the offending slug/status in the failure message — a bare
      // `expected false to be true` gave no lead on WHICH of ~380 insight docs
      // had a typo'd status (found: `partially-fixed` on one doc, not in the
      // recognized vocabulary). Fix the doc's frontmatter, not this allowlist.
      expect(
        isCanonicalDocStatus(e.status),
        `insight "${e.slug}" has status "${e.status}", not one of the canonical docs statuses — fix its frontmatter deliberately`,
      ).toBe(true);
    }

    const prelude = renderInsightsPrelude(entries);
    expect(prelude).toBeTruthy();
    expect(prelude!.split('\n').length).toBeGreaterThan(5);
    expect(Buffer.byteLength(prelude!, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });
});
