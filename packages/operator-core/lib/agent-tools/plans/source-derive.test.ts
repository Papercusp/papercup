/**
 * deriveIndexFromContent — the pure frontmatter→index derivation that feeds the
 * harness_plans projection columns on every write (with-plan-lock INSERT). P-015
 * added `initiative`; this locks that it is derived from the frontmatter (and is
 * null when absent), the same way owner/title are.
 */
import { describe, it, expect } from 'vitest';
import { deriveIndexFromContent } from './source';

const PLAN = (extra = '') => `---
title: Demo
slug: demo
status: active
owner: a@x.com${extra}
---

# Demo

## Now

**State:** building.

**Next:** ship.
`;

describe('deriveIndexFromContent — initiative (P-015)', () => {
  it('derives the initiative label from frontmatter', () => {
    const idx = deriveIndexFromContent(PLAN('\ninitiative: shared-hive'));
    expect(idx.initiative).toBe('shared-hive');
    // sibling scalars still derive (no regression)
    expect(idx.owner).toBe('a@x.com');
    expect(idx.title).toBe('Demo');
  });

  it('is null when the plan has no initiative', () => {
    expect(deriveIndexFromContent(PLAN()).initiative).toBeNull();
  });
});
