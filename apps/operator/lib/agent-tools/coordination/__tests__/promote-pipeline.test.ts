/**
 * P-006: Phase A pipeline tests — upsertPromotedBlock round-trips.
 */

import { describe, expect, it } from 'vitest';
import { upsertPromotedBlock, upsertPromoteStatusLine } from '../tools/promote';

const FENCE = '<!-- plan-pipeline: do not edit this block manually -->';

const BASE_PLAN = `---
title: Demo Plan
slug: demo-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
---

## Now

**State:** Active
**Next:** Ship phase A.

## Phase 1

- **P-001** \`todo\` First item.

## Decisions

### D-001 — Initial decisions
Date: 2026-05-24
Agreed to ship Phase A first.
`;

describe('upsertPromotedBlock — first promote', () => {
  it('inserts a ## Promoted block after ## Now when none exists', () => {
    const rows = ['- [ ] F-AUTO-ABC001 — Feature one <!-- P-001 -->'];
    const out = upsertPromotedBlock(BASE_PLAN, rows);
    expect(out).toContain('## Promoted');
    expect(out).toContain(FENCE);
    expect(out).toContain('- [ ] F-AUTO-ABC001 — Feature one <!-- P-001 -->');
  });

  it('positions the block between ## Now and the next section', () => {
    const rows = ['- [ ] F-001 — x'];
    const out = upsertPromotedBlock(BASE_PLAN, rows);
    const nowIdx = out.indexOf('## Now');
    const promotedIdx = out.indexOf('## Promoted');
    const phase1Idx = out.indexOf('## Phase 1');
    expect(nowIdx).toBeLessThan(promotedIdx);
    expect(promotedIdx).toBeLessThan(phase1Idx);
  });

  it('appends at end of body when there is no ## Now section', () => {
    const bare = '# Bare plan\n\nsome prose\n';
    const out = upsertPromotedBlock(bare, ['- [ ] F-001 — x']);
    expect(out.indexOf('## Promoted')).toBeGreaterThan(bare.length - 5);
  });

  it('returns body unchanged when rows is empty', () => {
    expect(upsertPromotedBlock(BASE_PLAN, [])).toBe(BASE_PLAN);
  });
});

describe('upsertPromotedBlock — second promote (append without duplication)', () => {
  it('appends new feature rows to an existing ## Promoted block', () => {
    const firstPass = upsertPromotedBlock(BASE_PLAN, ['- [ ] F-AUTO-AA001 — First <!-- P-001 -->']);
    const secondPass = upsertPromotedBlock(firstPass, ['- [ ] F-AUTO-BB002 — Second <!-- P-002 -->']);
    expect(secondPass).toContain('F-AUTO-AA001');
    expect(secondPass).toContain('F-AUTO-BB002');
    // Only one ## Promoted heading
    expect(secondPass.match(/^## Promoted/gm)?.length).toBe(1);
  });

  it('does not duplicate a feature id already in the block', () => {
    const row = '- [ ] F-AUTO-AA001 — First <!-- P-001 -->';
    const firstPass = upsertPromotedBlock(BASE_PLAN, [row]);
    const secondPass = upsertPromotedBlock(firstPass, [row]);
    // Exactly one occurrence of F-AUTO-AA001
    const count = (secondPass.match(/F-AUTO-AA001/g) ?? []).length;
    expect(count).toBe(1);
    // Body is unchanged when all rows are duplicates
    expect(secondPass).toBe(firstPass);
  });

  it('deduplicates by id even when the existing row is checked [x]', () => {
    const block = `\n## Promoted\n\n${FENCE}\n- [x] F-AUTO-AA001 — Checked\n`;
    const body = BASE_PLAN + block;
    const out = upsertPromotedBlock(body, ['- [ ] F-AUTO-AA001 — Checked']);
    const count = (out.match(/F-AUTO-AA001/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('appends only the genuinely new rows in a mixed batch', () => {
    const existing = upsertPromotedBlock(BASE_PLAN, ['- [ ] F-001 — existing']);
    const mixed = [
      '- [ ] F-001 — existing',   // duplicate — skip
      '- [ ] F-002 — new one',    // new — add
    ];
    const out = upsertPromotedBlock(existing, mixed);
    expect(out).toContain('F-002');
    const count001 = (out.match(/F-001/g) ?? []).length;
    expect(count001).toBe(1);
  });
});

/* ── upsertPromoteStatusLine (F3) ─────────────────────────────────── */

describe('upsertPromoteStatusLine — Now block promote-status line', () => {
  const PLAN_WITH_NOW = `---
title: T
slug: x
status: active
---

## Now

**State:** user wrote this.

**Next:** user wrote this too.

## Phases

- P-001 stuff
`;

  it('appends a status line after the existing Now block on first promote', () => {
    const out = upsertPromoteStatusLine(PLAN_WITH_NOW, 'myharn', {
      total: 3,
      inflight: 2,
      passed: 1,
    });
    expect(out).toContain('**State:** user wrote this.');
    expect(out).toContain('**Next:** user wrote this too.');
    expect(out).toContain('<!-- plan-pipeline-status -->');
    expect(out).toContain('**Promote-status:** 3 feature(s) in `myharn`: 2 in-flight · 1 passed');
    // Status line is BEFORE the next ## heading.
    const statusIdx = out.indexOf('Promote-status:');
    const phasesIdx = out.indexOf('## Phases');
    expect(statusIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeLessThan(phasesIdx);
  });

  it('replaces an existing status line (idempotent re-promote)', () => {
    const first = upsertPromoteStatusLine(PLAN_WITH_NOW, 'myharn', {
      total: 3,
      inflight: 3,
      passed: 0,
    });
    const second = upsertPromoteStatusLine(first, 'myharn', {
      total: 5,
      inflight: 2,
      passed: 3,
    });
    // Exactly one status line.
    const matches = (second.match(/Promote-status:/g) ?? []).length;
    expect(matches).toBe(1);
    // Shows new counts, not old.
    expect(second).toContain('5 feature(s) in `myharn`: 2 in-flight · 3 passed');
    expect(second).not.toContain('3 feature(s) in `myharn`: 3 in-flight · 0 passed');
  });

  it('preserves user state/next verbatim across multiple promotes', () => {
    const a = upsertPromoteStatusLine(PLAN_WITH_NOW, 'h', { total: 1, inflight: 1, passed: 0 });
    const b = upsertPromoteStatusLine(a, 'h', { total: 2, inflight: 1, passed: 1 });
    expect(b).toContain('**State:** user wrote this.');
    expect(b).toContain('**Next:** user wrote this too.');
  });

  it('returns body unchanged when ## Now is absent', () => {
    const noNow = `---\ntitle: t\n---\n\n## Phases\n\n- P-001 x\n`;
    const out = upsertPromoteStatusLine(noNow, 'h', { total: 1, inflight: 1, passed: 0 });
    expect(out).toBe(noNow);
  });
});

/* ── Draft → active status flip on promote (R2-B) ─────────────────── */

describe('promote status-flip helper — draft → active idempotency', () => {
  it('replaces status: draft → status: active in frontmatter only', () => {
    const body = `---
title: x
slug: x-2026-05-25
status: draft
---

## Now
**State:** stuff with the word draft in it
`;
    const out = body.replace(/^(status:\s*)draft\b/m, '$1active');
    expect(out).toContain('status: active');
    expect(out).not.toMatch(/^status:\s*draft/m);
    // body text containing "draft" is untouched
    expect(out).toContain('stuff with the word draft in it');
  });

  it('is a no-op on a plan that is already active', () => {
    const body = `---
title: x
status: active
---
`;
    const out = body.replace(/^(status:\s*)draft\b/m, '$1active');
    expect(out).toBe(body);
  });

  it('is a no-op on a shipped plan', () => {
    const body = `---
title: x
status: shipped
---
`;
    const out = body.replace(/^(status:\s*)draft\b/m, '$1active');
    expect(out).toBe(body);
  });

  it('does not match the word "draft" outside the status: line', () => {
    const body = `---
title: my-draft-thoughts
status: active
---

Something about draft.
`;
    const out = body.replace(/^(status:\s*)draft\b/m, '$1active');
    expect(out).toBe(body);
  });
});
