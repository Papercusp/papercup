/**
 * P-006: Phase A pipeline tests — upsertPromotedBlock round-trips.
 */

import { describe, expect, it } from 'vitest';
import { upsertPromotedBlock, upsertPromoteStatusLine, buildPromotedRows, type WaveSummary } from '../tools/promote';

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

/* ── upsertPromoteStatusLine per-wave breakdown (P-013) ───────────── */

describe('upsertPromoteStatusLine — per-wave breakdown (P-013)', () => {
  const PLAN = `---
title: T
slug: x
status: active
---

## Now

**State:** s

**Next:** n

## Phases

- P-001
`;

  const w = (
    wave: string,
    total: number,
    passed: number,
    inflight: number,
    blocked = 0,
    failing = 0,
  ): WaveSummary => ({ wave, total, passed, inflight, blocked, failing });

  it('renders one line per wave when 2+ waves are present', () => {
    const out = upsertPromoteStatusLine(
      PLAN,
      'h',
      { total: 4, inflight: 2, passed: 2 },
      [w('w1', 2, 2, 0), w('w2', 2, 0, 2)],
    );
    expect(out).toContain('**Promote-status:** 4 feature(s) in `h`: 2 in-flight · 2 passed');
    expect(out).toContain('Wave **w1**: 2 total · 2 passed · 0 in-flight');
    expect(out).toContain('Wave **w2**: 2 total · 0 passed · 2 in-flight');
  });

  it('suppresses the per-wave breakdown when there is only one wave', () => {
    const out = upsertPromoteStatusLine(
      PLAN,
      'h',
      { total: 2, inflight: 1, passed: 1 },
      [w('w1', 2, 1, 1)],
    );
    expect(out).toContain('**Promote-status:**');
    expect(out).not.toContain('Wave **w1**');
  });

  it('annotates blocked and failing counts on the wave line', () => {
    const out = upsertPromoteStatusLine(
      PLAN,
      'h',
      { total: 5, inflight: 3, passed: 0 },
      [w('w1', 2, 0, 0, 2, 0), w('w2', 3, 0, 1, 0, 2)],
    );
    expect(out).toContain('Wave **w1**: 2 total · 0 passed · 0 in-flight · 2 blocked');
    expect(out).toContain('Wave **w2**: 3 total · 0 passed · 1 in-flight ⚠ 2 failing');
  });

  it('re-promote with multiple waves replaces cleanly — one marker, no orphaned wave lines', () => {
    const first = upsertPromoteStatusLine(
      PLAN,
      'h',
      { total: 4, inflight: 2, passed: 2 },
      [w('w1', 2, 2, 0), w('w2', 2, 0, 2)],
    );
    const second = upsertPromoteStatusLine(
      first,
      'h',
      { total: 4, inflight: 0, passed: 4 },
      [w('w1', 2, 2, 0), w('w2', 2, 2, 0)],
    );
    // Exactly one status marker survives the re-promote.
    const markers = (second.match(/plan-pipeline-status/g) ?? []).length;
    expect(markers).toBe(1);
    // Exactly two wave lines (w1, w2) — NOT four. The pre-fix strip regex
    // left wave lines 2..N orphaned, so a re-promote accumulated stale lines.
    const waveLines = (second.match(/^  Wave \*\*/gm) ?? []).length;
    expect(waveLines).toBe(2);
    // Shows the fresh counts, not the stale first-promote ones.
    expect(second).toContain('Wave **w2**: 2 total · 2 passed · 0 in-flight');
    expect(second).not.toContain('Wave **w2**: 2 total · 0 passed · 2 in-flight');
    // User-authored State/Next preserved verbatim.
    expect(second).toContain('**State:** s');
    expect(second).toContain('**Next:** n');
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

describe('buildPromotedRows — record the realized parallelism structure (P-041)', () => {
  it('records a bare id + title when no structure is present', () => {
    const rows = buildPromotedRows([{ title: 'Build API' }], ['F-AUTO-1']);
    expect(rows).toEqual(['- [ ] F-AUTO-1 — Build API']);
  });

  it('preserves the from_items provenance comment', () => {
    const rows = buildPromotedRows([{ title: 'X', from_items: ['P-001'] }], ['F-1']);
    expect(rows[0]).toBe('- [ ] F-1 — X <!-- P-001 -->');
  });

  it('records wave + order + blocked_by structure', () => {
    const rows = buildPromotedRows(
      [{ title: 'UI', blocked_by: ['F-API'], order: 2, from_items: ['P-009'] }],
      ['F-UI'],
      'w2',
    );
    expect(rows[0]).toBe('- [ ] F-UI — UI — wave w2 · order 2 · blocked_by F-API <!-- P-009 -->');
  });

  it('rewrites a blocked_by ref that points at a batch peer → its allocated id', () => {
    // F-200 (UI) is blocked_by the batch peer titled "API" → recorded as F-100.
    const rows = buildPromotedRows(
      [
        { title: 'API' },
        { title: 'UI', blocked_by: ['API'] },
      ],
      ['F-100', 'F-200'],
    );
    expect(rows[1]).toBe('- [ ] F-200 — UI — blocked_by F-100');
  });

  it('keeps a blocked_by ref to an existing (non-batch) feature verbatim', () => {
    const rows = buildPromotedRows([{ title: 'UI', blocked_by: ['F-EXISTING'] }], ['F-1']);
    expect(rows[0]).toBe('- [ ] F-1 — UI — blocked_by F-EXISTING');
  });

  it('still matches the upsertPromotedBlock dedup id regex', () => {
    const rows = buildPromotedRows([{ title: 'UI', blocked_by: ['F-A'], order: 1 }], ['F-AUTO-XY1'], 'w1');
    // The dedup in upsertPromotedBlock keys on `^- [ ] (F-...)`; round-trip it.
    const out = upsertPromotedBlock(BASE_PLAN, rows);
    const again = upsertPromotedBlock(out, rows);
    expect(again).toBe(out); // second promote of the same id is a no-op
  });
});
