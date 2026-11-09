/**
 * Unit pins for the session-epoch surfaced-memory ledger
 * (memory-delivery-unification-2026-07-12 P-002). Mirrors the fake-sql
 * pattern of bump-last-surfaced.test.ts: the contract under test is the
 * defensive posture (guards, uuid filtering, relation-missing latch) and
 * the statement shapes — the SQL itself is exercised by the migration-run
 * integration suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  currentSessionEpoch,
  bumpSessionEpoch,
  alreadySurfacedIds,
  stampSurfaced,
  _resetSessionEpochLedgerForTests,
  memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission,
  MEMORY_EMISSION_TTL_MS,
  collectMemoryEmission, collectsMemoryEmission, withMemoryEmissionReceipt,
  provenSystemNoticeEmissions,
} from './session-epoch-ledger';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';
import type { SqlTag } from './bump-last-surfaced';
import { contextSourceVersion } from './temporal-render';
import { alreadySurfacedRefs, stampSurfacedRefsResult, _resetCorpusLedgerLatchForTests } from './corpus-surfaced-ledger';
import { stampSurfacedResult } from './session-epoch-ledger';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('exact memory emission receipts', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());
  const offer = (id = UUID_A, epoch = 3, kind: 'memory' | 'corpus' = 'memory') =>
    memoryFragmentOffer(kind, id, epoch, 'turn-start', `- ${id}: complete snowman ☃`);
  const manifest = ({ rendered: _text, ...row }: ReturnType<typeof offer>) => row;

  it('requires an exact notice stdout proof and records its emission time rather than confirmation time', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const { sql, calls } = makeSql({ impl: async text => text.includes('RETURNING surface') ? [{ surface: 'notice' }] : [] });
      const row = { ...memoryFragmentOffer('notice', 'a'.repeat(64), 3, 'coord-inbox', '- syste condition'),
        sourceFingerprint: 'b'.repeat(64) };
      const { rendered: _text, ...fragment } = row;
      await stageMemoryEmission(sql, 'owner', 'notice-token', [row]);
      clock.mockReturnValue(2_000);
      for (const emittedAt of [undefined, 999, 2_001, NaN]) {
        expect(await confirmMemoryEmission(sql, 'owner', { token: 'notice-token', fragments: [fragment], emittedAt })).toBe(0);
      }
      expect(await confirmMemoryEmission(sql, 'other-owner', { token: 'notice-token', fragments: [fragment], emittedAt: 1_500 })).toBe(0);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'notice-token',
        fragments: [{ ...fragment, bodyBytes: fragment.bodyBytes - 1 }], emittedAt: 1_500 })).toBe(0);
      const writes = () => calls.filter(call => call.text.includes('RETURNING surface'));
      expect(writes()).toHaveLength(0);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'notice-token', fragments: [fragment], emittedAt: 1_500 })).toBe(1);
      expect(writes()).toHaveLength(1);
      expect(writes()[0]!.values).toContain(JSON.stringify({ fingerprint: row.sourceFingerprint, emittedAt: 1_500 }));
      expect(writes()[0]!.text).toContain("committed->>'emittedAt'");
      expect(writes()[0]!.text).toContain('< ?'); // delayed older proofs cannot overwrite a newer floor
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'notice-token', fragments: [fragment], emittedAt: 1_500 })).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it('reads notice proof only within the requested recipient, epoch and episode keys', async () => {
    const key = 'a'.repeat(64), fingerprint = 'b'.repeat(64);
    const { sql, calls } = makeSql({ rows: [
      { surface: `notice-emitted:3:${key}`, committed: { fingerprint, emittedAt: 1_500 } },
      { surface: `notice-emitted:4:${key}`, committed: { fingerprint, emittedAt: 1_600 } },
      { surface: 'notice-emitted:3:bad', committed: { fingerprint: 'invalid', emittedAt: 2_000 } },
    ] });
    expect(await provenSystemNoticeEmissions(sql, 'reader', 3, [key, key, 'bad'])).toEqual({
      [key]: { fingerprint, emittedAt: 1_500 },
    });
    expect(calls[0]!.values).toContain('reader');
    expect(calls[0]!.values).toContainEqual([`notice-emitted:3:${key}`]);
  });

  it('binds identical emitted bytes to the exact canonical revision without accepting an older native receipt', async () => {
    const { sql, calls } = makeSql();
    const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A,
      fullText: 'same passage\nOnly after approval.', revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null },
      passage: { startByte: 0, endByte: 12 } });
    const revised = contextSourceVersion({ namespace: 'memory', ref: UUID_A,
      fullText: 'same passage\nOnly after independent approval.', revision: 'r2', updatedAt: null,
      validity: source.validity, passage: { startByte: 0, endByte: 12 } });
    const first = memoryFragmentOffer('memory', UUID_A, 3, 'turn-start', 'same passage', source);
    const second = memoryFragmentOffer('memory', UUID_A, 3, 'turn-start', first.rendered, revised);
    expect(first.bodySha256).toBe(second.bodySha256);
    expect(first.sourceFingerprint).not.toBe(second.sourceFingerprint);
    source.validity.status = 'retracted';
    expect(first.sourceVersion?.validity.status).toBe('current');
    await stageMemoryEmission(sql, 'owner', 'version-token', [second]);
    const { rendered: _text, sourceVersion: _source, ...native } = second;
    const inserts = () => calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'));
    const { sourceFingerprint: _fingerprint, ...legacy } = native;
    for (const fragments of [[legacy], [{ ...native, sourceFingerprint: first.sourceFingerprint }],
      [{ ...native, sourceFingerprint: 'invalid' }]]) {
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'version-token', fragments })).toBe(0);
    }
    expect(inserts()).toHaveLength(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'version-token', fragments: [native] })).toBe(1);
    expect(inserts()).toHaveLength(1);
  });

  it('keeps distinct source versions in one response and rejects mismatched source references', async () => {
    const { sql } = makeSql();
    const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'complete source',
      revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = memoryFragmentOffer('memory', UUID_A, 3, 'orient', 'same emitted body', source);
    const revised = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'complete revised source',
      revision: 'r2', updatedAt: null, validity: source.validity });
    const next = memoryFragmentOffer('memory', UUID_A, 3, 'orient', row.rendered, revised);
    const result = await withMemoryEmissionReceipt(sql, 'owner', [], async () => {
      collectMemoryEmission('owner', [row, next, { ...row, sourceFingerprint: 'invalid' },
        { ...row, sourceVersion: undefined }, { ...row, sourceFingerprint: undefined },
        { ...row, sourceVersion: { ...source, ref: UUID_B } }]);
      return { instructions: row.rendered };
    });
    expect(result._meta?.['papercusp/memoryEmission']).toMatchObject({ fragments: [row, next] });
    expect(() => memoryFragmentOffer('memory', UUID_B, 3, 'orient', row.rendered, source))
      .toThrow('source identity');
  });

  it.each(['memory', 'corpus'] as const)('uses the host-staged %s baseline even if the native receipt supplies a replacement', async kind => {
    let current = 'a'.repeat(64);
    const { sql, calls } = makeSql({ impl: async text => text.includes('JOIN harness_shared.')
      ? [{ id: UUID_A, epoch: 3, source_fingerprint: current }] : text.includes('RETURNING') ? [{ id: UUID_A }] : [] });
    const source = contextSourceVersion({ namespace: kind, ref: UUID_A, fullText: 'complete revised source',
      revision: 'r2', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = memoryFragmentOffer(kind, UUID_A, 3, 'turn-start', 'complete passage', source);
    await stageMemoryEmission(sql, 'owner', 'baseline-token', [row]);
    current = 'b'.repeat(64);
    const { rendered: _text, sourceVersion: _source, ...native } = row;
    await confirmMemoryEmission(sql, 'owner', { token: 'baseline-token',
      fragments: [{ ...native, previousSourceFingerprint: current } as typeof native] });
    const stamp = calls.find(call => call.text.includes(`INSERT INTO harness_shared.${kind}_session_surfaced`));
    expect(stamp?.values).toContain('a'.repeat(64));
    expect(stamp?.values).not.toContain(current);
  });

  it('does not prepare a versioned token when its confirmed baseline cannot be read', async () => {
    const { sql } = makeSql({ impl: async text => {
      if (text.includes('JOIN harness_shared.')) throw new Error('baseline unavailable');
      return [];
    } });
    const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'source',
      revision: null, updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = memoryFragmentOffer('memory', UUID_A, 3, 'orient', 'source', source);
    await expect(stageMemoryEmission(sql, 'owner', 'baseline-unavailable', [row])).rejects.toThrow('baseline unavailable');
    expect(await confirmMemoryEmission(makeSql().sql, 'owner', {
      token: 'baseline-unavailable', fragments: [manifest(row)] })).toBe(0);
  });

  it.each(['memory', 'corpus'] as const)('revalidates %s authority after baseline capture on every staging attempt', async kind => {
    let baselineRead = false;
    const { sql } = makeSql({ impl: async text => {
      if (text.includes('JOIN harness_shared.')) baselineRead = true;
      return text.includes('RETURNING') ? [{ id: UUID_A }] : [];
    } });
    const source = contextSourceVersion({ namespace: kind, ref: UUID_A, fullText: 'complete source',
      revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const changed = contextSourceVersion({ namespace: kind, ref: UUID_A, fullText: 'changed source',
      revision: 'r2', updatedAt: null, validity: source.validity });
    let current: typeof source | null = source;
    const signals: AbortSignal[] = [];
    const revalidate = vi.fn(async (signal: AbortSignal) => {
      expect(baselineRead).toBe(true);
      signals.push(signal);
      return current;
    });
    const row = memoryFragmentOffer(kind, UUID_A, 3, 'orient', 'complete passage', source, revalidate);
    await stageMemoryEmission(sql, 'owner', 'fresh-source', [row]);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'fresh-source', fragments: [manifest(row)] })).toBe(1);
    for (const [token, value] of [['changed-source', changed], ['denied-source', null]] as const) {
      current = value;
      await expect(stageMemoryEmission(sql, 'owner', token, [row])).rejects.toThrow('source changed or is unavailable');
      expect(await confirmMemoryEmission(sql, 'owner', { token, fragments: [manifest(row)] })).toBe(0);
    }
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
  });

  it('retains visible content without a suppressing receipt when its canonical reader fails', async () => {
    const { sql, calls } = makeSql();
    const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'complete source',
      revision: null, updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = memoryFragmentOffer('memory', UUID_A, 3, 'orient', 'complete source', source,
      async () => { throw new Error('canonical reader failed'); });
    const result = await withMemoryEmissionReceipt(sql, 'owner', [], async () => {
      collectMemoryEmission('owner', [row]);
      return { instructions: row.rendered };
    });
    expect(result.instructions).toBe(row.rendered);
    expect(result._meta?.['papercusp/memoryEmission']).toBeUndefined();
    expect(calls.some(call => call.text.includes('INSERT INTO harness_shared.memory_session_surfaced'))).toBe(false);
  });

  it('bounds a stalled canonical revalidation without issuing a receipt', async () => {
    vi.useFakeTimers();
    try {
      const { sql } = makeSql();
      let started!: () => void;
      const readerStarted = new Promise<void>(resolve => { started = resolve; });
      let readerSignal: AbortSignal | undefined;
      const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'complete source',
        revision: null, updatedAt: null,
        validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
      const row = memoryFragmentOffer('memory', UUID_A, 3, 'orient', 'complete source', source, async signal => {
        readerSignal = signal;
        started();
        return new Promise<null>(() => {});
      });
      const pending = withMemoryEmissionReceipt(sql, 'owner', [], async () => {
        collectMemoryEmission('owner', [row]);
        return { instructions: row.rendered };
      });
      await readerStarted;
      await vi.advanceTimersByTimeAsync(1_501);
      const result = await pending;
      expect(result.instructions).toBe(row.rendered);
      expect(result._meta?.['papercusp/memoryEmission']).toBeUndefined();
      expect(readerSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('keeps canonical reader callbacks off the native receipt wire', async () => {
    const { sql } = makeSql();
    const source = contextSourceVersion({ namespace: 'memory', ref: UUID_A, fullText: 'complete source',
      revision: null, updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const row = memoryFragmentOffer('memory', UUID_A, 3, 'orient', 'complete source', source, async () => source);
    const result = await withMemoryEmissionReceipt(sql, 'owner', [], async () => {
      collectMemoryEmission('owner', [row]);
      return { instructions: row.rendered };
    });
    const receipt = result._meta?.['papercusp/memoryEmission'] as { fragments: object[] };
    expect(receipt.fragments).toHaveLength(1);
    expect(receipt.fragments[0]).not.toHaveProperty('revalidateSource');
    expect(receipt.fragments[0]).toHaveProperty('sourceFingerprint', source.fingerprint);
  });

  it('stages only complete model-visible fragments and confirms them before the next recall', async () => {
    const { sql, calls } = makeSql();
    const a = offer(), clipped = offer(UUID_B);
    const result = await withMemoryEmissionReceipt(sql, 'owner', [], async () => {
      expect(collectsMemoryEmission('owner')).toBe(true);
      expect(collectsMemoryEmission('foreign')).toBe(false);
      collectMemoryEmission('foreign', [clipped]);
      collectMemoryEmission('owner', [a, clipped]);
      return { content: [{ type: 'text', text: JSON.stringify({ memory: a.rendered,
        clipped: clipped.rendered.slice(0, -1), _meta: { private: clipped.rendered } }) }],
        _meta: { existing: 'preserved' } };
    });
    const receipt = result._meta['papercusp/memoryEmission'] as {
      owner: string; token: string; fragments: ReturnType<typeof offer>[];
    };
    expect(receipt).toMatchObject({ owner: 'owner', fragments: [a] });
    expect(result._meta.existing).toBe('preserved');
    const inserts = () => calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'));
    expect(inserts()).toHaveLength(0);
    await withMemoryEmissionReceipt(sql, 'owner', [{ token: receipt.token, fragments: [manifest(a)] }], async () => {
      expect(inserts()).toHaveLength(1);
      return { content: [] };
    });
    expect(collectsMemoryEmission('owner')).toBe(false);
  });

  it('isolates overlapping recipients and rejects metadata-only, structured-only and late offers', async () => {
    const { sql } = makeSql();
    const row = offer();
    const prepare = (owner: string) => withMemoryEmissionReceipt(sql, owner, [], async () => {
      await Promise.resolve();
      collectMemoryEmission(owner, [row]);
      return { instructions: row.rendered };
    });
    const [a, b] = await Promise.all([prepare('a'), prepare('b')]);
    expect(a._meta?.['papercusp/memoryEmission']).toMatchObject({ owner: 'a' });
    expect(b._meta?.['papercusp/memoryEmission']).toMatchObject({ owner: 'b' });
    expect(a._meta?.['papercusp/memoryEmission']).not.toEqual(b._meta?.['papercusp/memoryEmission']);
    let late: () => void = () => {};
    const hidden = await withMemoryEmissionReceipt(sql, 'owner', [], async () => {
      late = () => collectMemoryEmission('owner', [row]);
      collectMemoryEmission('owner', [row]);
      return { content: [], structuredContent: { memory: row.rendered }, _meta: { private: row.rendered } };
    });
    late();
    expect(hidden._meta).toEqual({ private: row.rendered });
    expect(collectsMemoryEmission('owner')).toBe(false);
  });

  it('does not stamp preparation, absent output, a wrong owner or a forged fragment', async () => {
    const { sql, calls } = makeSql();
    const row = offer();
    await stageMemoryEmission(sql, 'owner', 'token-a', [row]);
    const inserts = () => calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'));
    expect(inserts()).toHaveLength(0);
    expect(await confirmMemoryEmission(sql, 'other-owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'wrong-token', fragments: [manifest(row)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [{ ...manifest(row), bodyBytes: row.bodyBytes - 1 }] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [] })).toBe(0);
    expect(inserts()).toHaveLength(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(1);
    expect(inserts()).toHaveLength(1);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(0);
  });

  it('keeps overlapping port tokens separate and stamps only the exact emitted subset at its captured epoch', async () => {
    const { sql, calls } = makeSql();
    const a = offer(), b = offer(UUID_B, 4), c = offer('WI-123', 3, 'corpus');
    await stageMemoryEmission(sql, 'owner', 'token-a', [a, c]);
    await stageMemoryEmission(sql, 'owner', 'token-b', [{ ...b, port: 'mid-turn' }]);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-b', fragments: [manifest(b)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(c)] })).toBe(1);
    expect(calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'))).toHaveLength(0);
    const corpusWrite = calls.find(c => c.text.includes('INSERT INTO harness_shared.corpus_session_surfaced'))!;
    expect(corpusWrite.values).toContain(3); // never resolve a newer compaction epoch at confirmation time
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-b', fragments: [{ ...manifest(b), port: 'mid-turn' }] })).toBe(1);
  });

  it('retains an emission candidate after a failed ledger write for a later retry', async () => {
    let fail = true;
    const { sql } = makeSql({ impl: async text => {
      if (fail && text.includes('INSERT INTO harness_shared.memory_session_surfaced')) throw new Error('connection interrupted');
      return text.includes('RETURNING memory_id') ? [{ memory_id: UUID_A }] : [];
    } });
    const row = offer();
    await stageMemoryEmission(sql, 'owner', 'token-a', [row]);
    const proof = { token: 'token-a', fragments: [manifest(row)] };
    expect(await confirmMemoryEmission(sql, 'owner', proof)).toBe(0);
    fail = false;
    expect(await confirmMemoryEmission(sql, 'owner', proof)).toBe(1);
  });

  it('abandons expired candidates without advancing delivery, allowing a fresh attempt', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1000);
      const { sql, calls } = makeSql();
      const row = offer();
      await stageMemoryEmission(sql, 'owner', 'expired-token', [row]);
      now.mockReturnValue(1000 + MEMORY_EMISSION_TTL_MS);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'expired-token', fragments: [manifest(row)] })).toBe(0);
      expect(calls.some(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'))).toBe(false);
      await stageMemoryEmission(sql, 'owner', 'fresh-token', [row]);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'fresh-token', fragments: [manifest(row)] })).toBe(1);
    } finally { now.mockRestore(); }
  });
});

function makeSql(opts?: {
  rows?: unknown[];
  impl?: (text: string, values: unknown[]) => Promise<unknown>;
}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (template: TemplateStringsArray, ...values: unknown[]) => {
    const text = template.join('?');
    calls.push({ text, values });
    if (opts?.impl) return opts.impl(text, values);
    return opts?.rows ?? (text.includes('RETURNING memory_id') || text.includes('RETURNING ref') ? [{ id: 'inserted' }] : []);
  }) as unknown as SqlTag;
  return { sql, calls };
}

beforeEach(() => {
  _resetSessionEpochLedgerForTests();
  _resetCorpusLedgerLatchForTests();
});

describe.each(['memory', 'corpus'] as const)('version-aware %s ledger', kind => {
  const id = kind === 'memory' ? UUID_A : 'doc:fixture';
  const read = (sql: SqlTag, versions: ReadonlyMap<string, string>) => kind === 'memory'
    ? alreadySurfacedIds(sql, 'owner', 3, [id], versions) : alreadySurfacedRefs(sql, 'owner', 3, [id], versions);
  it('requires the current exact source fingerprint instead of accepting stable-id, unknown or stale rows', async () => {
    for (const stored of [undefined, null, 'invalid', 'a'.repeat(64), 'b'.repeat(64)]) {
      const { sql } = makeSql({ rows: [{ id, ref: id, source_fingerprint: stored }] });
      expect(await read(sql, new Map([[id, 'b'.repeat(64)]])))
        .toEqual(new Set(stored === 'b'.repeat(64) ? [id] : []));
      expect(await read(sql, new Map())).toEqual(new Set());
    }
  });
  it('writes a fingerprint only from a versioned confirmation and keeps legacy writes insert-only', async () => {
    const { sql, calls } = makeSql();
    const stamp = kind === 'memory' ? stampSurfacedResult : stampSurfacedRefsResult;
    expect((await stamp(sql, 'owner', 3, [id], 'claim', 'b'.repeat(64))).ok).toBe(true);
    expect(calls[0]?.text).toContain('IS DISTINCT FROM EXCLUDED.source_fingerprint');
    expect(calls[0]?.values).toContain('b'.repeat(64));
    calls.length = 0;
    expect((await stamp(sql, 'owner', 3, [id], 'legacy')).ok).toBe(true);
    expect(calls[0]?.text).toContain('DO NOTHING');
    expect(calls[0]?.text).not.toContain('DO UPDATE');
    calls.length = 0;
    expect(await stamp(sql, 'owner', 3, [id], 'claim', 'invalid')).toEqual({ ok: false, inserted: 0 });
    expect(calls).toEqual([]);
  });
});

describe('currentSessionEpoch', () => {
  it('returns 0 for an empty sessionId without querying', async () => {
    const { sql, calls } = makeSql();
    expect(await currentSessionEpoch(sql, '')).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('returns 0 when the session has no row', async () => {
    const { sql } = makeSql({ rows: [] });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(0);
  });

  it('returns the stored epoch', async () => {
    const { sql } = makeSql({ rows: [{ epoch: 3 }] });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(3);
  });

  it('returns 0 on error (best-effort)', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(0);
  });
});

describe('bumpSessionEpoch', () => {
  it('returns the new epoch; the only GC is the age sweep (superseded-epoch rows KEPT for forensics)', async () => {
    const { sql, calls } = makeSql({
      impl: async (text) => (text.includes('RETURNING') ? [{ epoch: 2 }] : []),
    });
    expect(await bumpSessionEpoch(sql, 'sid-1')).toBe(2);
    // upsert + age GC only — rubric-system-improvements-2026-07-12 P-005: an
    // immediate superseded-epoch DELETE erased drill forensics mid-grade; old
    // rows are dedup-inert (reads filter on the current epoch), so they stay
    // until the age sweep.
    expect(calls.length).toBe(2);
    expect(calls[0].text).toContain('memory_session_epochs');
    expect(calls[0].text).toContain('ON CONFLICT');
    expect(calls[1].text).toContain('surfaced_at <');
    expect(calls.some((c) => c.text.includes('epoch <'))).toBe(false);
  });

  it('returns null on failure', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('nope'); } });
    expect(await bumpSessionEpoch(sql, 'sid-1')).toBeNull();
  });

  it('returns null for an empty sessionId without querying', async () => {
    const { sql, calls } = makeSql();
    expect(await bumpSessionEpoch(sql, '')).toBeNull();
    expect(calls.length).toBe(0);
  });
});

describe('alreadySurfacedIds', () => {
  it('maps rows to a set', async () => {
    const { sql } = makeSql({ rows: [{ id: UUID_A }] });
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, [UUID_A, UUID_B]);
    expect(got).toEqual(new Set([UUID_A]));
  });

  it('filters non-uuid ids and skips the query when none survive', async () => {
    const { sql, calls } = makeSql();
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, ['nope', 'also bad']);
    expect(got.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('returns the empty set on error (degrades to no-dedup)', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, [UUID_A]);
    expect(got.size).toBe(0);
  });
});

describe('stampSurfaced', () => {
  it('inserts with the port tag', async () => {
    const { sql, calls } = makeSql();
    expect(await stampSurfaced(sql, 'sid-1', 1, [UUID_A], 'claim')).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain('INSERT INTO harness_shared.memory_session_surfaced');
    expect(calls[0].text).toContain('ON CONFLICT');
    expect(calls[0].values).toContain('claim');
  });

  it('no-ops (true) when no valid uuid survives the filter', async () => {
    const { sql, calls } = makeSql();
    expect(await stampSurfaced(sql, 'sid-1', 1, ['bad-id'], 'claim')).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('returns false on error', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    expect(await stampSurfaced(sql, 'sid-1', 1, [UUID_A], 'claim')).toBe(false);
  });
});

describe('relation-missing latch', () => {
  it('caches "relation does not exist" as a process-wide no-op until reset', async () => {
    const boom = makeSql({
      impl: async () => {
        throw new Error('relation "harness_shared.memory_session_surfaced" does not exist');
      },
    });
    await alreadySurfacedIds(boom.sql, 'sid-1', 0, [UUID_A]);
    // Latched: subsequent calls skip SQL entirely.
    const after = makeSql({ rows: [{ epoch: 9 }] });
    expect(await currentSessionEpoch(after.sql, 'sid-1')).toBe(0);
    expect(await stampSurfaced(after.sql, 'sid-1', 0, [UUID_A], 'x')).toBe(false);
    expect(after.calls.length).toBe(0);
    // Reset restores.
    _resetSessionEpochLedgerForTests();
    expect(await currentSessionEpoch(after.sql, 'sid-1')).toBe(9);
    expect(after.calls.length).toBe(1);
  });
});
