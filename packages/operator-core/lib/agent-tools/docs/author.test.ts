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
  insightsIndexNudge,
  stripLeadingFrontmatter,
  normalizeList,
  buildFrontmatter,
  composeDoc,
  todayIso,
  discoveredForWrite,
  resolveAuthorHarness,
  descriptionLengthWarning,
  DESCRIPTION_RECOMMENDED_MAX,
  DESCRIPTION_HARD_MAX,
  type FrontmatterInput,
} from './author';
import { resolveHarnessScope } from '../_harness-scope';
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
  it('routes a canonical section/slug path into section plus the final slug', () => {
    expect(normalizeSlug('agent-insights/foo')).toEqual({ ok: true, slug: 'foo', section: 'agent-insights' });
    expect(normalizeSlug('system/decisions/foo.mdx')).toEqual({ ok: true, slug: 'foo', section: 'system/decisions' });
  });
  it('rejects backslash paths rather than treating them as platform-specific sections', () => {
    const r = normalizeSlug('agent-insights\\foo');
    expect(r).toEqual({ ok: false, error: 'slug_must_use_forward_slashes — use `<section>/<slug>` for a canonical doc path' });
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

describe('insightsIndexNudge', () => {
  it('nudges for a papercusp agent-insights doc (the only dir the generator reads)', () => {
    const msg = insightsIndexNudge('agent-insights', 'papercusp');
    expect(msg).toContain('gen:doc-insights-index');
  });
  it('stays silent for another section in papercusp', () => {
    expect(insightsIndexNudge('system', 'papercusp')).toBeNull();
    expect(insightsIndexNudge('spec/decisions', 'papercusp')).toBeNull();
  });
  it('stays silent for a harness-scoped agent-insights dir — the generator does not read it', () => {
    expect(insightsIndexNudge('agent-insights', 'some-other-harness')).toBeNull();
  });
});

describe('resolveAuthorHarness (EI-20100921170504541)', () => {
  // The regression: docs:search's own schema tells a workspace-scoped caller to reach
  // the agent-insights corpus with harness:'engineering'. Handing that same literal
  // back to docs:author used to fail `unknown_harness`, so the two halves of ONE
  // workflow disagreed about the same corpus.
  it("accepts 'engineering' — the same literal docs:search takes for this corpus", () => {
    expect(resolveAuthorHarness('engineering', { harnessSlug: 'papercusp-workspace' })).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: true,
    });
  });

  // Both resolve to the same docs root, but they are different INTENTS and the emitted
  // `surface` metadata reports them apart — so collapsing them would lose a signal.
  it("distinguishes the engineering reference from the 'papercusp' harness named explicitly", () => {
    expect(resolveAuthorHarness('papercusp', {})).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: false,
    });
    expect(resolveAuthorHarness('engineering', {})).toEqual({
      ok: true,
      harnessSlug: 'papercusp',
      engineering: true,
    });
  });

  it("treats 'engineering' identically to omitting it, and to the 'all' sentinel", () => {
    const viaSentinel = resolveAuthorHarness('engineering', { isSuperuser: true });
    const viaOmission = resolveAuthorHarness(undefined, { isSuperuser: true });
    const viaAll = resolveAuthorHarness('all', {});
    const viaStar = resolveAuthorHarness('*', {});
    expect(viaSentinel).toEqual(viaOmission);
    expect(viaSentinel).toEqual(viaAll);
    expect(viaSentinel).toEqual(viaStar);
  });

  it('matches the sentinel case-insensitively and around whitespace', () => {
    for (const v of ['ENGINEERING', ' engineering ', 'Engineering']) {
      expect(resolveAuthorHarness(v, {})).toEqual({ ok: true, harnessSlug: 'papercusp', engineering: true });
    }
  });

  it('still routes a concrete slug to that harness, and ctx scope when no arg', () => {
    expect(resolveAuthorHarness('some-harness', {})).toEqual({
      ok: true,
      harnessSlug: 'some-harness',
      engineering: false,
    });
    expect(resolveAuthorHarness(undefined, { harnessSlug: 'scoped-harness' })).toEqual({
      ok: true,
      harnessSlug: 'scoped-harness',
      engineering: false,
    });
  });

  it('fails with an error naming the FIX, not just a registry miss', () => {
    const r = resolveAuthorHarness(undefined, { harnessSlug: '*', isSuperuser: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    // The old failure said only "<slug> is not registered", which reads as "that corpus
    // is unreachable from here" — the opposite of true.
    expect(r.error).toMatch(/engineering/);
    expect(r.error).toMatch(/omit/i);
  });

  // SECURITY-RELEVANT, and the reason this fix lives in docs:author rather than in the
  // shared resolver: `resolveHarnessScope` is also used by `plans:*` and
  // `harness_docs:*`, and the 'engineering' literal is deliberately INVISIBLE to the
  // _mcp-handler workspace clamp (that is its whole purpose — EI-18894866320087268).
  // Teaching the shared resolver about it would silently hand every one of those tools
  // a cross-harness escape the clamp cannot see, across a TENANT-data boundary rather
  // than a docs one. If this test ever fails, that widening has happened — do not
  // "fix" it by updating the expectation.
  it('does NOT widen the shared resolver — plans:*/harness_docs:* must not inherit the sentinel', () => {
    expect(resolveHarnessScope('engineering', {})).toEqual({ kind: 'harness', slug: 'engineering' });
  });
});

describe('descriptionLengthWarning (EI-20100921170504541, second half)', () => {
  it('is silent at or under the recommended length', () => {
    expect(descriptionLengthWarning('short')).toBeNull();
    expect(descriptionLengthWarning('x'.repeat(DESCRIPTION_RECOMMENDED_MAX))).toBeNull();
  });

  it('warns — rather than rejecting — just over the recommendation, and reports the count', () => {
    // 618 chars is the measured real case: a hard reject there cost a resend of the
    // whole call, body included (~6k tokens), for overshooting a display field.
    const w = descriptionLengthWarning('x'.repeat(618));
    expect(w).toBeTruthy();
    expect(w).toContain('618');
    expect(w).toContain(String(DESCRIPTION_RECOMMENDED_MAX));
  });

  it('leaves real headroom above the recommendation before anything is refused', () => {
    expect(DESCRIPTION_HARD_MAX).toBeGreaterThan(DESCRIPTION_RECOMMENDED_MAX);
    expect(descriptionLengthWarning('x'.repeat(DESCRIPTION_HARD_MAX))).toBeTruthy();
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
      type: 'Insight',
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
      type: 'Insight',
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

describe('discoveredForWrite (EI-20090410833629115)', () => {
  it('preserves the original discovered vintage when re-authoring canonical content', () => {
    const existing = '---\ntitle: "Old"\ndiscovered: 2026-07-27\nstatus: active\n---\n\nBody\n';
    expect(discoveredForWrite(existing, '2026-08-12')).toBe('2026-07-27');
  });

  it('stamps today for creation or malformed legacy frontmatter', () => {
    expect(discoveredForWrite(null, '2026-08-12')).toBe('2026-08-12');
    expect(discoveredForWrite('---\ntitle: old\n---\n', '2026-08-12')).toBe('2026-08-12');
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
      type: 'Insight',
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
      type: 'Insight',
      tags: [],
      documents: [],
      plans: [],
    };
    const content = composeDoc(fm, 'body');
    expect(frontmatterDocuments(content)).toBeUndefined();
  });
});
