import { describe, expect, it } from 'vitest';
import { assertShapeMatchesRecordedVersion, deriveShapeFingerprint } from './shape-fingerprint';

describe('deriveShapeFingerprint', () => {
  it('is a pure function of KEYS, not values — different values, same shape, fingerprints identically', () => {
    expect(deriveShapeFingerprint({ id: 'a', score: 1 })).toBe(deriveShapeFingerprint({ id: 'z', score: 999 }));
  });

  it('changes when a key is added, removed, or renamed', () => {
    const base = deriveShapeFingerprint({ id: 'a', score: 1 });
    expect(deriveShapeFingerprint({ id: 'a', score: 1, extra: true })).not.toBe(base); // added
    expect(deriveShapeFingerprint({ id: 'a' })).not.toBe(base); // removed
    expect(deriveShapeFingerprint({ id: 'a', points: 1 })).not.toBe(base); // renamed
  });

  it('is insensitive to key ORDER (object literals are unordered)', () => {
    expect(deriveShapeFingerprint({ a: 1, b: 2 })).toBe(deriveShapeFingerprint({ b: 2, a: 1 }));
  });

  it('array fingerprint is the UNION of every element — an optional field present on only ONE row still counts', () => {
    // This is the D-025 null-omit case: `archived` only appears on rows where it's true.
    const withOptionalOnSecondRow = deriveShapeFingerprint([{ slug: 'a' }, { slug: 'b', archived: true }]);
    const withOptionalOnFirstRow = deriveShapeFingerprint([{ slug: 'a', archived: true }, { slug: 'b' }]);
    // Same UNION shape regardless of which row carries the optional field.
    expect(withOptionalOnSecondRow).toBe(withOptionalOnFirstRow);
    // And it differs from a sample where NO row ever carries it.
    expect(deriveShapeFingerprint([{ slug: 'a' }, { slug: 'b' }])).not.toBe(withOptionalOnSecondRow);
  });

  it('a null-omitted key is genuinely ABSENT from the fingerprint, not present-as-null', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const withKey = deriveShapeFingerprint({ id: 'a', assignee: null });
    const withoutKey = deriveShapeFingerprint({ id: 'a' });
    // `assignee: null` is a DIFFERENT (wider) shape than omitting it — this
    // fingerprint distinguishes "key present, typed null" from "key absent",
    // which is exactly the distinction WI-7279's null-omit wire slimming cares
    // about (the whole point of D-025 is to not serialize the key at all).
    expect(withKey).not.toBe(withoutKey);
  });

  it('nests recursively through objects and arrays', () => {
    const a = deriveShapeFingerprint({ flow: { captured7d: 1 }, rows: [{ id: 'x' }] });
    const b = deriveShapeFingerprint({ flow: { captured7d: 99 }, rows: [{ id: 'y' }] });
    const c = deriveShapeFingerprint({ flow: { captured7d: 1, resolved7d: 1 }, rows: [{ id: 'x' }] });
    expect(a).toBe(b); // same shape, different values/nested-array-length-1 content
    expect(a).not.toBe(c); // nested object gained a key
  });
});

describe('assertShapeMatchesRecordedVersion', () => {
  it('passes when the sample fingerprint matches the recorded entry for the CURRENT registered version', () => {
    const sample = { id: 'a', title: 't' };
    expect(() =>
      assertShapeMatchesRecordedVersion({
        key: 'test.producer',
        producerVersion: 2,
        sample,
        expectedByVersion: { 2: deriveShapeFingerprint(sample) },
      }),
    ).not.toThrow();
  });

  it('fails when the shape changed but producerVersion did NOT move — the WI-7289 defect signature', () => {
    // The recorded v3 entry is the OLD shape; the sample now has an extra field,
    // but the registered version is still 3 (nobody bumped it).
    expect(() =>
      assertShapeMatchesRecordedVersion({
        key: 'learning.improvements',
        producerVersion: 3,
        sample: { id: 'a', title: 't', newField: 'oops' },
        expectedByVersion: { 3: deriveShapeFingerprint({ id: 'a', title: 't' }) },
      }),
    ).toThrow(/computed output shape changed but producerVersion is still 3/);
  });

  it('fails when the version WAS bumped but no shape was ever recorded for it — forces a deliberate confirmation', () => {
    expect(() =>
      assertShapeMatchesRecordedVersion({
        key: 'learning.improvements',
        producerVersion: 4,
        sample: { id: 'a' },
        expectedByVersion: { 3: deriveShapeFingerprint({ id: 'a' }) }, // only v3 recorded
      }),
    ).toThrow(/has no recorded expected shape for it/);
  });
});
