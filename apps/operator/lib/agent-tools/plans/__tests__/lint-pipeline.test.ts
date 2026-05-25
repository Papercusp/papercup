/**
 * P-006: Phase A lint tests — missing_promoted_block warning.
 */

import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { lintParsed } from '../lint';

const FRONTMATTER = `---
title: Demo Plan
slug: demo-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
owner: test@example.com
---
`;

const NOW_BLOCK = `\n## Now\n\n**State:** Active\n**Next:** Do things.\n`;
const DECISIONS_BLOCK = `\n## Decisions\n\n### D-001 — First\nDate: 2026-05-24\nDecided.\n`;

function makePlan(body: string): string {
  return FRONTMATTER + NOW_BLOCK + body + DECISIONS_BLOCK;
}

describe('lint missing_promoted_block warning', () => {
  it('emits warning when plan mentions a feature id but has no ## Promoted block', async () => {
    const doc = makePlan('\n## Phase 1\n\n- **P-001** `done` Item.\n\nSee F-AUTO-ABC123 for details.\n');
    const parsed = parsePlan(doc, { filePath: '/fake/demo-2026-05-24.md' });
    const report = await lintParsed(parsed, 'demo-2026-05-24', false);
    const warning = report.warnings.find((w) => w.code === 'missing_promoted_block');
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warning');
  });

  it('also fires for F-NNN-NNN style feature ids', async () => {
    const doc = makePlan('\nPromoted feature: F-FEAT-001.\n');
    const parsed = parsePlan(doc, { filePath: '/fake/demo-2026-05-24.md' });
    const report = await lintParsed(parsed, 'demo-2026-05-24', false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(true);
  });

  it('does NOT warn when plan has ## Promoted block', async () => {
    const doc = makePlan('\n## Promoted\n\n- [ ] F-AUTO-ABC123 — Feature\n\n## Phase 1\n\n- **P-001** `done` Item.\n');
    const parsed = parsePlan(doc, { filePath: '/fake/demo-2026-05-24.md' });
    const report = await lintParsed(parsed, 'demo-2026-05-24', false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
  });

  it('does NOT warn when plan has no feature id references at all', async () => {
    const doc = makePlan('\n## Phase 1\n\n- **P-001** `todo` Plain item, no feature refs.\n');
    const parsed = parsePlan(doc, { filePath: '/fake/demo-2026-05-24.md' });
    const report = await lintParsed(parsed, 'demo-2026-05-24', false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
  });

  it('is not emitted for legacy plans', async () => {
    const legacy = '# Old plan\n\nF-AUTO-ABC123 mentioned here.\n';
    const parsed = parsePlan(legacy, { filePath: '/fake/demo-2026-05-24.md' });
    const report = await lintParsed(parsed, 'demo-2026-05-24', false);
    // legacy plans return early — exempt is true, no checks run
    expect(report.exempt).toBe(true);
    expect(report.warnings).toHaveLength(0);
  });
});
