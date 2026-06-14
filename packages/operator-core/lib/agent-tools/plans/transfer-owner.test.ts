/**
 * plans:transfer-owner — the surgical frontmatter editor behind the first-class
 * ownership-transfer verb (shared-hive-collaboration-2026-06-14 P-003). Tests the
 * pure setFrontmatterScalar: it must change ONLY the targeted key and preserve
 * every other frontmatter line + the body. The handler wiring (withPlanLock +
 * revision + invalidate) mirrors the tested plans:set-frontmatter.
 */
import { describe, it, expect } from 'vitest';
import { setFrontmatterScalar } from './transfer-owner';

const PLAN = `---
title: My Plan
slug: my-plan
created: 2026-06-01
updated: 2026-06-01
status: ready
owner: old@x.com
---

# My Plan

## Now
body stays untouched.
`;

describe('setFrontmatterScalar', () => {
  it('replaces an existing key in place, preserving every other line + the body', () => {
    const out = setFrontmatterScalar(PLAN, 'owner', 'new@x.com');
    expect(out).toContain('owner: new@x.com');
    expect(out).not.toContain('owner: old@x.com');
    // every other frontmatter key survives
    expect(out).toContain('title: My Plan');
    expect(out).toContain('slug: my-plan');
    expect(out).toContain('status: ready');
    // body untouched
    expect(out).toContain('## Now\nbody stays untouched.');
  });

  it('inserts a missing key as the last frontmatter line (before the closing ---)', () => {
    const out = setFrontmatterScalar(PLAN, 'co_owners', 'a@x.com, b@x.com');
    expect(out).toContain('co_owners: a@x.com, b@x.com');
    // inserted INSIDE the frontmatter block, before the close + body
    const fmEnd = out.indexOf('\n---', 3);
    expect(out.indexOf('co_owners:')).toBeLessThan(fmEnd);
    expect(out).toContain('owner: old@x.com'); // existing keys intact
  });

  it('removes a key when value is null (and its newline), leaving the rest intact', () => {
    const withCo = setFrontmatterScalar(PLAN, 'co_owners', 'a@x.com');
    expect(withCo).toContain('co_owners: a@x.com');
    const removed = setFrontmatterScalar(withCo, 'co_owners', null);
    expect(removed).not.toContain('co_owners:');
    expect(removed).toContain('owner: old@x.com');
    expect(removed).toContain('status: ready');
  });

  it('only the targeted key changes — a second key is not disturbed', () => {
    let out = setFrontmatterScalar(PLAN, 'owner', 'new@x.com');
    out = setFrontmatterScalar(out, 'co_owners', 'c@x.com');
    expect(out).toContain('owner: new@x.com');
    expect(out).toContain('co_owners: c@x.com');
    expect(out).toContain('updated: 2026-06-01'); // not touched here (bumpUpdatedDate does that)
  });

  it('a legacy plan (no frontmatter) is returned unchanged', () => {
    const legacy = '# Legacy plan\n\nno frontmatter here.\n';
    expect(setFrontmatterScalar(legacy, 'owner', 'x@x.com')).toBe(legacy);
  });
});
