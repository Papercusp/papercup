/**
 * set-content-shrink-guard.test.ts — the mass-deletion guard on
 * `evaluateSetContent` (EI-83 / full-app-audit P-040) and the chunked-write
 * draft hygiene that rides on it (audit P-043).
 *
 * A proposed body under SUSPICIOUS_SHRINK_RATIO (20%) of the live plan is
 * far more often a truncated paste / wrong-plan write than an intentional
 * rewrite — it rejects `suspicious_shrink` unless the caller passes
 * `allowShrink: true`. The chunk tool keeps the draft on that rejection so
 * the caller can re-commit with the flag instead of re-streaming.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateSetContent, SUSPICIOUS_SHRINK_RATIO } from '../set-content';
import { shouldRemoveDraftOnFailure, sweepStaleDrafts } from '../set-content-chunk';
import { hashPlanContent } from '../content-hash';

const SLUG = 'shrink-guard-2026-06-10';

const PADDING = Array.from({ length: 60 }, (_, i) => `Padding prose line ${i} — lorem ipsum dolor sit amet, filler filler filler.`).join('\n');

/** A lint-clean plan made deliberately large via Background padding. */
const CURRENT = `---
title: Shrink Guard
slug: ${SLUG}
created: 2026-06-10
updated: 2026-06-10
status: active
---

# Shrink Guard

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

${PADDING}

## Decisions
`;

/** Same plan with the padding dropped — lint-clean but a >80% shrink. */
const TINY = `---
title: Shrink Guard
slug: ${SLUG}
created: 2026-06-10
updated: 2026-06-10
status: active
---

# Shrink Guard

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Decisions
`;

/** A ~50% body — under the guard's trigger, must pass un-flagged. */
const HALF = CURRENT.replace(
  PADDING,
  PADDING.slice(0, Math.floor(PADDING.length / 2)).replace(/[^\n]*$/, 'Trimmed.'),
);

describe('evaluateSetContent — suspicious_shrink guard (EI-83 / audit P-040)', () => {
  it('rejects a >80% shrink without allowShrink, reporting both lengths', async () => {
    expect(TINY.length).toBeLessThan(CURRENT.length * SUSPICIOUS_SHRINK_RATIO); // test premise
    const r = await evaluateSetContent(CURRENT, TINY, SLUG, undefined, {});
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'suspicious_shrink') {
      expect(r.value.currentLength).toBe(CURRENT.length);
      expect(r.value.proposedLength).toBe(TINY.length);
    } else {
      expect.fail(`expected suspicious_shrink, got ${JSON.stringify(r.value)}`);
    }
  });

  it('allows the same shrink with allowShrink: true', async () => {
    const r = await evaluateSetContent(CURRENT, TINY, SLUG, undefined, { allowShrink: true });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(TINY);
  });

  it('a moderate (~50%) shrink passes without the flag', async () => {
    expect(HALF.length).toBeGreaterThan(CURRENT.length * SUSPICIOUS_SHRINK_RATIO); // test premise
    const r = await evaluateSetContent(CURRENT, HALF, SLUG, undefined, {});
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(HALF);
  });

  it('CAS still wins: a stale baseline reports stale, not suspicious_shrink', async () => {
    const r = await evaluateSetContent(CURRENT, TINY, SLUG, 'not-the-live-hash', {});
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('stale');
  });

  it('growth and same-size writes are untouched by the guard', async () => {
    const grown = CURRENT.replace('## Decisions', '## Decisions\n\n### D-001 — extra\nDate: 2026-06-10\nbody');
    const r = await evaluateSetContent(CURRENT, grown, SLUG, hashPlanContent(CURRENT), {});
    expect(r.value.ok).toBe(true);
  });
});

describe('chunked-write draft hygiene (audit P-043)', () => {
  it('keeps the draft on retryable failures, removes it on terminal-content ones', () => {
    // Retryable — the SAME draft can be re-committed (fresh hash / allowShrink).
    expect(shouldRemoveDraftOnFailure('stale')).toBe(false);
    expect(shouldRemoveDraftOnFailure('suspicious_shrink')).toBe(false);
    // Terminal — the content itself is rejected; re-commit can never succeed.
    expect(shouldRemoveDraftOnFailure('lint_failed')).toBe(true);
    expect(shouldRemoveDraftOnFailure('would_orphan_frontmatter')).toBe(true);
    expect(shouldRemoveDraftOnFailure('not_found')).toBe(true);
  });

  it('sweepStaleDrafts removes only drafts past the 24h TTL', async () => {
    const dir = path.join(os.tmpdir(), 'papercusp-plan-content-drafts');
    await fs.mkdir(dir, { recursive: true });
    const stale = path.join(dir, `janitor-test-stale-${process.pid}.md`);
    const fresh = path.join(dir, `janitor-test-fresh-${process.pid}.md`);
    try {
      await fs.writeFile(stale, 'old draft', 'utf8');
      await fs.writeFile(fresh, 'new draft', 'utf8');
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.utimes(stale, old, old);

      await sweepStaleDrafts();

      await expect(fs.access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(fresh)).resolves.toBeUndefined();
    } finally {
      await fs.rm(stale, { force: true });
      await fs.rm(fresh, { force: true });
    }
  });
});
