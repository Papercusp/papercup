/**
 * edit-replace-all.test.ts — pure-unit edge cases for `evaluatePlanEdit`'s
 * replace_all path that plans-edit.test.ts (disjoint old/new strings) does not
 * cover.
 *
 * The implementation uses `current.split(oldString).join(newString)` for
 * replace_all. Two non-obvious properties of that single-pass primitive:
 *
 *   1. IDEMPOTENCY / no re-expansion when `new_string` CONTAINS `old_string`.
 *      A naive loop-until-no-match would loop forever on old `"22 fps"` → new
 *      `"22 fps fast"` (each rewrite reintroduces the needle). `split().join()`
 *      is a single clean pass: it splits on the ORIGINAL occurrences and joins
 *      once — the joined-in copies of `old_string` are never re-scanned. We
 *      assert the count is exactly the original occurrence count (no blow-up).
 *
 *   2. A replace_all whose result is byte-for-byte identical to a no-op in one
 *      region but still a real change overall — and the degenerate case where
 *      replacing every occurrence yields a body that no longer differs from the
 *      input is caught upstream by the `old === new` no_change guard, while a
 *      replace_all to empty string (delete-all) is a genuine multi-site delete.
 *
 * Pure: drives `evaluatePlanEdit(current, …)` directly, no lock/PG.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePlanEdit } from '../edit';

const SLUG = 'replace-all-edge-2026-06-04';

/**
 * A minimal non-legacy plan that lints clean. "22 fps" appears exactly 3 times
 * (once in the Now State line, twice in Background) — same shape as the sibling
 * VALID fixture in plans-edit.test.ts.
 */
const VALID = `---
title: Replace All Edge
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# Replace All Edge

## Now

**State:** Where things stand. The widget runs at 22 fps.

**Next:** The next concrete action.

## Background

The widget runs at 22 fps in two places: 22 fps here.

## Decisions
`;

function countOf(body: string, needle: string): number {
  return body.split(needle).length - 1;
}

describe('evaluatePlanEdit — replace_all where new_string CONTAINS old_string', () => {
  it('does a single clean pass: 3 occurrences → exactly 3 expansions, no infinite re-expansion', async () => {
    // old "22 fps" occurs 3×; new "22 fps fast" reintroduces the needle.
    expect(countOf(VALID, '22 fps')).toBe(3);

    const r = await evaluatePlanEdit(VALID, '22 fps', '22 fps fast', true, SLUG, undefined);

    expect(r.value.ok).toBe(true);
    expect(r.newBody).not.toBeNull();
    const body = r.newBody!;
    // Exactly 3 expanded sites — NOT 4, 6, or runaway. split().join() splits on
    // the original 3 boundaries and joins once; the injected "22 fps" copies are
    // never re-scanned.
    expect(countOf(body, '22 fps fast')).toBe(3);
    // And no bare "22 fps" survives that isn't part of a "22 fps fast".
    expect(countOf(body, '22 fps')).toBe(3);
    // Idempotency witness: the byte length grew by exactly 3×len(" fast").
    expect(body.length).toBe(VALID.length + 3 * ' fast'.length);
  });

  it('is stable under repeated application — re-running with the SAME old→new is a fresh single pass, not a compounding one', async () => {
    // First pass.
    const first = await evaluatePlanEdit(VALID, '22 fps', '22 fps fast', true, SLUG, undefined);
    expect(first.value.ok).toBe(true);
    const body1 = first.newBody!;
    // Second pass over the result with the same old="22 fps": there are now
    // still 3 occurrences (each inside "22 fps fast"); replacing them again with
    // "22 fps fast" yields "22 fps fast fast" ×3 — bounded, one " fast" per site,
    // never an unbounded blow-up.
    const second = await evaluatePlanEdit(body1, '22 fps', '22 fps fast', true, SLUG, undefined);
    expect(second.value.ok).toBe(true);
    const body2 = second.newBody!;
    expect(countOf(body2, '22 fps fast fast')).toBe(3);
    expect(body2.length).toBe(body1.length + 3 * ' fast'.length);
  });

  it('a single (non-replace_all) edit where new contains old also expands exactly once', async () => {
    // The unique-match path (string.replace, first occurrence) — replace the
    // UNIQUE Now sentence so the match guard is satisfied.
    const r = await evaluatePlanEdit(
      VALID,
      'The next concrete action.',
      'The next concrete action. (now scheduled)',
      false,
      SLUG,
      undefined,
    );
    expect(r.value.ok).toBe(true);
    expect(countOf(r.newBody!, 'The next concrete action.')).toBe(1);
    expect(r.newBody).toContain('The next concrete action. (now scheduled)');
  });
});

describe('evaluatePlanEdit — replace_all no-op / degenerate results', () => {
  it('rejects no_change BEFORE any replacement when old_string === new_string', async () => {
    // The no_change guard fires before split/join even under replace_all, so a
    // replace_all that would be a textual identity never reaches the body diff.
    const r = await evaluatePlanEdit(VALID, '22 fps', '22 fps', true, SLUG, undefined);
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('no_change');
    expect(r.newBody).toBeNull();
  });

  it('replace_all to empty string deletes EVERY occurrence (multi-site delete)', async () => {
    // "22 fps" is not lint-required text, so deleting all three is a clean,
    // lint-passing multi-site delete — distinct from the single-site delete the
    // sibling test covers.
    const r = await evaluatePlanEdit(VALID, '22 fps', '', true, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(countOf(r.newBody!, '22 fps')).toBe(0);
    // The structure is preserved (only the needle vanished).
    expect(r.newBody).toContain('## Now');
    expect(r.newBody).toContain('## Background');
    expect(r.newBody!.length).toBe(VALID.length - 3 * '22 fps'.length);
  });
});
