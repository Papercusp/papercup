/**
 * plansdrafts-sort-tiebreak.test.ts — the null-date tie-break in the
 * `plansDrafts.bySlug` newest-first sort (sync-resolver/index.ts).
 *
 * Colocated with its sibling sync-resolver/index.test.ts so the `vi.doMock`
 * specifier (`'../agent-tools/plans/source'`) resolves to the exact module the
 * resolver dynamically imports — the mock pattern is lifted verbatim.
 *
 * The resolver sorts drafts with:
 *     const ta = a.updated ?? a.created ?? '';
 *     const tb = b.updated ?? b.created ?? '';
 *     return tb.localeCompare(ta);   // newest-first
 *
 * The sibling test proves the happy path (both dates present). The UNCOVERED
 * edge is a draft whose frontmatter has NEITHER `updated:` NOR `created:` — both
 * coalesce to `''`. `''.localeCompare(x)` is well-defined (no throw), and an
 * empty string sorts BEFORE any real date in an ascending compare, so under the
 * newest-first (`tb.localeCompare(ta)`) order the null-date row lands LAST.
 * We assert: (a) no throw, (b) the dateless row sorts after every dated row,
 * (c) two dateless rows are mutually stable, (d) the `updated ?? created`
 * fallback engages when only `created` is present.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Same deterministic minimal parse as sync-resolver/index.test.ts — extracts
// exactly the frontmatter fields the resolver reads. A frontmatter that OMITS
// created/updated yields nulls for them, which is the whole point of this test.
function parseFixture(raw: string) {
  const fm: Record<string, string> = {};
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
      if (m) fm[m[1]] = m[2];
    }
  }
  const items = [...raw.matchAll(/^- \[[ x]\] (P-\d+)/gm)].map((m, i) => ({
    id: m[1],
    text: `item ${i + 1}`,
  }));
  const nowStateM = raw.match(/\*\*State:\*\*\s*(.+)/);
  const nowNextM = raw.match(/\*\*Next:\*\*\s*(.+)/);
  return {
    isLegacy: !fmMatch,
    slug: fm.slug ?? null,
    frontmatter: {
      title: fm.title ?? null,
      slug: fm.slug ?? null,
      status: fm.status ?? null,
      created: fm.created ?? null,
      updated: fm.updated ?? null,
    },
    items,
    now: nowStateM
      ? { state: nowStateM[1].trim(), next: nowNextM?.[1].trim() ?? null }
      : null,
  };
}

function mockPlansDeps(
  plans: Array<{ slug: string; content: string; archived?: boolean }>,
) {
  vi.doMock('../agent-tools/plans/source', () => ({
    resolveHarnessPlansDir: vi.fn(async () => ({
      harnessSlug: 'myharn',
      workspaceId: 'ws',
      plans: '/fake/plans',
      archive: '/fake/plans/archive',
    })),
    readAllPlans: vi.fn(async () =>
      plans.map((p) => ({
        parsed: parseFixture(p.content),
        archived: p.archived ?? false,
        row: {
          harnessSlug: 'myharn',
          planSlug: p.slug,
          content: p.content,
          archived: p.archived ?? false,
        },
      })),
    ),
  }));
}

/** A dated draft (both created + updated present). */
const DATED_DRAFT = (slug: string, date: string) => `---
title: "Dated ${slug}"
slug: ${slug}
status: draft
created: ${date}
updated: ${date}
---

## Now

**State:** s
**Next:** n

## Phase 1

- [ ] P-001 x
`;

/** A draft with NO created and NO updated frontmatter lines → both null. */
const DATELESS_DRAFT = (slug: string) => `---
title: "Dateless ${slug}"
slug: ${slug}
status: draft
---

## Now

**State:** s
**Next:** n

## Phase 1

- [ ] P-001 x
`;

describe('plansDrafts.bySlug — null-date sort tie-break', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a draft with null updated AND null created sorts LAST and does not throw', async () => {
    mockPlansDeps([
      { slug: 'dateless-2026-05-24', content: DATELESS_DRAFT('dateless-2026-05-24') },
      { slug: 'newer-2026-05-24', content: DATED_DRAFT('newer-2026-05-24', '2026-05-24') },
      { slug: 'older-2026-05-22', content: DATED_DRAFT('older-2026-05-22', '2026-05-22') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
      created: string | null;
      updated: string | null;
    }>;

    expect(rows).toHaveLength(3);
    // The dateless row coalesces to '' → sorts after both dated rows.
    expect(rows[0].slug).toBe('newer-2026-05-24');
    expect(rows[1].slug).toBe('older-2026-05-22');
    expect(rows[2].slug).toBe('dateless-2026-05-24');
    // And the dateless row carried through with both dates null.
    expect(rows[2].created).toBeNull();
    expect(rows[2].updated).toBeNull();
  });

  it('two dateless drafts are mutually stable (both coalesce to the same empty key) — no throw', async () => {
    mockPlansDeps([
      { slug: 'dateless-a-2026-05-24', content: DATELESS_DRAFT('dateless-a-2026-05-24') },
      { slug: 'dateless-b-2026-05-24', content: DATELESS_DRAFT('dateless-b-2026-05-24') },
      { slug: 'dated-2026-05-24', content: DATED_DRAFT('dated-2026-05-24', '2026-05-24') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
    }>;

    expect(rows).toHaveLength(3);
    // The dated row is unambiguously first.
    expect(rows[0].slug).toBe('dated-2026-05-24');
    // Both dateless rows trail; the contract asserted: both come after the dated
    // one and the call did not throw.
    const trailing = rows.slice(1).map((x) => x.slug).sort();
    expect(trailing).toEqual(['dateless-a-2026-05-24', 'dateless-b-2026-05-24']);
  });

  it('falls back to created when updated alone is null (asymmetric coalesce, no throw)', async () => {
    // Only `created` present (updated omitted) → ta = created. Proves the
    // `updated ?? created` fallback engages and orders by created correctly.
    const createdOnly = `---
title: "Created only"
slug: created-only-2026-05-25
status: draft
created: 2026-05-25
---

## Now

**State:** s
**Next:** n

## Phase 1

- [ ] P-001 x
`;
    mockPlansDeps([
      { slug: 'created-only-2026-05-25', content: createdOnly },
      { slug: 'older-2026-05-22', content: DATED_DRAFT('older-2026-05-22', '2026-05-22') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
    }>;
    expect(rows).toHaveLength(2);
    // created-only's 2026-05-25 (via the created fallback) beats older's 2026-05-22.
    expect(rows[0].slug).toBe('created-only-2026-05-25');
    expect(rows[1].slug).toBe('older-2026-05-22');
  });
});
