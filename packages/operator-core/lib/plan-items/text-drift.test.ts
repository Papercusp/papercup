/**
 * text-drift.test.ts — the pure plan-item text-drift core (WI-40825 /
 * EI-21218726167520963).
 *
 * The load-bearing claim under test is NOT "a hash function hashes". It is the
 * DISCRIMINATION the whole design rests on: a plan write that only flips a
 * status token / retargets `blocked-by:` / re-ranks `importance:` must produce
 * ZERO drift, while a genuine re-specification of the same item must produce
 * drift. Those cases are therefore driven through the REAL parser rather than
 * hand-built item literals — a hand-built `{ id, text }` pair would assert only
 * that this module compares two strings I typed, and would keep passing if the
 * parser one day started leaving the status token inside `text`, which is
 * exactly the regression that would make the feature fire on every status flip
 * and train everyone to ignore it.
 */

import { describe, it, expect } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import {
  normalizePlanItemText,
  planItemTextHash,
  detectItemTextChanges,
  derivePlanItemTextDrift,
} from './text-drift';

/** A minimal well-formed (non-legacy) plan body carrying the given item lines. */
function planWith(...itemLines: string[]): string {
  return [
    '---',
    'title: Drift fixture',
    'slug: drift-fixture',
    'status: ready',
    '---',
    '',
    '# Drift fixture',
    '',
    '## Phase 1',
    ...itemLines,
    '',
  ].join('\n');
}

function itemsOf(body: string) {
  return parsePlan(body, { filePath: 'drift-fixture.md' });
}

describe('normalizePlanItemText', () => {
  it('collapses whitespace runs and trims, so a rewrap is not a re-specification', () => {
    expect(normalizePlanItemText('  build   the\n  thing  ')).toBe('build the thing');
  });

  it('leaves case and punctuation significant', () => {
    expect(normalizePlanItemText('Build the Thing.')).not.toBe(normalizePlanItemText('build the thing'));
  });
});

describe('planItemTextHash', () => {
  it('is stable across whitespace-only differences', () => {
    expect(planItemTextHash('build the thing')).toBe(planItemTextHash('build   the\n\tthing'));
  });

  it('changes when the wording changes', () => {
    expect(planItemTextHash('build the thing')).not.toBe(planItemTextHash('build the other thing'));
  });

  it('returns undefined for absent/empty text rather than a hash-of-empty', () => {
    // A hash of '' would later read as a real fingerprint and make an item that
    // never had text look like it MATCHED something.
    expect(planItemTextHash(null)).toBeUndefined();
    expect(planItemTextHash(undefined)).toBeUndefined();
    expect(planItemTextHash('   ')).toBeUndefined();
  });
});

describe('the status/keyword discrimination (parser-backed — the design premise)', () => {
  const spec = 'wire the provider adapter and cover the failure modes';

  it('a status flip produces NO drift', () => {
    const before = itemsOf(planWith(`- **P-001** \`todo\` ${spec}`));
    const after = itemsOf(planWith(`- **P-001** \`wip\` ${spec}`));
    expect(detectItemTextChanges(before, after)).toEqual([]);
  });

  it('a blocked-by / importance / risk / authority change produces NO drift', () => {
    const before = itemsOf(planWith(`- **P-001** \`todo\` ${spec}`));
    const after = itemsOf(
      planWith(`- **P-001** \`todo\` ${spec} blocked-by: P-002 importance: urgent risk: high authority: owner`),
    );
    expect(detectItemTextChanges(before, after)).toEqual([]);
  });

  it('CALIBRATION: a real re-specification of the same item DOES produce drift', () => {
    // Without this case the two assertions above would also pass against a
    // detector that never reports anything at all.
    const before = itemsOf(planWith(`- **P-001** \`todo\` ${spec}`));
    const after = itemsOf(planWith(`- **P-001** \`todo\` wire the provider adapter behind a feature flag`));
    const changes = detectItemTextChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'P-001', kind: 'changed' });
    expect(changes[0].before).toContain('cover the failure modes');
    expect(changes[0].after).toContain('behind a feature flag');
  });

  it('CALIBRATION: a status flip and a re-spec in the SAME write reports only the re-spec', () => {
    const before = itemsOf(planWith(`- **P-001** \`todo\` ${spec}`, '- **P-002** `todo` second item'));
    const after = itemsOf(planWith(`- **P-001** \`wip\` ${spec}`, '- **P-002** `todo` second item, rescoped'));
    expect(detectItemTextChanges(before, after).map((c) => c.id)).toEqual(['P-002']);
  });
});

describe('detectItemTextChanges', () => {
  it('reports an item the write REMOVES — an open work-item then implements nothing', () => {
    const before = itemsOf(planWith('- **P-001** `todo` first', '- **P-002** `todo` second'));
    const after = itemsOf(planWith('- **P-001** `todo` first'));
    expect(detectItemTextChanges(before, after)).toEqual([
      { id: 'P-002', kind: 'removed', before: 'second' },
    ]);
  });

  it('does not report items the write ADDS (nothing has been minted from them)', () => {
    const before = itemsOf(planWith('- **P-001** `todo` first'));
    const after = itemsOf(planWith('- **P-001** `todo` first', '- **P-002** `todo` brand new'));
    expect(detectItemTextChanges(before, after)).toEqual([]);
  });

  it('reports nothing for a byte-identical rewrite', () => {
    const body = planWith('- **P-001** `todo` first', '- **P-002** `wip` second');
    expect(detectItemTextChanges(itemsOf(body), itemsOf(body))).toEqual([]);
  });

  it('reports nothing when only surrounding prose changes', () => {
    const before = itemsOf(planWith('- **P-001** `todo` first'));
    const after = itemsOf(
      [
        '---',
        'title: Drift fixture',
        'slug: drift-fixture',
        'status: ready',
        '---',
        '',
        '# Drift fixture',
        '',
        '## Background',
        'A whole new paragraph of rationale that touches no item.',
        '',
        '## Phase 1',
        '- **P-001** `todo` first',
        '',
      ].join('\n'),
    );
    expect(detectItemTextChanges(before, after)).toEqual([]);
  });
});

describe('derivePlanItemTextDrift', () => {
  const hash = planItemTextHash('build the thing')!;

  it('match: the live text still hashes to what was stamped at mint', () => {
    const v = derivePlanItemTextDrift({
      mintedFromHash: hash,
      currentText: 'build   the thing',
      itemExists: true,
    });
    expect(v.status).toBe('match');
  });

  it('drifted: the item was rewritten, and the live text is handed back', () => {
    const v = derivePlanItemTextDrift({
      mintedFromHash: hash,
      currentText: 'build the OTHER thing',
      itemExists: true,
    });
    expect(v.status).toBe('drifted');
    expect(v.currentText).toBe('build the OTHER thing');
    expect(v.mintedFromHash).toBe(hash);
  });

  it('unknown — NOT match — when the record predates the stamp', () => {
    // The whole false-absence guard: an un-stamped record must never render as
    // "no drift", which is indistinguishable from a real clean verdict.
    for (const mintedFromHash of [undefined, null]) {
      const v = derivePlanItemTextDrift({ mintedFromHash, currentText: 'anything', itemExists: true });
      expect(v.status).toBe('unknown');
      expect(v.status).not.toBe('match');
      expect(v.reason).toMatch(/cannot be determined/i);
    }
  });

  it('drifted + itemMissing when the plan no longer carries the item — even with no stamp', () => {
    // Absence of the item is established independently of the stamp, so this
    // case does NOT degrade to `unknown`.
    const v = derivePlanItemTextDrift({ mintedFromHash: undefined, itemExists: false });
    expect(v.status).toBe('drifted');
    expect(v.itemMissing).toBe(true);
  });

  it('an item that lost its text reads as drifted, not match', () => {
    const v = derivePlanItemTextDrift({ mintedFromHash: hash, currentText: '', itemExists: true });
    expect(v.status).toBe('drifted');
    expect(v.currentHash).toBeUndefined();
  });
});
