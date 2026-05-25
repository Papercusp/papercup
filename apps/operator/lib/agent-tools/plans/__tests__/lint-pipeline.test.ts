/**
 * P-004 / D-005 — missing_promoted_block: warning before migration date,
 * error after. Trigger is SEMANTIC: the check fires only when
 * harness_features_consolidated has rows whose source_plan_slug equals
 * this plan's slug. Regex-scanning prose mentions of F-NNN ids was a
 * false-positive trap (a plan mentioning `F-FIX-024` in documentation
 * prose tripped the rule) and was removed in favour of the PG lookup.
 *
 * These tests focus on the false-positive fix (no rule fires when no
 * features in PG claim this plan as their source) — the positive
 * paths require a populated PG fixture and are covered by end-to-end
 * tests against a live workspace.
 */

import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { lintParsed } from '../lint';

function frontmatter(slug: string, createdDate: string): string {
  return `---
title: Demo Plan
slug: ${slug}
status: active
created: ${createdDate}
updated: ${createdDate}
owner: test@example.com
---
`;
}

const NOW_BLOCK = `\n## Now\n\n**State:** Active\n**Next:** Do things.\n`;
const DECISIONS_BLOCK = `\n## Decisions\n\n### D-001 — First\nDate: 2026-05-24\nDecided.\n`;

function makePlan(slug: string, body: string, createdDate = '2026-05-20'): string {
  return frontmatter(slug, createdDate) + NOW_BLOCK + body + DECISIONS_BLOCK;
}

describe('lint missing_promoted_block — false-positive fix', () => {
  it('does NOT fire when plan body mentions a feature id in prose but no PG row claims this plan', async () => {
    // The original failure mode the user reported: a plan that
    // documents how F-FIX-024 works tripped the syntactic regex
    // check. The new semantic check stays quiet because PG has no
    // row whose source_plan_slug matches this plan's slug.
    const slug = `lint-prose-only-${Date.now()}`;
    const doc = makePlan(
      slug,
      '\n## Phase 1\n\n- **P-001** `done` Documents how F-FIX-024 works.\n\nSee also F-AUTO-XYZ.\n',
      '2026-05-25', // post-migration date
    );
    const parsed = parsePlan(doc, { filePath: `/fake/${slug}.md` });
    const report = await lintParsed(parsed, slug, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('does NOT fire on a plan with no feature id mentions at all', async () => {
    const slug = `lint-no-refs-${Date.now()}`;
    const doc = makePlan(slug, '\n## Phase 1\n\n- **P-001** `todo` Plain item, no feature refs.\n', '2026-05-20');
    const parsed = parsePlan(doc, { filePath: `/fake/${slug}.md` });
    const report = await lintParsed(parsed, slug, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('does NOT fire when plan has ## Promoted block', async () => {
    // The block silences the check unconditionally — same shape as
    // backfilled plans.
    const slug = `lint-has-block-${Date.now()}`;
    const doc = makePlan(
      slug,
      '\n## Promoted\n\n- [ ] F-AUTO-ABC123 — Feature\n\n## Phase 1\n\n- **P-001** `done` Item.\n',
      '2026-05-25',
    );
    const parsed = parsePlan(doc, { filePath: `/fake/${slug}.md` });
    const report = await lintParsed(parsed, slug, false);
    expect(report.warnings.some((w) => w.code === 'missing_promoted_block')).toBe(false);
    expect(report.errors.some((e) => e.code === 'missing_promoted_block')).toBe(false);
  });

  it('is not emitted for legacy plans (no frontmatter)', async () => {
    const legacy = '# Old plan\n\nF-AUTO-ABC123 mentioned here.\n';
    const parsed = parsePlan(legacy, { filePath: `/fake/legacy.md` });
    const report = await lintParsed(parsed, 'legacy', false);
    expect(report.exempt).toBe(true);
    expect(report.warnings).toHaveLength(0);
  });
});
