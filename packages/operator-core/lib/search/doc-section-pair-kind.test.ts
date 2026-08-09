import { describe, it, expect } from 'vitest';

import {
  surfaceClassOf,
  leafTitleOf,
  classifyOverlapPair,
  bucketByKind,
  PAIR_KINDS_IN_REPORT_ORDER,
  type OverlapPairKind,
} from './doc-section-pair-kind';
import type { DocSectionRef } from './doc-section-overlap';

const ref = (slug: string, anchor = '', sourceKey = 'papercusp-guidance'): DocSectionRef => ({
  sourceKey,
  slug,
  anchor,
});

describe('surfaceClassOf', () => {
  it('maps each known slug prefix to its surface', () => {
    expect(surfaceClassOf(ref('tool-guidance/pot-dissolve'))).toBe('tool-guidance');
    expect(surfaceClassOf(ref('prompts/papercup.persona'))).toBe('prompt');
    expect(surfaceClassOf(ref('blueprints/base/prompts/papercup'))).toBe('blueprint');
  });

  it('defaults to prose doc — the engineering corpus carries no slug prefix', () => {
    expect(surfaceClassOf(ref('agent-insights/reading-pipeline-state', '', 'papercusp-engineering'))).toBe('doc');
    expect(surfaceClassOf(ref('harness/memory', '', 'papercusp-engineering'))).toBe('doc');
    // The corpus ROOT page: empty slug is a real, embedded section (5 of them),
    // not an invalid input.
    expect(surfaceClassOf(ref(''))).toBe('doc');
  });

  it('does not match a prefix that merely appears mid-slug', () => {
    expect(surfaceClassOf(ref('agents/tool-guidance/overview', '', 'papercusp-engineering'))).toBe('doc');
  });
});

describe('leafTitleOf', () => {
  it('returns the heading after the last separator', () => {
    expect(leafTitleOf('Tool guidance: pot:dissolve › Chaining')).toBe('Chaining');
  });

  it('returns the whole title for a page preamble, which has no separator', () => {
    expect(leafTitleOf('Memory')).toBe('Memory');
  });

  it('takes the LAST separator when a heading nests', () => {
    expect(leafTitleOf('Page › Section › Subsection')).toBe('Subsection');
  });
});

describe('classifyOverlapPair', () => {
  it('rule 1: identical titles are a re-homed copy, and the verdict is confident', () => {
    // Measured live 2026-08-08 at cosine 1.0000 — D-004's flagship kind-2 pair.
    const verdict = classifyOverlapPair(
      {
        ref: ref('prompts/operator.persona.engineer-mode', 'audience-mode-engineer'),
        title: 'Audience mode: Engineer › Audience mode: Engineer',
      },
      {
        ref: ref('prompts/papercup.persona.engineer-mode', 'audience-mode-engineer'),
        title: 'Audience mode: Engineer › Audience mode: Engineer',
      },
    );
    expect(verdict.kind).toBe('rehomed-copy');
    expect(verdict.basis).toBe('identical-title');
    expect(verdict.confident).toBe(true);
  });

  it('normalises whitespace, so a re-wrap cannot defeat title equality', () => {
    const verdict = classifyOverlapPair(
      { ref: ref('prompts/a'), title: 'Audience mode:   Engineer' },
      { ref: ref('prompts/b'), title: ' Audience mode: Engineer ' },
    );
    expect(verdict.kind).toBe('rehomed-copy');
  });

  it('does NOT manufacture a re-homed copy out of two BLANK titles', () => {
    // `title` is NOT NULL DEFAULT '' in doc_sections, so empty-equals-empty is
    // reachable from real rows. Treating it as a match would produce a
    // CONFIDENT verdict from the total absence of evidence.
    const verdict = classifyOverlapPair(
      { ref: ref('prompts/a'), title: '' },
      { ref: ref('prompts/b'), title: '   ' },
    );
    expect(verdict.kind).not.toBe('rehomed-copy');
    expect(verdict.confident).toBe(false);
  });

  it('rule 2: differing surfaces are cross-kind', () => {
    const verdict = classifyOverlapPair(
      { ref: ref('tool-guidance/pot-leave'), title: 'Tool guidance: pot:leave › When' },
      { ref: ref('system/shared-pot-guide', '', 'papercusp-engineering'), title: 'Shared pot guide › Leaving' },
    );
    expect(verdict.kind).toBe('cross-kind');
    expect(verdict.basis).toBe('surface-mismatch');
    expect(verdict.surfaceA).toBe('tool-guidance');
    expect(verdict.surfaceB).toBe('doc');
  });

  it('rule 3: same surface with differing titles is sibling boilerplate', () => {
    // The high-volume kind: sibling verbs whose `Chaining` sections read alike.
    const verdict = classifyOverlapPair(
      { ref: ref('tool-guidance/pot-obliterate', 'chaining'), title: 'Tool guidance: pot:obliterate › Chaining' },
      { ref: ref('tool-guidance/pot-dissolve', 'chaining'), title: 'Tool guidance: pot:dissolve › Chaining' },
    );
    expect(verdict.kind).toBe('sibling-surface');
    expect(verdict.basis).toBe('same-surface');
    expect(verdict.confident).toBe(false);
  });

  it('is symmetric in its verdict kind', () => {
    const a = { ref: ref('tool-guidance/x'), title: 'X › S' };
    const b = { ref: ref('agent-insights/y', '', 'papercusp-engineering'), title: 'Y › S' };
    expect(classifyOverlapPair(a, b).kind).toBe(classifyOverlapPair(b, a).kind);
  });

  // ── The known recall limit, asserted as a CONTROL ────────────────────────
  //
  // This is not a test of desired behaviour; it PINS a measured shortfall so a
  // future change to the rules has to confront it deliberately instead of
  // silently moving findings between buckets.
  it('CONTROL: a RE-TITLED re-home escapes rule 1 and lands in cross-kind', () => {
    // Measured live 2026-08-08. Both are the papercup persona; the blueprint
    // home was deliberately re-titled to record that it IS a re-home, which is
    // precisely the edit that defeats title equality. D-004 calls this pair
    // kind 2; this classifier reports kind 3.
    const verdict = classifyOverlapPair(
      {
        ref: ref('blueprints/base/prompts/papercup', 'you-suggest-and-hand-off-you-never-place-or-execute'),
        title: 'Papercup (canonical persona re-homed) › You suggest and hand off',
      },
      {
        ref: ref('prompts/papercup.persona', 'behavioral-rules'),
        title: 'Papercup persona — the fast front-end › Behavioral rules',
      },
    );
    expect(verdict.kind).toBe('cross-kind');
    expect(verdict.confident).toBe(false);
    // The direction of the error is the point: `rehomed-copy` is a FLOOR on how
    // many re-homed copies exist, never a count of them.
  });
});

describe('bucketByKind', () => {
  const item = (kind: OverlapPairKind, id: string) => ({ kind, id });

  it('returns EVERY kind, including empty ones', () => {
    // An absent bucket and an empty bucket read identically to a caller that
    // iterates what it is given. D-001's rule is that a zero must be visible as
    // a zero: `cross-kind: 0` is a finding, a missing `cross-kind` line is an
    // ambiguity.
    const buckets = bucketByKind([item('sibling-surface', 'a')]);
    expect(buckets.map((b) => b.kind)).toEqual([...PAIR_KINDS_IN_REPORT_ORDER]);
    expect(buckets.find((b) => b.kind === 'cross-kind')?.count).toBe(0);
  });

  it('orders the rarest and most actionable kind FIRST, never by volume', () => {
    // The trap D-004 guards: kind 1 is ~an order of magnitude more common, so
    // any volume- or similarity-ordered report buries the valuable buckets.
    expect(PAIR_KINDS_IN_REPORT_ORDER[0]).toBe('rehomed-copy');
    expect(PAIR_KINDS_IN_REPORT_ORDER[PAIR_KINDS_IN_REPORT_ORDER.length - 1]).toBe('sibling-surface');
  });

  it('partitions without loss or duplication', () => {
    const items = [
      item('sibling-surface', 'a'),
      item('cross-kind', 'b'),
      item('sibling-surface', 'c'),
      item('rehomed-copy', 'd'),
    ];
    const buckets = bucketByKind(items);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(items.length);
    expect(buckets.flatMap((b) => b.items.map((i) => i.id)).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
