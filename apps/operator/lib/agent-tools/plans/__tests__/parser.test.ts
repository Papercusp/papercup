/**
 * Unit tests for the plans parser + effectiveStatus resolver.
 *
 * Per agent-plan-tracking-2026-05-20.md §3 + §4.5.
 */

import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { resolveEffectiveStatus } from '../effective-status';

const FULL_DOC = `---
title: Test plan
slug: test-plan-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: a@b.c
---

# Test plan

## Now

**State:** Phase 1 in flight.
**Next:** an agent picks up P-007.

## 1. Background

Some prose.

## Phase 1 — Tooling

- **P-001** \`done\` First item. → D-001
- **P-002** \`wip\` Second item.
- **P-003** \`todo\` Third item. blocked-by: P-002
- **P-004** \`todo\` Fourth item. blocked-by: P-001
- **P-005** \`blocked\` External-blocked item awaiting upstream PR.

## 7. Decisions

### D-001 — First decision
Date: 2026-05-20
Decision: Reference to P-001.
`;

describe('parsePlan', () => {
  it('parses frontmatter, Now block, items, and decisions', () => {
    const p = parsePlan(FULL_DOC, { filePath: '/tmp/test-plan-2026-05-20.md' });
    expect(p.isLegacy).toBe(false);
    expect(p.frontmatter.title).toBe('Test plan');
    expect(p.frontmatter.slug).toBe('test-plan-2026-05-20');
    expect(p.frontmatter.status).toBe('active');

    expect(p.now?.state).toContain('Phase 1 in flight');
    expect(p.now?.next).toContain('P-007');

    expect(p.items).toHaveLength(5);
    expect(p.items[0]?.id).toBe('P-001');
    expect(p.items[0]?.storedStatus).toBe('done');
    expect(p.items[0]?.decisionRefs).toEqual(['D-001']);

    expect(p.items[2]?.blockedBy).toEqual(['P-002']);
    expect(p.items[3]?.blockedBy).toEqual(['P-001']);

    expect(p.decisions).toHaveLength(1);
    expect(p.decisions[0]?.id).toBe('D-001');
    expect(p.decisions[0]?.title).toBe('First decision');
    expect(p.decisions[0]?.itemRefs).toEqual(['P-001']);
  });

  it('matches `## 7. Decisions` via tolerant numbering strip', () => {
    const p = parsePlan(FULL_DOC);
    expect(p.decisions.length).toBe(1);
  });

  it('flags malformed-frontmatter files as legacy', () => {
    const p = parsePlan('# No frontmatter\n\nJust prose.');
    expect(p.isLegacy).toBe(true);
    expect(p.items).toHaveLength(0);
  });

  it('flags files without a slug field as legacy', () => {
    const p = parsePlan(`---\ntitle: Half-frontmatter\n---\n\nBody.`);
    expect(p.isLegacy).toBe(true);
  });

  it('parses items with ASCII-only separators', () => {
    const doc = `---
title: x
slug: x
status: draft
---

## Now

**State:** s
**Next:** n

## Phase 1

- **P-001** \`todo\` Some text. blocked-by: P-002, P-003 - see D-004
`;
    const p = parsePlan(doc);
    expect(p.items[0]?.blockedBy).toEqual(['P-002', 'P-003']);
    expect(p.items[0]?.decisionRefs).toEqual(['D-004']);
  });

  it('rejects unknown status tokens (line not parsed as item)', () => {
    const doc = `---
title: x
slug: x
status: draft
---

## Now

**State:** s
**Next:** n

## Phase 1

- **P-001** \`bogus\` This is not an item.
- **P-002** \`todo\` This is one.
`;
    const p = parsePlan(doc);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.id).toBe('P-002');
  });
});

describe('resolveEffectiveStatus', () => {
  it('flips stored=todo with unresolved blockers to effective=blocked', () => {
    const p = parsePlan(FULL_DOC);
    const r = resolveEffectiveStatus(p);
    const byId = new Map(r.items.map((it) => [it.id, it]));
    // P-003 stored=todo, blocked-by=P-002 (wip) → effective blocked
    expect(byId.get('P-003')?.storedStatus).toBe('todo');
    expect(byId.get('P-003')?.effectiveStatus).toBe('blocked');
    expect(byId.get('P-003')?.unresolvedBlockers).toEqual(['P-002']);
  });

  it('flips stored=todo with all blockers done to effective=todo', () => {
    const p = parsePlan(FULL_DOC);
    const r = resolveEffectiveStatus(p);
    const byId = new Map(r.items.map((it) => [it.id, it]));
    // P-004 blocked-by=P-001 (done) → effective todo
    expect(byId.get('P-004')?.effectiveStatus).toBe('todo');
  });

  it('treats stored=blocked as effective=blocked regardless of refs', () => {
    const p = parsePlan(FULL_DOC);
    const r = resolveEffectiveStatus(p);
    const byId = new Map(r.items.map((it) => [it.id, it]));
    expect(byId.get('P-005')?.effectiveStatus).toBe('blocked');
  });

  it('detects cycles', () => {
    const doc = `---
title: x
slug: x
status: draft
---

## Now

**State:** s
**Next:** n

## Phase 1

- **P-001** \`todo\` a. blocked-by: P-002
- **P-002** \`todo\` b. blocked-by: P-001
`;
    const p = parsePlan(doc);
    const r = resolveEffectiveStatus(p);
    expect(r.cycleMembers).toContain('P-001');
    expect(r.cycleMembers).toContain('P-002');
    expect(r.items[0]?.effectiveStatus).toBe('blocked');
    expect(r.items[1]?.effectiveStatus).toBe('blocked');
  });

  it('flags missing refs', () => {
    const doc = `---
title: x
slug: x
status: draft
---

## Now

**State:** s
**Next:** n

## Phase 1

- **P-001** \`todo\` a. blocked-by: P-999
`;
    const p = parsePlan(doc);
    const r = resolveEffectiveStatus(p);
    expect(r.missingRefs).toEqual([{ itemId: 'P-001', ref: 'P-999' }]);
    expect(r.items[0]?.effectiveStatus).toBe('blocked');
  });
});
