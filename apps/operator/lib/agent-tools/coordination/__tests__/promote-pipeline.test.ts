/**
 * P-006: Phase A pipeline tests — upsertPromotedBlock round-trips.
 */

import { describe, expect, it } from 'vitest';
import { upsertPromotedBlock } from '../tools/promote';

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
