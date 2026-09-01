import { describe, expect, it } from 'vitest';
import { appendEndedPage, endedDisplayName, visibleEndedRows, type EndedSessionRow } from './sessions';

function endedRow(over: Partial<EndedSessionRow> = {}): EndedSessionRow {
  return {
    id: 1,
    planSlug: null,
    agent: null,
    role: null,
    feature: null,
    label: null,
    coordOwnerId: null,
    startedAt: '2026-07-09T01:00:00Z',
    endedAt: '2026-07-09T01:30:00Z',
    exitCode: 0,
    ...over,
  };
}

describe('endedDisplayName', () => {
  it('prefers the trimmed label, then the short owner id, then agent + row id', () => {
    expect(endedDisplayName(endedRow({ label: ' builder-3 ', coordOwnerId: 'su-x' }))).toBe('builder-3');
    expect(endedDisplayName(endedRow({ coordOwnerId: 'su-ba914b41-b03b-4fdd' }))).toBe('su-ba914b41');
    expect(endedDisplayName(endedRow({ id: 12, agent: 'omp' }))).toBe('omp #12');
    expect(endedDisplayName(endedRow({ id: 12 }))).toBe('session #12');
  });

  it('routes a stored label through the host normalizer and nothing else', () => {
    const upper = (raw: string) => raw.toUpperCase();
    expect(endedDisplayName(endedRow({ label: 'bee' }), upper)).toBe('BEE');
    // The owner-id and agent+id fallbacks are identities, not labels — never normalized.
    expect(endedDisplayName(endedRow({ coordOwnerId: 'su-abcdef12' }), upper)).toBe('su-abcdef12');
    expect(endedDisplayName(endedRow({ id: 3, agent: 'codex' }), upper)).toBe('codex #3');
  });
});

describe('appendEndedPage', () => {
  it('appends new ids and drops ids already present (keyset shift between pages)', () => {
    const prev = [endedRow({ id: 1 }), endedRow({ id: 2 })];
    const next = appendEndedPage(prev, [endedRow({ id: 2 }), endedRow({ id: 3 })]);
    expect(next.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(appendEndedPage([], [])).toEqual([]);
  });
});

describe('visibleEndedRows', () => {
  const rows = [
    endedRow({ id: 1, coordOwnerId: 'su-live' }),
    endedRow({ id: 2, coordOwnerId: 'su-gone' }),
    endedRow({ id: 3, coordOwnerId: null }),
  ];

  it('elides a running agent\'s older terminals and keeps owner-less rows', () => {
    expect(visibleEndedRows(rows, new Set(['su-live']), null).map((r) => r.id)).toEqual([2, 3]);
  });

  it('a focus deep-link shows ONLY that owner\'s history, including elided rows', () => {
    expect(visibleEndedRows(rows, new Set(['su-live']), 'su-live').map((r) => r.id)).toEqual([1]);
  });
});
