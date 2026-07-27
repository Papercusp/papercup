/**
 * set-content-status-regression-guard.test.ts — the item-status-regression
 * guard on `evaluateSetContent` (EI-18756269998422483: "A plan item's `done`
 * status silently reverted to `todo` mid-session ... completion state is
 * being lost, not just mis-displayed").
 *
 * Root cause: a whole-document rewrite (plans:set-content / set-content-chunk)
 * built from a STALE read, with no CAS baseline carried forward, silently
 * clobbers an item's status back to whatever the caller's stale copy said —
 * even though the write never named that item. Confirmed live via the
 * plan_revisions history of `git-pipeline-agent-state-2026-07-26`: P-001 read
 * `done` at revision 14, then reverted to `todo` at revision 15, produced by a
 * write whose rationale describes unrelated work on P-003 — no call in
 * between ever targeted P-001.
 *
 * The guard: a whole-document rewrite (`wholeDocumentRewrite: true`, only
 * set-content/set-content-chunk pass this) with NEITHER expectedVersion NOR
 * expectedHash supplied that would move an item BACKWARD off a terminal
 * (done/dropped) status is rejected as `item_status_regression`, unless the
 * caller passes `allowStatusRegression: true`. A CAS-verified write (fresh by
 * construction) is exempt — an intentional regression through it is allowed.
 * plans:edit and plans:set-status never opt in and are therefore unaffected
 * (covered by the existing edit/set-status suites, unchanged by this guard).
 */

import { describe, expect, it } from 'vitest';
import { evaluateSetContent, detectStatusRegressions } from '../set-content';
import { hashPlanContent } from '../content-hash';
import { parsePlan } from '../parser';

const SLUG = 'status-regression-guard-2026-07-27';

/** A lint-clean plan with one DONE item and one TODO item. */
const CURRENT = `---
title: Status Regression Guard
slug: ${SLUG}
created: 2026-07-27
updated: 2026-07-27
status: active
---

# Status Regression Guard

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Backlog

- **P-001** \`done\` StageState model, shipped and tested.
- **P-002** \`todo\` Something else, not started yet.

## Decisions
`;

/** P-002 flips to wip (the ONLY named change) but the body was typed from a
 *  STALE copy where P-001 still read `todo` — reverting it, unnamed. */
const STALE_REWRITE = CURRENT
  .replace('- **P-001** `done` StageState model, shipped and tested.', '- **P-001** `todo` StageState model, shipped and tested.')
  .replace('- **P-002** `todo` Something else, not started yet.', '- **P-002** `wip` Something else, not started yet.');

/** The same rewrite, but P-001 correctly stays `done` — no regression. */
const CLEAN_REWRITE = CURRENT.replace('- **P-002** `todo` Something else, not started yet.', '- **P-002** `wip` Something else, not started yet.');

describe('detectStatusRegressions (pure)', () => {
  it('flags an item that moved backward off done', () => {
    const cur = parsePlan(CURRENT, { filePath: `${SLUG}.md` });
    const proposed = parsePlan(STALE_REWRITE, { filePath: `${SLUG}.md` });
    const regressions = detectStatusRegressions(cur, proposed);
    expect(regressions).toEqual([{ id: 'P-001', from: 'done', to: 'todo' }]);
  });

  it('reports nothing when no terminal item regresses', () => {
    const cur = parsePlan(CURRENT, { filePath: `${SLUG}.md` });
    const proposed = parsePlan(CLEAN_REWRITE, { filePath: `${SLUG}.md` });
    expect(detectStatusRegressions(cur, proposed)).toEqual([]);
  });

  it('does not flag a FORWARD move (todo -> wip is not a regression)', () => {
    const cur = parsePlan(CURRENT, { filePath: `${SLUG}.md` });
    const proposed = parsePlan(CLEAN_REWRITE, { filePath: `${SLUG}.md` });
    // P-002 moved todo -> wip; only done/dropped items are ever tracked.
    expect(detectStatusRegressions(cur, proposed).some((r) => r.id === 'P-002')).toBe(false);
  });

  it('does not flag an item removed entirely (that is the shrink guard\'s job)', () => {
    const cur = parsePlan(CURRENT, { filePath: `${SLUG}.md` });
    const droppedLine = CURRENT.replace('- **P-001** `done` StageState model, shipped and tested.\n', '');
    const proposed = parsePlan(droppedLine, { filePath: `${SLUG}.md` });
    expect(detectStatusRegressions(cur, proposed)).toEqual([]);
  });
});

describe('evaluateSetContent — item-status-regression guard (wholeDocumentRewrite only)', () => {
  it('rejects a CAS-less whole-document rewrite that silently regresses a done item', async () => {
    const r = await evaluateSetContent(CURRENT, STALE_REWRITE, SLUG, undefined, {
      wholeDocumentRewrite: true,
    });
    expect(r.newBody).toBeNull();
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('item_status_regression');
    if (r.value.ok === false && r.value.code === 'item_status_regression') {
      expect(r.value.regressions).toEqual([{ id: 'P-001', from: 'done', to: 'todo' }]);
    }
  });

  it('allows the same write when allowStatusRegression: true is passed', async () => {
    const r = await evaluateSetContent(CURRENT, STALE_REWRITE, SLUG, undefined, {
      wholeDocumentRewrite: true,
      allowStatusRegression: true,
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(STALE_REWRITE);
  });

  it('allows the same write when a MATCHING expectedHash CAS baseline is supplied (verified-fresh)', async () => {
    const r = await evaluateSetContent(CURRENT, STALE_REWRITE, SLUG, hashPlanContent(CURRENT), {
      wholeDocumentRewrite: true,
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(STALE_REWRITE);
  });

  it('allows the same write when a MATCHING expectedVersion CAS baseline is supplied (verified-fresh)', async () => {
    const r = await evaluateSetContent(CURRENT, STALE_REWRITE, SLUG, undefined, {
      wholeDocumentRewrite: true,
      expectedVersion: 7,
      meta: { version: 7, contentHash: hashPlanContent(CURRENT) },
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(STALE_REWRITE);
  });

  it('does NOT reject a clean rewrite that never regresses anything, even with no CAS baseline', async () => {
    const r = await evaluateSetContent(CURRENT, CLEAN_REWRITE, SLUG, undefined, {
      wholeDocumentRewrite: true,
    });
    expect(r.value.ok).toBe(true);
  });

  it('is INERT unless the caller opts in via wholeDocumentRewrite (plans:edit\'s own path)', async () => {
    // Same stale-regressing body, but the caller did not pass
    // wholeDocumentRewrite (as plans:edit never does) — the guard must not
    // fire; plans:edit relies on its own exact-match concurrency guard.
    const r = await evaluateSetContent(CURRENT, STALE_REWRITE, SLUG, undefined, {});
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(STALE_REWRITE);
  });
});
