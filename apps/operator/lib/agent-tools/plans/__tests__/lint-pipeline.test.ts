/**
 * P-004 / D-005 — missing_promoted_block: warning before migration date,
 * error after.
 */

import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { lintParsed } from '../lint';

const MIGRATION_DATE = '2026-05-24'; // see lint.ts PROMOTED_BLOCK_ENFORCEMENT_DATE

function frontmatter(createdDate: string): string {
  return `---
title: Demo Plan
slug: demo-${createdDate}
status: active
created: ${createdDate}
updated: ${createdDate}
owner: test@example.com
---
`;
}

const NOW_BLOCK = `\n## Now\n\n**State:** Active\n**Next:** Do things.\n`;
const DECISIONS_BLOCK = `\n## Decisions\n\n### D-001 — First\nDate: 2026-05-24\nDecided.\n`;

function makePlan(body: string, createdDate = '2026-05-20'): string {
  return frontmatter(createdDate) + NOW_BLOCK + body + DECISIONS_BLOCK;
}

describe('lint missing_promoted_block — pre-migration plans get warning', () => {
  const PRE = '2026-05-20'; // before migration enforcement date

  it('emits warning when plan mentions a feature id but has no ## Promoted block', async () => {
    const doc = makePlan('\n## Phase 1\n\n- **P-001** `done` Item.\n\nSee F-AUTO-ABC123 for details.\n', PRE);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${PRE}.md` });
    const report = await lintParsed(parsed, `demo-${PRE}`, false);
    const finding = report.warnings.find((w) => w.code === 'missing_promoted_block');
    expect(finding).toBeDefined();
    expect(finding?.level).toBe('warning');
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('also fires for F-NNN-NNN style feature ids', async () => {
    const doc = makePlan('\nPromoted feature: F-FEAT-001.\n', PRE);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${PRE}.md` });
    const report = await lintParsed(parsed, `demo-${PRE}`, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(true);
  });

  it('does NOT warn when plan has ## Promoted block', async () => {
    const doc = makePlan('\n## Promoted\n\n- [ ] F-AUTO-ABC123 — Feature\n\n## Phase 1\n\n- **P-001** `done` Item.\n', PRE);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${PRE}.md` });
    const report = await lintParsed(parsed, `demo-${PRE}`, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('does NOT warn when plan has no feature id references at all', async () => {
    const doc = makePlan('\n## Phase 1\n\n- **P-001** `todo` Plain item, no feature refs.\n', PRE);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${PRE}.md` });
    const report = await lintParsed(parsed, `demo-${PRE}`, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('is not emitted for legacy plans', async () => {
    const legacy = '# Old plan\n\nF-AUTO-ABC123 mentioned here.\n';
    const parsed = parsePlan(legacy, { filePath: `/fake/demo-${PRE}.md` });
    const report = await lintParsed(parsed, `demo-${PRE}`, false);
    // legacy plans return early — exempt is true, no checks run
    expect(report.exempt).toBe(true);
    expect(report.warnings).toHaveLength(0);
  });
});

describe('lint missing_promoted_block — post-migration plans get error (D-005)', () => {
  const POST = '2026-05-25'; // after migration enforcement date

  it('emits error when plan mentions a feature id but has no ## Promoted block', async () => {
    const doc = makePlan('\n## Phase 1\n\n- **P-001** `done` Item.\n\nSee F-AUTO-ABC123 for details.\n', POST);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${POST}.md` });
    const report = await lintParsed(parsed, `demo-${POST}`, false);
    const finding = report.errors.find((e) => e.code === 'missing_promoted_block');
    expect(finding).toBeDefined();
    expect(finding?.level).toBe('error');
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
  });

  it('does NOT error when plan has ## Promoted block', async () => {
    const doc = makePlan('\n## Promoted\n\n- [ ] F-AUTO-ABC123 — Feature\n\n## Phase 1\n\n- **P-001** `done` Item.\n', POST);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${POST}.md` });
    const report = await lintParsed(parsed, `demo-${POST}`, false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
  });

  it('plan exactly on the enforcement date is treated as post-migration (error)', async () => {
    const doc = makePlan('\n## Phase 1\n\nSee F-AUTO-A1 for details.\n', MIGRATION_DATE);
    const parsed = parsePlan(doc, { filePath: `/fake/demo-${MIGRATION_DATE}.md` });
    const report = await lintParsed(parsed, `demo-${MIGRATION_DATE}`, false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(true);
  });
});
