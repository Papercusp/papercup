/**
 * Pure-logic unit tests for plans:edit (the targeted old_string → new_string
 * verb). Exercises the exact-match guard + delegation to the shared
 * evaluateSetContent CAS/legacy/lint core, without the SU lock side-database.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePlanEdit } from '../edit';
import { hashPlanContent } from '../content-hash';

const SLUG = 'test-plan-2026-05-21';

/** A minimal non-legacy plan that lints clean. */
const VALID = `---
title: Test Plan
slug: ${SLUG}
created: 2026-05-21
updated: 2026-05-21
status: active
---

# Test Plan

## Now

**State:** Where things stand. The widget runs at 22 fps.

**Next:** The next concrete action.

## Background

The widget runs at 22 fps in two places: 22 fps here.

## Decisions
`;

describe('evaluatePlanEdit — match guard', () => {
  it('not_found when the file is absent', async () => {
    const r = await evaluatePlanEdit(null, 'a', 'b', false, SLUG, undefined);
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('not_found');
    expect(r.newBody).toBeNull();
  });

  it('no_change when old_string === new_string', async () => {
    const r = await evaluatePlanEdit(VALID, 'same', 'same', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('no_change');
  });

  it('string_not_found when old_string is absent', async () => {
    const r = await evaluatePlanEdit(VALID, 'not-in-the-document', 'x', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('string_not_found');
  });

  it('string_not_unique when old_string occurs >1 time without replace_all', async () => {
    const r = await evaluatePlanEdit(VALID, '22 fps', '30 fps', false, SLUG, undefined);
    expect(r.value.ok).toBe(false);
    if (r.value.ok === false && r.value.code === 'string_not_unique') {
      expect(r.value.count).toBe(3);
    } else {
      throw new Error('expected string_not_unique');
    }
  });
});

describe('evaluatePlanEdit — successful edits', () => {
  it('replaces a unique occurrence and returns the new body', async () => {
    const r = await evaluatePlanEdit(VALID, 'The next concrete action.', 'Ship the widget.', false, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toContain('Ship the widget.');
    expect(r.newBody).not.toContain('The next concrete action.');
    // everything else preserved
    expect(r.newBody).toContain('## Now');
    expect(r.newBody).toContain('## Background');
  });

  it('replace_all rewrites every occurrence', async () => {
    const r = await evaluatePlanEdit(VALID, '22 fps', '30 fps', true, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).not.toContain('22 fps');
    expect((r.newBody!.match(/30 fps/g) ?? []).length).toBe(3);
  });

  it('new_string may be empty (deletes old_string)', async () => {
    const r = await evaluatePlanEdit(VALID, ' The widget runs at 22 fps.', '', false, SLUG, undefined);
    expect(r.value.ok).toBe(true);
    expect(r.newBody).not.toContain('runs at 22 fps.');
  });
});

describe('evaluatePlanEdit — CAS + lint inherited from evaluateSetContent', () => {
  it('rejects stale when expectedHash does not match', async () => {
    const r = await evaluatePlanEdit(VALID, 'concrete action', 'action', false, SLUG, 'deadbeef-not-the-hash');
    expect(r.value.ok === false && r.value.code).toBe('stale');
  });

  it('proceeds when expectedHash matches', async () => {
    const r = await evaluatePlanEdit(VALID, 'concrete action', 'action', false, SLUG, hashPlanContent(VALID));
    expect(r.value.ok).toBe(true);
  });

  it('lint_failed when the edit removes the required ## Now section', async () => {
    const r = await evaluatePlanEdit(VALID, '## Now', '## Nowww', false, SLUG, undefined);
    expect(r.value.ok === false && r.value.code).toBe('lint_failed');
  });
});
