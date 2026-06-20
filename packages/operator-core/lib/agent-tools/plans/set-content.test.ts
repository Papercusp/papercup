/**
 * set-content.test.ts — evaluateSetContent guards.
 *
 * EI-1812: a PG-canonical plan keeps its frontmatter in PG COLUMNS, so a raw-body
 * edit (e.g. the body from plans:get(mode:full), handed back) legitimately omits the
 * leading `---…---` block. The would_orphan_frontmatter guard must NOT reject that —
 * the canonical frontmatter survives in the columns and is re-attached for the
 * shrink/legacy/lint guards + the stored body. A body that carries its OWN frontmatter
 * is an intentional rewrite and is left untouched.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSetContent } from './set-content';

const FRONTMATTER = `---
title: EI-1812 Test
slug: ei-1812-test
created: 2026-06-20
updated: 2026-06-20
status: draft
owner: test@papercusp.dev
---
`;

const BODY = `
# EI-1812 Test

## Now
Where it stands now. The single next concrete action and who does it.

## Phase 1 — Work
- [ ] P-001 First item

## Decisions
`;

const CURRENT = FRONTMATTER + BODY;

describe('evaluateSetContent — EI-1812 frontmatter re-attach', () => {
  it('a PG-canonical body that OMITS the leading frontmatter re-attaches it instead of rejecting would_orphan_frontmatter', async () => {
    // The filer's repro: a full body WITHOUT a leading ---…--- block.
    const proposed = `# EI-1812 Test

## Now
Updated state. The next concrete action, restated.

## Phase 1 — Work
- [ ] P-001 First item

## Decisions
`;
    const { newBody, value } = await evaluateSetContent(CURRENT, proposed, 'ei-1812-test', undefined, {
      allowShrink: true,
    });
    // The specific EI-1812 regression: a frontmatter-less PG-canonical body must NOT be
    // rejected as orphaning (the frontmatter survives in the columns + is re-attached).
    expect(value).not.toMatchObject({ code: 'would_orphan_frontmatter' });
    expect(value.ok).toBe(true);
    // The stored body carries the preserved frontmatter (re-attached).
    expect(newBody).not.toBeNull();
    expect(newBody!.startsWith('---')).toBe(true);
    expect(newBody!).toContain('title: EI-1812 Test');
    expect(newBody!).toContain('Updated state.');
  });

  it('a body that carries its OWN frontmatter is left untouched (no double-attach)', async () => {
    const proposedWithFm = CURRENT.replace('Where it stands now.', 'Edited in place.');
    const { newBody, value } = await evaluateSetContent(CURRENT, proposedWithFm, 'ei-1812-test', undefined, {
      allowShrink: true,
    });
    expect(value.ok).toBe(true);
    expect(newBody).toBe(proposedWithFm); // written as-is, frontmatter not doubled
    expect((newBody!.match(/^---\r?$/gm) ?? []).length).toBe(2); // exactly one block (open+close)
  });
});
