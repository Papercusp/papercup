/**
 * docs:author pure-helper tests — the footgun-prevention logic (EI-5260):
 * slug/section validation, frontmatter generation, leading-frontmatter strip,
 * and list normalization. The FS + anchor integration is covered by the live
 * smoke; these lock the wrong-dir / bad-frontmatter / clobber guards.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSlug,
  normalizeSection,
  stripLeadingFrontmatter,
  normalizeList,
  buildFrontmatter,
  composeDoc,
  todayIso,
  type FrontmatterInput,
} from './author';
// The SAME parser the anchor system uses to read a doc's `documents:` frontmatter.
// docs:author and harness_docs:anchor must agree on the format or the doc ships
// un-anchored (the EI-4889 class). This round-trips them against each other.
import { frontmatterDocuments } from '../../harness/docs/manual-anchor';

describe('normalizeSlug', () => {
  it('accepts a kebab slug and lowercases', () => {
    expect(normalizeSlug('My-New-Insight')).toEqual({ ok: true, slug: 'my-new-insight' });
  });
  it('strips a trailing .mdx / .md', () => {
    expect(normalizeSlug('foo.mdx')).toEqual({ ok: true, slug: 'foo' });
    expect(normalizeSlug('foo.md')).toEqual({ ok: true, slug: 'foo' });
  });
  it('rejects a slug with a slash (that is what `section` is for)', () => {
    const r = normalizeSlug('agent-insights/foo');
    expect(r.ok).toBe(false);
  });
  it('rejects non-kebab characters', () => {
    expect(normalizeSlug('foo_bar').ok).toBe(false);
    expect(normalizeSlug('Foo Bar').ok).toBe(false);
    expect(normalizeSlug('').ok).toBe(false);
  });
});

describe('normalizeSection', () => {
  it('defaults to agent-insights', () => {
    expect(normalizeSection(undefined)).toEqual({ ok: true, section: 'agent-insights' });
    expect(normalizeSection('')).toEqual({ ok: true, section: 'agent-insights' });
  });
  it('trims surrounding slashes', () => {
    expect(normalizeSection('/system/')).toEqual({ ok: true, section: 'system' });
  });
  it('rejects path traversal', () => {
    expect(normalizeSection('../etc').ok).toBe(false);
    expect(normalizeSection('a/../b').ok).toBe(false);
  });
  it('allows nested kebab dirs', () => {
    expect(normalizeSection('spec/decisions')).toEqual({ ok: true, section: 'spec/decisions' });
  });
});

describe('stripLeadingFrontmatter', () => {
  it('strips a leading --- block', () => {
    const r = stripLeadingFrontmatter('---\ntitle: x\n---\n\nBody here');
    expect(r.stripped).toBe(true);
    expect(r.body.trimStart()).toBe('Body here');
  });
  it('leaves a body without frontmatter untouched', () => {
    const r = stripLeadingFrontmatter('# Heading\n\ntext');
    expect(r.stripped).toBe(false);
    expect(r.body).toBe('# Heading\n\ntext');
  });
  it('does not strip a mid-body --- (only a leading block)', () => {
    const body = 'intro\n\n---\n\nmore';
    const r = stripLeadingFrontmatter(body);
    expect(r.stripped).toBe(false);
    expect(r.body).toBe(body);
  });
});

describe('normalizeList', () => {
  it('handles string, array, comma-join, dedupe, trim', () => {
    expect(normalizeList('a, b ,a')).toEqual(['a', 'b']);
    expect(normalizeList(['a', ' b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeList(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeList(undefined)).toEqual([]);
    expect(normalizeList('')).toEqual([]);
  });
});

describe('buildFrontmatter', () => {
  const base: FrontmatterInput = {
    title: 'A title: with a colon',
    description: 'one line desc',
    discovered: '2026-06-30',
    status: 'active',
    tags: [],
    documents: [],
    plans: [],
  };

  it('quotes title/description (colons stay valid YAML) and emits required keys', () => {
    const fm = buildFrontmatter(base);
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('\n---')).toBe(true);
    expect(fm).toContain('title: "A title: with a colon"');
    expect(fm).toContain('description: "one line desc"');
    expect(fm).toContain('discovered: 2026-06-30');
    expect(fm).toContain('status: active');
  });

  it('omits empty tags/documents/plans/sidebar', () => {
    const fm = buildFrontmatter(base);
    expect(fm).not.toContain('tags:');
    expect(fm).not.toContain('documents:');
    expect(fm).not.toContain('plans:');
    expect(fm).not.toContain('sidebar:');
  });

  it('emits inline tags, block documents/plans, and sidebar order', () => {
    const fm = buildFrontmatter({
      ...base,
      tags: ['plans', 'federation'],
      documents: ['packages/a/b.ts', 'packages/a/b.ts :: fn'],
      plans: ['my-plan-2026-06-30'],
      sidebarOrder: 13,
    });
    expect(fm).toContain('tags: ["plans", "federation"]');
    expect(fm).toContain('documents:\n  - "packages/a/b.ts"\n  - "packages/a/b.ts :: fn"');
    expect(fm).toContain('plans:\n  - "my-plan-2026-06-30"');
    expect(fm).toContain('sidebar:\n  order: 13');
  });
});

describe('composeDoc', () => {
  it('strips a leading frontmatter from body and reassembles with generated frontmatter + trailing newline', () => {
    const fm: FrontmatterInput = {
      title: 'T',
      description: 'D',
      discovered: '2026-06-30',
      status: 'active',
      tags: [],
      documents: ['pkg/x.ts'],
      plans: [],
    };
    const out = composeDoc(fm, '---\ntitle: WRONG\n---\n\n# Body\n\ntext\n');
    expect(out).toContain('title: "T"');
    expect(out).not.toContain('WRONG');
    expect(out).toContain('documents:\n  - "pkg/x.ts"');
    expect(out.endsWith('# Body\n\ntext\n')).toBe(true);
    // exactly one blank line between frontmatter close and body
    expect(out).toContain('---\n\n# Body');
  });
});

describe('todayIso', () => {
  it('formats YYYY-MM-DD', () => {
    expect(todayIso(new Date('2026-06-30T12:34:56Z'))).toBe('2026-06-30');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(todayIso())).toBe(true);
  });
});

describe('author ↔ anchor round-trip', () => {
  // The whole point of docs:author is that the file it writes is anchor-ready.
  // Generate frontmatter, then parse it back with the anchor's OWN parser — the
  // documents must come out identical (block-list form).
  it('block-list documents round-trip through the anchor parser', () => {
    const docs = ['packages/a/b.ts', 'packages/a/b.ts :: someFn', 'F-3'];
    const fm: FrontmatterInput = {
      title: 'Round trip: with a colon',
      description: 'desc',
      discovered: '2026-06-30',
      status: 'active',
      tags: ['x', 'y'],
      documents: docs,
      plans: ['plan-2026-06-30'],
    };
    const content = composeDoc(fm, '# Body\n\nsome text');
    expect(frontmatterDocuments(content)).toEqual(docs);
  });

  it('a doc with no documents parses as undefined (anchor → untracked, as designed)', () => {
    const fm: FrontmatterInput = {
      title: 'T',
      description: 'D',
      discovered: '2026-06-30',
      status: 'active',
      tags: [],
      documents: [],
      plans: [],
    };
    const content = composeDoc(fm, 'body');
    expect(frontmatterDocuments(content)).toBeUndefined();
  });
});
