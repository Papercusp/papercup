/**
 * EI-18793956567250851: "A legacy plan still SERVES claimable work-items but
 * refuses every structured write (legacy_plan) — a decision-gated item
 * becomes unresolvable, and no detector exists."
 *
 * Covers the two additive fixes:
 *  1. parser.ts: `legacyReason` names WHY isLegacy fired, and detects the
 *     sharpest case — a well-formed frontmatter block present but DISPLACED
 *     (not at file position 0) — distinctly from "no frontmatter at all".
 *  2. lint.ts: a legacy plan that still carries non-terminal items is no
 *     longer silently exempt — it's flagged as an error (the detector the
 *     bug report says didn't exist).
 */
import { describe, it, expect } from 'vitest';
import { parsePlan } from '../parser';
import { lintParsed } from '../lint';

describe('parsePlan — legacyReason (EI-18793956567250851)', () => {
  it('no_frontmatter: a file with nothing resembling a --- block', () => {
    const p = parsePlan('# No frontmatter\n\nJust prose.');
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('no_frontmatter');
    expect(p.parseNotices).toEqual([]);
  });

  it('missing_slug: frontmatter present but no slug field', () => {
    const p = parsePlan('---\ntitle: Half-frontmatter\nstatus: draft\n---\n\nBody.');
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('missing_slug');
  });

  it('missing_status: frontmatter present with slug but no status field', () => {
    const p = parsePlan('---\ntitle: T\nslug: x\n---\n\nBody.');
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('missing_status');
  });

  it('invalid_status: status present but not a recognised token', () => {
    const p = parsePlan('---\ntitle: T\nslug: x\nstatus: bogus\n---\n\nBody.');
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('invalid_status');
  });

  it('frontmatter_displaced: the exact repro shape — a `## Now` block placed ABOVE a well-formed frontmatter block', () => {
    const source =
      '## Now\n\n' +
      '**State:** DECISION-GATED (D-003) — do not proceed until D-003 is settled.\n' +
      '**Next:** settle D-003.\n\n' +
      // ~200 lines of unrelated content in the real repro; a handful here is enough
      // to prove the scanner isn't just checking "the second line".
      'Some unrelated prose.\n\nMore prose.\n\n' +
      '---\n' +
      'title: Displaced plan\n' +
      'slug: displaced-plan\n' +
      'status: draft\n' +
      '---\n\n' +
      '## Decisions\n\n### D-003 — pending\nBody.\n';

    const p = parsePlan(source, { filePath: 'displaced-plan.md' });
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('frontmatter_displaced');
    // Exactly ONE displaced-frontmatter notice. Other, unrelated notices may ride alongside
    // (the parser also reports mid-word hard line breaks in body text, and a displaced
    // frontmatter block IS body text to the parser), so select the notice by its shape
    // instead of asserting it is the only one.
    const displaced = p.parseNotices.filter((n) => /well-formed frontmatter block/i.test(n));
    expect(displaced, `notices: ${JSON.stringify(p.parseNotices)}`).toHaveLength(1);
    expect(displaced[0]).toMatch(/position 0/i);
  });

  it('does NOT false-positive on an unrelated markdown horizontal rule pair', () => {
    // Two `---` lines that do NOT bound a slug+status block must not be
    // mistaken for a displaced frontmatter block.
    const source = '## Now\n\n**State:** x\n**Next:** y\n\n---\n\nSome prose under a horizontal rule.\n\n---\n\nMore prose.\n';
    const p = parsePlan(source);
    expect(p.isLegacy).toBe(true);
    expect(p.legacyReason).toBe('no_frontmatter');
  });

  it('a well-formed plan (frontmatter at position 0) is never legacy and carries no legacyReason', () => {
    const source =
      '---\ntitle: T\nslug: fine-plan\nstatus: active\n---\n\n' +
      '## Now\n\n**State:** x\n**Next:** y\n';
    const p = parsePlan(source);
    expect(p.isLegacy).toBe(false);
    expect(p.legacyReason).toBeNull();
  });
});

describe('plans:lint — legacy_plan_with_live_items (EI-18793956567250851)', () => {
  it('flags an ERROR when a legacy plan still carries non-terminal items', async () => {
    const source =
      '## Now\n\n**State:** x\n**Next:** y\n\n' +
      '## Phase 1\n\n- **P-001** `todo` do a thing\n\n' +
      '---\ntitle: T\nslug: legacy-with-items\nstatus: draft\n---\n';
    const parsed = parsePlan(source, { filePath: 'legacy-with-items.md' });
    expect(parsed.isLegacy).toBe(true);
    expect(parsed.items).toHaveLength(1);

    const report = await lintParsed(parsed, 'legacy-with-items', false);
    expect(report.legacy).toBe(true);
    expect(report.exempt).toBe(true);
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain('legacy_plan_with_live_items');
    const finding = report.errors.find((e) => e.code === 'legacy_plan_with_live_items')!;
    expect(finding.message).toMatch(/P-001/);
    expect(finding.message).toMatch(/frontmatter_displaced|displaced/i);
  });

  it('does NOT flag when the legacy plan has no items at all', async () => {
    const parsed = parsePlan('# No frontmatter\n\nJust prose, no items.');
    const report = await lintParsed(parsed, 'legacy-empty', false);
    expect(report.legacy).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('does NOT flag when every item is terminal (done/dropped)', async () => {
    const source =
      '## Now\n\n**State:** x\n**Next:** y\n\n' +
      '## Phase 1\n\n- **P-001** `done` finished\n- **P-002** `dropped` abandoned\n\n' +
      '---\ntitle: T\nslug: legacy-done\nstatus: draft\n---\n';
    const parsed = parsePlan(source);
    expect(parsed.isLegacy).toBe(true);
    const report = await lintParsed(parsed, 'legacy-done', false);
    expect(report.errors).toEqual([]);
  });

  it('a normal (non-legacy) plan is unaffected by the new check', async () => {
    const source =
      '---\ntitle: T\nslug: fine-plan\nstatus: active\n---\n\n' +
      '## Now\n\n**State:** x\n**Next:** y\n\n' +
      '## Phase 1\n\n- **P-001** `todo` do a thing\n\n' +
      '## Decisions\n\n### D-001 — a decision\nBody. Related: P-001\n';
    const parsed = parsePlan(source);
    expect(parsed.isLegacy).toBe(false);
    const report = await lintParsed(parsed, 'fine-plan', false);
    expect(report.errors.map((e) => e.code)).not.toContain('legacy_plan_with_live_items');
  });
});
