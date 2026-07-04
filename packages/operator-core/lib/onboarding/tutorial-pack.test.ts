import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadTutorialPack,
  packIndexMarkdown,
  parseTutorialSection,
  resolvePackRoot,
  type TutorialSection,
} from './tutorial-pack';

const SAMPLE = `---
id: ch9-01-sample
chapter: 9
order: 1
title: A sample, with — punctuation
docSlugs: system/repo-conventions, agent-policies
---

## Brief

Two short sentences. That is all.

## Details

A fuller paragraph.

Another paragraph.
`;

describe('parseTutorialSection', () => {
  it('parses frontmatter + Brief + Details', () => {
    const s = parseTutorialSection(SAMPLE, '/tmp/s.md');
    expect(s).toMatchObject({
      id: 'ch9-01-sample',
      chapter: 9,
      order: 1,
      title: 'A sample, with — punctuation',
      docSlugs: ['system/repo-conventions', 'agent-policies'],
      file: '/tmp/s.md',
    });
    expect(s.brief).toBe('Two short sentences. That is all.');
    expect(s.details).toBe('A fuller paragraph.\n\nAnother paragraph.');
  });

  it('tolerates a missing Details section and empty docSlugs', () => {
    const s = parseTutorialSection(
      '---\nid: x\nchapter: 1\norder: 2\ntitle: T\n---\n\n## Brief\n\nHi.\n',
    );
    expect(s.details).toBeNull();
    expect(s.docSlugs).toEqual([]);
  });

  it.each([
    ['no frontmatter', '## Brief\n\nHi.\n', /missing frontmatter/],
    ['unterminated frontmatter', '---\nid: x\n\n## Brief\nHi.\n', /unterminated/],
    ['missing required key', '---\nid: x\nchapter: 1\ntitle: T\n---\n## Brief\nHi.', /missing order/],
    ['non-integer chapter', '---\nid: x\nchapter: one\norder: 1\ntitle: T\n---\n## Brief\nHi.', /integers/],
    ['missing Brief', '---\nid: x\nchapter: 1\norder: 1\ntitle: T\n---\n## Details\nD.', /## Brief/],
    ['bad meta line', '---\nid: x\nchapter: 1\norder: 1\ntitle: T\nnot a kv\n---\n## Brief\nHi.', /bad frontmatter line/],
  ])('throws (with the file path) on %s', (_name, raw, re) => {
    expect(() => parseTutorialSection(raw, '/tmp/bad.md')).toThrow(re);
    expect(() => parseTutorialSection(raw, '/tmp/bad.md')).toThrow(/\/tmp\/bad\.md/);
  });
});

describe('resolvePackRoot', () => {
  it('walks the fallback chain and returns null when absent', () => {
    const hit = '/srv/operator/prompts/tutorial';
    expect(resolvePackRoot('/srv/operator', (p) => p === hit)).toBe(hit);
    expect(resolvePackRoot('/nowhere', () => false)).toBeNull();
  });
});

describe('packIndexMarkdown', () => {
  const sec = (over: Partial<TutorialSection>): TutorialSection => ({
    id: 'id',
    chapter: 1,
    order: 1,
    title: 'T',
    docSlugs: [],
    brief: 'b',
    details: null,
    file: '/p/f.md',
    ...over,
  });

  it('states the docs:search fallback for an empty pack', () => {
    expect(packIndexMarkdown([])).toContain('docs:search');
  });

  it('groups by chapter and lists file + doc slugs', () => {
    const md = packIndexMarkdown([
      sec({ id: 'a', chapter: 1, title: 'One', docSlugs: ['s/x'] }),
      sec({ id: 'b', chapter: 2, title: 'Two', file: '/p/g.md' }),
    ]);
    expect(md).toContain('**Chapter 1**');
    expect(md).toContain('- a — One → `/p/f.md` (docs: s/x)');
    expect(md).toContain('**Chapter 2**');
    expect(md).toContain('- b — Two → `/p/g.md`');
  });
});

// ---------------------------------------------------------------------------
// The REAL content pack (sync guards) — pack files must parse, ids must be
// unique, and every docSlug must resolve to a LIVE /internal/docs page, so
// tutorial content can never drift onto dead docs.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(__dirname, '../../../..');
const PACK_ROOT = join(REPO_ROOT, 'apps/operator/prompts/tutorial');
const DOCS_ROOT = join(REPO_ROOT, 'apps/operator-docs/src/content/docs');

describe.skipIf(!existsSync(PACK_ROOT))('the REAL tutorial content pack', () => {
  it('loads, sorted, with the seed sections present', () => {
    const pack = loadTutorialPack(PACK_ROOT);
    expect(pack.length).toBeGreaterThanOrEqual(3);
    const ids = pack.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    for (const seed of ['ch1-01-server-gui-tutorial', 'ch1-02-pots-harnesses-blueprints', 'ch2-01-plans']) {
      expect(ids).toContain(seed);
    }
    // sorted by (chapter, order)
    const keys = pack.map((s) => s.chapter * 1000 + s.order);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('every docSlug resolves to a live operator-docs page', () => {
    const missing: string[] = [];
    for (const s of loadTutorialPack(PACK_ROOT)) {
      for (const slug of s.docSlugs) {
        const candidates = [
          join(DOCS_ROOT, `${slug}.mdx`),
          join(DOCS_ROOT, `${slug}.md`),
          join(DOCS_ROOT, slug, 'index.mdx'),
        ];
        if (!candidates.some((p) => existsSync(p))) missing.push(`${s.file} → ${slug}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
