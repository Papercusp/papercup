/**
 * Unit tests for promote.ts — pure SC-NNN allocator + SPEC mutator.
 */

import { describe, expect, it } from 'vitest';

import {
  allocateNextScIds,
  appendCriteriaToSpec,
  buildSpecMutation,
  findUnknownFromItems,
  maxScNum,
  parseScIds,
} from '../promote';

describe('parseScIds / maxScNum', () => {
  it('returns unique SC-NNN ids sorted', () => {
    const spec = `- [SC-001] one\n- [SC-003] three\n- [SC-001] dup\n`;
    expect(parseScIds(spec)).toEqual(['SC-001', 'SC-003']);
  });

  it('maxScNum returns 0 on an empty / SC-less spec', () => {
    expect(maxScNum('# Hello\n\nNo criteria here.')).toBe(0);
  });

  it('maxScNum handles >3-digit ids', () => {
    expect(maxScNum('- [SC-042] x\n- [SC-1000] y')).toBe(1000);
  });
});

describe('allocateNextScIds', () => {
  it('starts at 001 for an empty spec', () => {
    expect(allocateNextScIds('', 3)).toEqual(['SC-001', 'SC-002', 'SC-003']);
  });

  it('continues from max+1', () => {
    expect(allocateNextScIds('- [SC-007] x', 2)).toEqual(['SC-008', 'SC-009']);
  });
});

describe('appendCriteriaToSpec', () => {
  it('preserves the original spec verbatim and appends the new section', () => {
    const old = '# Project SPEC\n\nNarrative prose.\n';
    const out = appendCriteriaToSpec(
      old,
      [{ id: 'SC-001', text: 'must rotate' }],
      { planSlug: 'foo-2026-05-20', authorOwnerId: 'A' },
    );
    expect(out.startsWith(old)).toBe(true);
    expect(out).toContain(
      '<!-- promoted from plans/foo-2026-05-20 by A at',
    );
    expect(out).toContain('## Promoted from `foo-2026-05-20`');
    expect(out).toContain('- [SC-001] must rotate');
  });

  it('is a no-op when no criteria are supplied', () => {
    const old = 'unchanged';
    expect(appendCriteriaToSpec(old, [], { planSlug: 'x', authorOwnerId: 'A' })).toBe(
      'unchanged',
    );
  });

  it('inserts a newline when the input lacks a trailing one', () => {
    const out = appendCriteriaToSpec(
      'NO-NEWLINE',
      [{ id: 'SC-001', text: 't' }],
      { planSlug: 'p', authorOwnerId: 'A' },
    );
    expect(out.split('\n')[0]).toBe('NO-NEWLINE');
  });
});

describe('buildSpecMutation', () => {
  it('allocates ids across features in input order', () => {
    const out = buildSpecMutation({
      currentSpec: '- [SC-005] existing\n',
      planSlug: 'demo',
      authorOwnerId: 'A',
      features: [
        { title: 'F-A', acceptance: ['first', 'second'] },
        { title: 'F-B', acceptance: ['third'] },
        { title: 'F-C (no criteria)' },
      ],
    });
    expect(out.criteria.map((c) => c.id)).toEqual([
      'SC-006',
      'SC-007',
      'SC-008',
    ]);
    expect(out.perFeatureCovers).toEqual([
      { feature_title: 'F-A', covers: ['SC-006', 'SC-007'] },
      { feature_title: 'F-B', covers: ['SC-008'] },
      { feature_title: 'F-C (no criteria)', covers: [] },
    ]);
    expect(out.newSpec).toContain('- [SC-006] first');
    expect(out.newSpec).toContain('- [SC-007] second');
    expect(out.newSpec).toContain('- [SC-008] third');
  });

  it('threads pre-allocated feature ids through as coveredBy + covers', () => {
    const out = buildSpecMutation({
      currentSpec: '',
      planSlug: 'p',
      authorOwnerId: 'A',
      features: [{ title: 'F', acceptance: ['x'] }],
      featureIds: ['F-040'],
    });
    expect(out.criteria[0]?.coveredBy).toBe('F-040');
    expect(out.perFeatureCovers[0]?.feature_id).toBe('F-040');
    expect(out.newSpec).toContain('- [SC-001] x (covered by F-040)');
  });
});

describe('findUnknownFromItems (audit B2)', () => {
  it('returns [] when every from_items id is known', () => {
    const out = findUnknownFromItems(
      [{ from_items: ['P-001', 'P-002'] }, { from_items: ['P-003'] }],
      ['P-001', 'P-002', 'P-003', 'P-004'],
    );
    expect(out).toEqual([]);
  });

  it('returns [] when no feature declares from_items', () => {
    expect(findUnknownFromItems([{ title: 'a' }, {}], ['P-001'])).toEqual([]);
  });

  it('surfaces ids absent from the plan, sorted + de-duplicated', () => {
    const out = findUnknownFromItems(
      [{ from_items: ['P-009', 'P-001'] }, { from_items: ['P-009', 'P-007'] }],
      ['P-001', 'P-002'],
    );
    expect(out).toEqual(['P-007', 'P-009']);
  });

  it('treats an empty known set as "everything is unknown"', () => {
    expect(findUnknownFromItems([{ from_items: ['P-001'] }], [])).toEqual(['P-001']);
  });
});
