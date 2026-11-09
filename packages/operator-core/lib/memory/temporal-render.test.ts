import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contextSourceChangeNotice, contextSourceVersion, memoryEntrySourceVersion, normalizeContextSourceText, parseContextSourceVersion, renderContextSourceUnit } from './temporal-render';

const current = { status: 'current' as const, validAt: null, invalidAt: null, supersededBy: null };
const source = { namespace: 'memory', ref: 'memory-1', fullText: 'Approve cafe\u0301.\r\nOnly after review.\r',
  revision: null, updatedAt: null, validity: current };

describe('canonical context source versions', () => {
  it('preserves canonical reader metadata through the bounded search carrier and rejects altered or misaddressed versions', () => {
    const version = contextSourceVersion(source);
    expect(parseContextSourceVersion(JSON.stringify(version), source.ref)).toEqual(version);
    expect(parseContextSourceVersion(JSON.stringify(version), 'another-source')).toBeNull();
    for (const patch of [{ fingerprint: 'a'.repeat(64) }, { fullTextBytes: 1 },
      { revision: 'changed' }, { namespace: 'another-namespace' },
      { validity: { ...current, status: 'retracted' } },
      { passage: { ...version.passage, endByte: version.fullTextBytes + 1 } },
      { updatedAt: 'not-a-date' }]) {
      expect(parseContextSourceVersion(JSON.stringify({ ...version, ...patch }), source.ref)).toBeNull();
    }
    for (const wire of [undefined, null, '{}', 'null', '{', 'x'.repeat(4097)])
      expect(parseContextSourceVersion(wire, source.ref)).toBeNull();
  });

  it('binds full memory bodies and reader validity while retaining unknown metadata and refusing malformed timestamps', () => {
    const entry = { id: 'memory-1', scope: 'harness:fixture', text: 'only after approval' };
    const unknown = memoryEntrySourceVersion(entry)!;
    expect(unknown).toMatchObject({ namespace: 'memory:harness:fixture', ref: entry.id,
      revision: null, updatedAt: null, validity: { status: 'unknown', invalidAt: null } });
    const metadata = { revision: 'r2', updated_at: '2026-11-09T10:00:00-05:00',
      validity: { status: 'superseded', valid_at: '2026-11-08T00:00:00Z',
        invalid_at: '2026-11-09T15:00:00Z', superseded_by: 'memory-2' } };
    const closed = memoryEntrySourceVersion({ ...entry, metadata })!;
    expect(closed).toMatchObject({ revision: 'r2', updatedAt: '2026-11-09T15:00:00.000Z',
      validity: { status: 'superseded', invalidAt: '2026-11-09T15:00:00.000Z', supersededBy: 'memory-2' } });
    expect(closed.fingerprint).not.toBe(unknown.fingerprint);
    expect(memoryEntrySourceVersion({ ...entry, text: entry.text + ' and review' })?.fingerprint).not.toBe(unknown.fingerprint);
    expect(memoryEntrySourceVersion({ ...entry, scope: 'other' })?.fingerprint).not.toBe(unknown.fingerprint);
    expect(memoryEntrySourceVersion({ ...entry, metadata: { updated_at: 'bad-clock' } })).toBeNull();
    expect(memoryEntrySourceVersion({ ...entry, metadata: { validity: { invalid_at: {} } } })).toBeNull();
  });

  it('drops unrecognized prose fields at every level of the source metadata carrier', () => {
    const version = contextSourceVersion(source);
    const wire = { ...version, text: 'private canonical prose',
      validity: { ...version.validity, body: 'private validity prose' },
      passage: { ...version.passage, excerpt: 'private passage prose' } };
    const parsed = parseContextSourceVersion(JSON.stringify(wire), source.ref);
    expect(parsed).toEqual(version);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it('emits content-free scoped change notices only for confirmed, changed canonical sources', () => {
    const before = contextSourceVersion(source);
    const corrected = contextSourceVersion({ ...source, fullText: 'New approval requirement.' });
    const notice = contextSourceChangeNotice(before, corrected)!;
    expect(notice).toContain('"kind":"corrected"');
    expect(notice).toContain('replace-earlier-version');
    expect(notice).not.toContain('New approval');
    expect(notice).not.toContain('Only after');
    for (const status of ['retracted', 'superseded', 'expired'] as const) {
      const after = contextSourceVersion({ ...source, validity: { ...current, status, supersededBy: 'memory-2' } });
      expect(contextSourceChangeNotice(before, after)).toContain(`"kind":"${status}"`);
      expect(contextSourceChangeNotice(before, after)).toContain('withdraw-earlier-version');
    }
    for (const after of [undefined, null, before,
      contextSourceVersion({ ...source, ref: 'another-source' }),
      contextSourceVersion({ ...source, namespace: 'another-workspace' }),
      { ...corrected, fingerprint: 'a'.repeat(64) }]) {
      expect(contextSourceChangeNotice(before, after)).toBeNull();
    }
    expect(contextSourceChangeNotice(undefined, corrected)).toBeNull();
  });

  it('normalizes NFC and newlines without losing whitespace or the final condition', () => {
    const canonical = 'Approve café.\nOnly after review.\n';
    expect(normalizeContextSourceText(source.fullText)).toBe(canonical);
    const first = contextSourceVersion(source);
    expect(first).toEqual(contextSourceVersion({ ...source, fullText: canonical }));
    expect(first.fullTextSha256).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(first.fullTextBytes).toBe(Buffer.byteLength(canonical));
    expect(contextSourceVersion({ ...source, fullText: canonical.trimEnd() }).fingerprint).not.toBe(first.fingerprint);
    expect(contextSourceVersion({ ...source, fullText: canonical.replace('Only after review.', 'Without review.') }).fingerprint)
      .not.toBe(first.fingerprint);
    expect(JSON.stringify(first)).not.toContain('Only after review');
    expect(first).toMatchObject({ normalizer: 'text-normalization-v1', revision: null,
      passage: { startByte: 0, endByte: Buffer.byteLength(canonical), sha256: first.fullTextSha256 } });
  });

  it('distinguishes full source, revision, validity, namespace and passage from emitted bytes', () => {
    const fullText = 'same passage\ncondition outside passage';
    const input = { ...source, fullText, passage: { startByte: 0, endByte: 12 } };
    const first = contextSourceVersion(input);
    const changed = contextSourceVersion({ ...input, fullText: fullText + ' unless waived' });
    expect(changed.passage).toEqual(first.passage);
    expect(changed.fullTextSha256).not.toBe(first.fullTextSha256);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    for (const patch of [
      { namespace: 'corpus' }, { ref: 'memory-2' }, { revision: 'r2' },
      { updatedAt: '2026-11-09T15:00:00Z' },
      { validity: { ...current, status: 'retracted' as const } },
      { validity: { ...current, status: 'expired' as const, invalidAt: '2026-11-08T00:00:00Z' } },
      { validity: { ...current, status: 'superseded' as const, supersededBy: 'memory-2' } },
      { passage: { startByte: 13, endByte: Buffer.byteLength(fullText) } },
    ]) expect(contextSourceVersion({ ...input, ...patch }).fingerprint).not.toBe(first.fingerprint);
  });

  it('snapshots explicit validity independently of input key order or later mutation', () => {
    const validity = { ...current, validAt: '2026-11-09T10:00:00-05:00' };
    const first = contextSourceVersion({ ...source, validity, updatedAt: '2026-11-09T10:00:00-05:00' });
    const reordered = { invalidAt: null, supersededBy: null, validAt: '2026-11-09T15:00:00Z', status: 'current' as const };
    expect(contextSourceVersion({ ...source, validity: reordered, updatedAt: '2026-11-09T15:00:00Z' })).toEqual(first);
    validity.validAt = '2026-11-10T15:00:00Z';
    expect(first.validity.validAt).toBe('2026-11-09T15:00:00.000Z');
  });

  it('rejects partial UTF-8 characters and out-of-range passages', () => {
    const input = { ...source, fullText: 'A☃éB' };
    expect(contextSourceVersion({ ...input, passage: { startByte: 1, endByte: 6 } }).passage)
      .toMatchObject({ startByte: 1, endByte: 6, sha256: createHash('sha256').update('☃é').digest('hex') });
    for (const passage of [{ startByte: -1, endByte: 3 }, { startByte: 2, endByte: 4 },
      { startByte: 1, endByte: 3 }, { startByte: 0, endByte: 8 }, { startByte: 4, endByte: 3 },
      { startByte: 0.5, endByte: 4 }, { startByte: 0, endByte: NaN }]) {
      expect(() => contextSourceVersion({ ...input, passage })).toThrow('complete UTF-8 byte range');
    }
  });

  it('preserves explicit unknown validity and rejects invalid canonical metadata', () => {
    expect(contextSourceVersion({ ...source, validity: { ...current, status: 'unknown' } }).validity.status).toBe('unknown');
    for (const patch of [{ namespace: '' }, { ref: '' }, { updatedAt: 'not-a-date' },
      { validity: { ...current, invalidAt: 'not-a-date' } }]) {
      expect(() => contextSourceVersion({ ...source, ...patch })).toThrow('context source');
    }
  });

  it('keeps an excerpt pointer explicit rather than claiming a full-source version', () => {
    const text = 'Only after review.';
    const pointer = renderContextSourceUnit(text, { kind: 'memory', ref: 'm1', link: 'memory:m1' }, 1);
    expect(pointer.operative).toBe(false);
    expect(pointer.text).toContain('"revision":"unknown"');
    expect(pointer.text).toContain('"passage":"retrieved-unit"');
    expect(pointer.text).not.toContain('fullTextSha256');
  });
});
