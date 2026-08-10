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
  classifyCitation,
  tierFor,
} from '../../../scripts/check-fixed-but-open.mjs';

/** Build the aggregate record shape `tierFor` consumes. */
function rec(opts: { contexts: string[]; inTest?: boolean; everLiteral?: boolean }) {
  return {
    contexts: new Set(opts.contexts),
    inTest: opts.inTest ?? false,
    everLiteral: opts.everLiteral ?? false,
    samples: [],
  };
}

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
