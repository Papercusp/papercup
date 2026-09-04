/**
 * Pins the citation classifier behind `scripts/check-fixed-but-open.mjs`.
 *
 * WHY THESE EXACT STRINGS: every fixture below is a VERBATIM line measured in this tree on
 * 2026-08-10, not an invented example. The detector's whole value rests on separating "this id
 * is cited because its fix is guarded" from "this id is a made-up row in a fixture array", and
 * that distinction was discovered empirically — the naive version of this check (any citation in
 * a test file ⇒ probably fixed) reports the EI-100 fixture line below as evidence of a fix.
 *
 * Each positive case is paired with a negative control. A classifier that returns the same tier
 * for both members of a pair is broken in the direction that matters (recommending a live item
 * be closed), and these pairs are what make that failure visible instead of plausible.
 */
import { describe, expect, it } from 'vitest';

import {
  CITED_AS_OUTSTANDING_RE,
  FIXED_BUT_OPEN_ITEM_KINDS,
  classifyCitation,
  tierFor,
} from '../../../scripts/check-fixed-but-open.mjs';

/** Build the aggregate record shape `tierFor` consumes. */
function rec(opts: {
  contexts: string[];
  inTest?: boolean;
  everLiteral?: boolean;
  hasAssertion?: boolean;
}) {
  return {
    contexts: new Set(opts.contexts),
    inTest: opts.inTest ?? false,
    everLiteral: opts.everLiteral ?? false,
    hasAssertion: opts.hasAssertion ?? false,
    samples: [],
  };
}

describe('backward reconciliation candidate scope', () => {
  it('includes feature-family rows as well as issue-family work', () => {
    // EI-19327225905639728's exact stale exemplars — WI-5657, WI-5754, WI-5779 — were ALL
    // kind=feature. Omitting feature here made the live report look healthy while excluding the
    // class that filed the item. Pin the complete forward-active kind set, not just one token.
    expect(FIXED_BUT_OPEN_ITEM_KINDS).toEqual(['feature', 'bug', 'change', 'task']);
  });
});

describe('classifyCitation — measured citation shapes', () => {
  it('reads a fixture ARRAY LITERAL as data, not as evidence of a fix', () => {
    // apps/operator/lib/release/release-history-integration.test.ts:44 (verbatim)
    const line = "      workItemIds: ['WI-1', 'WI-2', 'EI-100'],";
    expect(classifyCitation(line, 'EI-100')).toBe('literal');
  });

  it('reads a recurrence-guard COMMENT as evidence', () => {
    // packages/operator-core/lib/agent-tools/work_items/claim.test.ts:204 (verbatim)
    const line = '  // EI-1416 (a policy-tier D-003 security hold). These pin the fix: a claim-hold-parked item';
    expect(classifyCitation(line, 'EI-1416')).toBe('comment');
  });

  it('reads a block-comment continuation as a comment', () => {
    // packages/operator-core/lib/federated-pot-scope.ts:12 (verbatim)
    const line = ' *                    `canonicalHiveHomeSlug` (WI-559) / `pots.canonical_pot_home_slug`';
    expect(classifyCitation(line, 'WI-559')).toBe('comment');
  });

  it('reads a SQL comment as a comment', () => {
    // packages/operator-core/lib/delegated-tasks.integration.test.ts:114 (verbatim)
    const line = "      -- WI-559 (mig 686): hive-store's SELECT_COLS reads canonical_pot_home_slug on EVERY";
    expect(classifyCitation(line, 'WI-559')).toBe('comment');
  });

  it('NEGATIVE CONTROL: a bare code reference is neither comment nor literal', () => {
    const line = '  const item = await claim(WI_559_ID);  // no id token here';
    expect(classifyCitation(line, 'WI-9999')).toBe('code');
  });

  it('NEGATIVE CONTROL: a quoted id inside an otherwise commentless code line is a literal', () => {
    const line = "  await workItems.claim({ id: 'EI-1416' });";
    expect(classifyCitation(line, 'EI-1416')).toBe('literal');
  });
});

/**
 * The correction measured on WI-5332 (2026-08-10). A quoted id can be the OPPOSITE of fixture
 * data — a guard asserting that output the code PRODUCED names the item. The original classifier
 * called both 'literal', so `tierFor`'s veto filed genuine already-fixed items under "likely
 * FIXTURE data". WI-5332 was fixed 2026-07-19 and was still being served by scheduler:get_next
 * three weeks later because of it.
 *
 * The pairs below are the whole point: members differ ONLY in whether the id is also an INPUT.
 */
describe('classifyCitation — asserted output vs data round-trip (both are quoted ids)', () => {
  it('reads an assertion about code-PRODUCED output as evidence, not as data', () => {
    // packages/operator-core/lib/sync/hyperbee/__tests__/boot.test.ts:2321 (verbatim) — the exact
    // line that demoted WI-5332, and it is the strongest evidence in the whole candidate set.
    const line = "    expect(exhaustedEvents()[0]!.message).toContain('WI-5332');";
    expect(classifyCitation(line, 'WI-5332')).toBe('assertion');
  });

  it('reads an assertion on captured stderr as evidence', () => {
    // apps/operator-vite/src/__tests__/vite-build-singleflight.test.ts:139 (verbatim)
    const line = "    expect(stderr()).toContain('EI-9836');";
    expect(classifyCitation(line, 'EI-9836')).toBe('assertion');
  });

  it('NEGATIVE CONTROL: a ROUND-TRIP, where the id is also an INPUT, stays fixture data', () => {
    // apps/operator/app/_components/chat/chat-ref-popup-params.test.ts:30 (verbatim). This is the
    // trap: it is inside an expect() and asserts equality, yet WI-1 is a synthetic value fed
    // through an encoder. "Inside an expect()" is NOT the discriminator; being absent from the
    // assertion's SUBJECT is. A classifier that returns 'assertion' here would re-file every
    // fixture round-trip as proof of a fix.
    const line = "    expect(encodeScopedRef(null, 'WI-1')).toBe('WI-1');";
    expect(classifyCitation(line, 'WI-1')).toBe('literal');
  });

  it('NEGATIVE CONTROL: a fixture array is untouched by the assertion branch', () => {
    // apps/operator/lib/release/release-content-scrub.test.ts:139 (verbatim)
    const line = "    workItemIds: ['WI-1'],";
    expect(classifyCitation(line, 'WI-1')).toBe('literal');
  });

  it('NEGATIVE CONTROL: a bare matcher with no expect() subject is not an assertion', () => {
    // Guards the `subject.includes('expect(')` condition specifically — without it, any
    // `.toBe('WI-1')`-shaped text would qualify.
    const line = "  const shape = { matcher: 'x' }.toBe;  // not an assertion";
    expect(classifyCitation(line, 'WI-9999')).toBe('code');
  });

  it('NEGATIVE CONTROL: a NEGATED assertion is not evidence — it asserts the id is ABSENT', () => {
    // apps/operator/lib/release/release-history-integration.test.ts:259 (verbatim). This one
    // caught a real regression: an earlier draft classified it 'assertion' and promoted EI-100,
    // the original documented false positive, back to `guard`. Asserting an id is scrubbed FROM
    // output is the opposite of asserting a fix emits it.
    const line = "    expect(html).not.toContain('EI-100');";
    expect(classifyCitation(line, 'EI-100')).toBe('literal');
  });
});

describe('tierFor — string-literal use DOMINATES', () => {
  it('demotes an id used as data anywhere to weak, even when also comment-cited in a test', () => {
    // This is the EI-100 case and the single most important behaviour here: without the
    // everLiteral veto the detector recommends closing an item whose only "evidence" is that
    // someone invented it as a fixture row.
    expect(tierFor(rec({ contexts: ['comment', 'literal'], inTest: true, everLiteral: true }))).toBe('weak');
  });

  it('CALIBRATION: the same record WITHOUT literal use is guard — so the veto, not the shape, demoted it', () => {
    expect(tierFor(rec({ contexts: ['comment'], inTest: true }))).toBe('guard');
  });

  it('REGRESSION GUARD: an assertion does NOT override the veto when the id is ALSO fixture data', () => {
    // The EI-100 shape after the WI-5332 change. It has a genuine guard-looking assertion
    // (`expect(w).toContain('EI-100')`) AND genuine fixture literals elsewhere. A draft that let
    // hasAssertion outrank everLiteral promoted it to `guard` against the real tree. The
    // round-trip that makes that assertion meaningless spans FIVE lines, so no line-scoped
    // classifier can see it — which is exactly why the veto has to keep winning here.
    expect(
      tierFor(rec({ contexts: ['comment', 'assertion', 'literal'], inTest: true, everLiteral: true, hasAssertion: true })),
    ).toBe('weak');
  });

  it('CALIBRATION: the SAME record with no fixture literal is guard — proving the veto did the demoting', () => {
    // This is the WI-5332 shape: an assertion + a guard comment, and nothing quoting the id as
    // data. Paired with the case above, the two differ ONLY in everLiteral, so a classifier that
    // returned the same tier for both would be visibly broken rather than plausibly conservative.
    expect(
      tierFor(rec({ contexts: ['comment', 'assertion'], inTest: true, hasAssertion: true })),
    ).toBe('guard');
  });

  it('rates a source-file comment below a test/guard comment', () => {
    expect(tierFor(rec({ contexts: ['comment'], inTest: false }))).toBe('source-comment');
  });

  it('rates a code-only citation weak — a mention with no prose is not evidence', () => {
    expect(tierFor(rec({ contexts: ['code'] }))).toBe('weak');
  });
});

describe('CITED_AS_OUTSTANDING_RE — the third false-positive mode', () => {
  it('flags a comment naming the item as an OPEN blocker', () => {
    // packages/operator-core/lib/sync/hyperbee/hive-epoch-read-cut-witness.test.ts:15 (verbatim).
    // A genuine comment, in a genuine guard file, saying the OPPOSITE of "this is fixed".
    const line = ' * That composition is exactly what the live 2-machine witness (WI-560, blocked on the';
    expect(CITED_AS_OUTSTANDING_RE.test(line)).toBe(true);
  });

  it('flags an explicit still-open note', () => {
    // packages/operator-core/lib/... (verbatim shape measured in the candidate set)
    const line = ' * on four real work-items (WI-3235, WI-3442, WI-5629, WI-5718 — the last two still open)';
    expect(CITED_AS_OUTSTANDING_RE.test(line)).toBe(true);
  });

  it('NEGATIVE CONTROL: does not flag a plain fix citation', () => {
    const line = '  // EI-1416 (a policy-tier D-003 security hold). These pin the fix: a claim-hold-parked item';
    expect(CITED_AS_OUTSTANDING_RE.test(line)).toBe(false);
  });

  it('NEGATIVE CONTROL: does not flag a comment merely describing landed behaviour', () => {
    const line = ' * EI-3620: the vendored macOS git bundle, relative to the sidecar bin dir.';
    expect(CITED_AS_OUTSTANDING_RE.test(line)).toBe(false);
  });
});
