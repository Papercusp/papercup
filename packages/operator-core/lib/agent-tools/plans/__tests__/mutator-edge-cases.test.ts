/**
 * mutator-edge-cases.test.ts — targeted edge-case coverage for the plan-body
 * mutators + the set-content/edit CAS core that the broader write-mutators /
 * phase5-mutators / cas-precedence suites do not pin.
 *
 * Each block corresponds to a documented coverage gap:
 *
 *   • P1-6  appendDecisionToBody  — a plan whose ONLY decisions heading is the
 *           suffixed `## Decisions (settled)` (no canonical heading, no following
 *           heading) must produce ONE deterministic outcome: the settled section is
 *           left untouched and a SINGLE canonical `## Decisions` is created at EOF.
 *           Pins that no duplicate canonical heading is forked.
 *   • P2-8  replaceNowBlock       — trailing-inline / unclosed frontmatter must not
 *           silently TRUNCATE body content. Pins both the regex branch (a Now block
 *           that is the document's last section) and the insert branch (no Now;
 *           frontmatter close line carries inline text with no trailing newline).
 *   • P1-7  evaluateSetContent / evaluatePlanEdit — when a concurrent write advanced
 *           the version between the CAS baseline and this write, the rejection must
 *           be a clean `stale` reporting the LIVE version, NOT a lint/parse failure
 *           attributed to the proposed body. Pins the version-CAS-before-lint order.
 *
 * Pure: drives the exported decision functions directly — no lock / PG.
 */

import { describe, expect, it } from 'vitest';
import { appendDecisionToBody } from '../add-decision';
import { replaceNowBlock } from '../set-now';
import { evaluateSetContent } from '../set-content';
import { evaluatePlanEdit } from '../edit';
import { hashPlanContent } from '../content-hash';

// ── P1-6 ──────────────────────────────────────────────────────────────────────
describe('appendDecisionToBody — only a suffixed "## Decisions (settled)" heading (P1-6)', () => {
  // The settled-only plan: the suffixed heading is a DIFFERENT section from the
  // canonical `## Decisions` the plans:get parser reads, and there is NO following
  // heading, so the EOF-append branch runs. The deterministic, correct outcome is a
  // SINGLE canonical `## Decisions` appended at EOF — the settled section is never
  // touched and is never duplicated into a second canonical heading.
  const SETTLED_ONLY = `---
title: t
slug: t
status: draft
---

# t

## Decisions (settled)

### D-001 — old settled decision
Date: 2026-05-01
settled body
`;

  it('creates exactly ONE canonical "## Decisions" section (no fork) and leaves the settled one intact', () => {
    const out = appendDecisionToBody(SETTLED_ONLY, 'D-003', 'Fresh', 'Fresh body.', '2026-05-20', []);

    // The suffixed settled section is untouched — the new decision did not absorb into it.
    const settledSection = out.slice(
      out.indexOf('## Decisions (settled)'),
      out.indexOf('## Decisions\n'),
    );
    expect(settledSection).toContain('### D-001 — old settled decision');
    expect(settledSection).not.toContain('D-003');

    // Exactly one suffixed heading and exactly one canonical heading — no fork.
    expect(out.match(/^## Decisions \(settled\)$/gm) ?? []).toHaveLength(1);
    expect(out.match(/^## Decisions$/gm) ?? []).toHaveLength(1);

    // The new decision landed in the canonical section.
    expect(out).toContain('### D-003 — Fresh');
    expect(out.indexOf('### D-003')).toBeGreaterThan(out.indexOf('## Decisions\n'));
  });

  it('is idempotent across repeated appends — never grows a second canonical heading', () => {
    const once = appendDecisionToBody(SETTLED_ONLY, 'D-003', 'First fresh', 'b.', '2026-05-20', []);
    const twice = appendDecisionToBody(once, 'D-004', 'Second fresh', 'b.', '2026-05-21', []);
    // Still exactly one canonical heading; the second decision joined the same section.
    expect(twice.match(/^## Decisions$/gm) ?? []).toHaveLength(1);
    expect(twice).toContain('### D-003 — First fresh');
    expect(twice).toContain('### D-004 — Second fresh');
    // No stacked blank lines from the repeated splice.
    expect(twice).not.toContain('\n\n\n');
  });
});

// ── P2-8 ──────────────────────────────────────────────────────────────────────
describe('replaceNowBlock — trailing-inline / unclosed frontmatter does not truncate (P2-8)', () => {
  it('regex branch: a Now block that is the LAST section is replaced wholesale (its trailing prose is part of it, not truncated)', () => {
    // The Now block has no following `## ` heading, so everything after `## Now`
    // belongs to it. Replacing it correctly swaps the whole block; nothing leaks or
    // is dropped from OTHER sections (there are none after it). Frontmatter is intact.
    const doc = `---
title: x
---junk

## Now

old state line

old next line`;
    const out = replaceNowBlock(doc, 'new state', 'new next');
    // Exactly one Now block; the old Now content is gone; the new content is present.
    expect(out.match(/^## Now/gm) ?? []).toHaveLength(1);
    expect(out.match(/\*\*Next:\*\*/g) ?? []).toHaveLength(1);
    expect(out).toContain('**State:** new state');
    expect(out).toContain('**Next:** new next');
    expect(out).not.toContain('old state line');
    expect(out).not.toContain('old next line');
    // The trailing-inline frontmatter close (`---junk`) survived — frontmatter intact.
    expect(out).toContain('---junk');
    expect(out.startsWith('---\ntitle: x\n---junk')).toBe(true);
  });

  it('insert branch: frontmatter close line carries inline text with NO trailing newline → Now is APPENDED, nothing truncated', () => {
    // set-now.ts:50 computes the insert point via indexOf('\n', close+4). When the
    // close line (`---junk`) has no newline after it, indexOf returns -1 and the insert
    // falls back to body.length — appending the Now block at EOF. The pre-existing
    // frontmatter-close-line content must SURVIVE (insert at body.length drops nothing).
    const doc = '---\ntitle: x\n---junk';
    const out = replaceNowBlock(doc, 'new state', 'new next');
    expect(out).toContain('---junk'); // the inline close-line text is preserved
    expect(out).toContain('## Now');
    expect(out).toContain('**State:** new state');
    expect(out).toContain('**Next:** new next');
  });

  it('insert branch: a body section AFTER trailing-inline frontmatter survives intact when a Now is inserted', () => {
    const doc = `---
title: x
---junk

## Background

bg content that must survive

more trailing prose`;
    const out = replaceNowBlock(doc, 'fresh state', 'fresh next');
    // The whole Background section + its trailing prose survive — no truncation.
    expect(out).toContain('## Background');
    expect(out).toContain('bg content that must survive');
    expect(out).toContain('more trailing prose');
    // The inserted Now sits before Background (right after the frontmatter close line).
    expect(out).toContain('**State:** fresh state');
    expect(out.indexOf('## Now')).toBeLessThan(out.indexOf('## Background'));
  });
});

// ── P1-7 ──────────────────────────────────────────────────────────────────────
describe('evaluateSetContent / evaluatePlanEdit — version-CAS precedes lint (P1-7)', () => {
  const SLUG = 't-2026-06-16';
  /** A lint-clean non-legacy plan. */
  const LIVE = `---
title: Test Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: active
---

# Test Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Decisions
`;
  /** A proposed body that FAILS lint (missing the required ## Now section). */
  const PROPOSED_LINT_FAILS = `---
title: Test Plan
slug: ${SLUG}
created: 2026-06-16
updated: 2026-06-16
status: active
---

# Test Plan

Just prose, no Now block.
`;

  it('set-content: stale version + lint-failing proposed body → rejects STALE reporting the live version, never lint_failed', async () => {
    // The CAS baseline (expectedVersion=10) is behind the live row (version=11): a
    // concurrent write advanced it. The rejection must be the clean stale signal the
    // UI can reload from — NOT a lint failure of the proposed body (which the version
    // mismatch makes moot). Pins set-content.ts: version CAS (§1) runs before lint (§3).
    const r = await evaluateSetContent(LIVE, PROPOSED_LINT_FAILS, SLUG, undefined, {
      expectedVersion: 10,
      meta: { version: 11, contentHash: hashPlanContent(LIVE) },
    });
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false) {
      expect(r.value.code).toBe('stale');
      if (r.value.code === 'stale') {
        expect(r.value.currentVersion).toBe(11); // the LIVE version, for the UI to reload
        expect(r.value.currentContent).toBe(LIVE);
      }
    }
  });

  it('set-content: stale HASH + lint-failing proposed body → also rejects STALE, not lint_failed', async () => {
    // The same precedence for the legacy hash CAS: a mismatched expectedHash rejects
    // stale before the proposed body is ever linted.
    const r = await evaluateSetContent(LIVE, PROPOSED_LINT_FAILS, SLUG, 'deadbeef-not-the-live-hash');
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false) expect(r.value.code).toBe('stale');
  });

  it('edit: stale version + a replacement that would lint-fail → rejects STALE (the shared CAS core, via edit.ts)', async () => {
    // plans:edit reuses evaluateSetContent for CAS/legacy/lint, so the same ordering
    // must hold on the edit path: a stale version short-circuits before the linted
    // (Now-stripping) replacement body is evaluated.
    const r = await evaluatePlanEdit(
      LIVE,
      '## Now\n\n**State:** Where things stand.\n\n**Next:** The next concrete action.\n',
      'Just prose, no Now block.\n',
      false,
      SLUG,
      undefined,
      { expectedVersion: 10, meta: { version: 11, contentHash: hashPlanContent(LIVE) } },
    );
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false) {
      expect(r.value.code).toBe('stale');
      if (r.value.code === 'stale') expect(r.value.currentVersion).toBe(11);
    }
  });

  it('control: matching version + lint-failing proposed body → THEN lint_failed surfaces (the gate is not bypassed)', async () => {
    // When CAS passes, the lint gate genuinely fires — proving the stale results above
    // come from the CAS short-circuit, not from lint being skipped entirely.
    const r = await evaluateSetContent(LIVE, PROPOSED_LINT_FAILS, SLUG, undefined, {
      expectedVersion: 11,
      meta: { version: 11, contentHash: hashPlanContent(LIVE) },
    });
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false) expect(r.value.code).toBe('lint_failed');
  });
});
