import { describe, it, expect } from 'vitest';
import {
  parseSubjectRef,
  parseDocumentsField,
  stringifySubjectRef,
  stringifySubjectRefs,
  type SubjectRef,
} from './subject-ref';

describe('parseSubjectRef', () => {
  it('parses feature ids (F-/WI-, case-insensitive, upcased)', () => {
    expect(parseSubjectRef('F-001')).toEqual({ kind: 'feature', ref: 'F-001' });
    expect(parseSubjectRef('wi-12')).toEqual({ kind: 'feature', ref: 'WI-12' });
    expect(parseSubjectRef('  F-7  ')).toEqual({ kind: 'feature', ref: 'F-7' });
  });

  it('parses symbol refs (file :: name, whitespace optional)', () => {
    expect(parseSubjectRef('src/foo.ts::myFn')).toEqual({ kind: 'symbol', file: 'src/foo.ts', name: 'myFn' });
    expect(parseSubjectRef('src/foo.ts :: myFn')).toEqual({ kind: 'symbol', file: 'src/foo.ts', name: 'myFn' });
  });

  it('parses path globs', () => {
    expect(parseSubjectRef('packages/x/**')).toEqual({ kind: 'path', globs: ['packages/x/**'] });
    expect(parseSubjectRef('a/b.ts')).toEqual({ kind: 'path', globs: ['a/b.ts'] });
  });

  it('returns null on blank, degrades a malformed `::` to the file part', () => {
    expect(parseSubjectRef('')).toBeNull();
    expect(parseSubjectRef('   ')).toBeNull();
    expect(parseSubjectRef('src/foo.ts::')).toEqual({ kind: 'path', globs: ['src/foo.ts'] });
  });
});

describe('parseDocumentsField', () => {
  it('handles a bare string', () => {
    expect(parseDocumentsField('F-3')).toEqual([{ kind: 'feature', ref: 'F-3' }]);
  });

  it('collapses loose path strings into one path ref, keeps symbol/feature distinct', () => {
    const refs = parseDocumentsField(['src/a.ts', 'src/b.ts', 'src/c.ts::fn', 'F-9']);
    expect(refs).toContainEqual({ kind: 'path', globs: ['src/a.ts', 'src/b.ts'] });
    expect(refs).toContainEqual({ kind: 'symbol', file: 'src/c.ts', name: 'fn' });
    expect(refs).toContainEqual({ kind: 'feature', ref: 'F-9' });
  });

  it('handles structured object entries', () => {
    const refs = parseDocumentsField([
      { feature: 'F-1' },
      { file: 'src/x.ts', name: 'g' },
      { path: 'docs/**' },
      { paths: ['a.ts', 'b.ts'] },
    ]);
    expect(refs).toContainEqual({ kind: 'feature', ref: 'F-1' });
    expect(refs).toContainEqual({ kind: 'symbol', file: 'src/x.ts', name: 'g' });
    expect(refs).toContainEqual({ kind: 'path', globs: ['docs/**', 'a.ts', 'b.ts'] });
  });

  it('returns [] for null/empty (unanchored)', () => {
    expect(parseDocumentsField(null)).toEqual([]);
    expect(parseDocumentsField(undefined)).toEqual([]);
    expect(parseDocumentsField([])).toEqual([]);
  });
});

describe('stringify round-trips', () => {
  it('round-trips path/symbol/feature', () => {
    const cases: SubjectRef[] = [
      { kind: 'path', globs: ['src/a.ts'] },
      { kind: 'symbol', file: 'src/a.ts', name: 'fn' },
      { kind: 'feature', ref: 'F-1' },
    ];
    for (const c of cases) {
      const round = parseSubjectRef(stringifySubjectRef(c));
      expect(round).toEqual(c);
    }
  });

  it('joins multiple refs for display', () => {
    expect(
      stringifySubjectRefs([
        { kind: 'feature', ref: 'F-1' },
        { kind: 'symbol', file: 'a.ts', name: 'g' },
      ]),
    ).toBe('F-1; a.ts :: g');
  });
});
