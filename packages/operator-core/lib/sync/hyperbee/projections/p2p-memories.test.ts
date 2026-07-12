/**
 * p2p-memories projection (mem0-cross-machine-federation-2026-07-10, mirroring
 * F1-1 agent-facts) — hermetic tests for the wire validator + the H6
 * source-partitioning properties, mirroring `projections/agent-facts.test.ts`
 * exactly: a remote op lands in ITS OWN source partition; a remote op scoped to
 * a pot this hive never demux-matches (private-pot leak guard) is dropped with
 * NO SQL issued; a remote delete can never touch the local partition.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { buildMemoriesProjection, _testing, type MemoryWireRow } from './p2p-memories';

const { composeKey, decodeValue } = _testing;

const row = (over: Partial<MemoryWireRow> = {}): MemoryWireRow => ({
  harness_slug: 'papercusp',
  id: '11111111-1111-1111-1111-111111111111',
  payload: { user_id: 'u1', workspace_id: 'ws', shareable: true, text: 'a shareable memory' },
  created_at: new Date(86_400_000).toISOString(),
  updated_at: new Date(86_400_000).toISOString(),
  ...over,
});

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(): { sql: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('composeKey — the memory identity (the memory UUID)', () => {
  it('is just the row id', () => {
    expect(composeKey(row())).toBe('11111111-1111-1111-1111-111111111111');
    expect(composeKey(row({ id: 'other-id' }))).toBe('other-id');
  });
});

describe('decodeValue — defensive on every field (malformed/invalid rows dropped)', () => {
  it('accepts a well-formed wire row (extra to_jsonb fields tolerated)', () => {
    expect(decodeValue({ ...row(), shareable: true, origin: 'local', author_pubkey: '' })).not.toBeNull();
  });

  it('rejects malformed rows', () => {
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue(undefined)).toBeNull();
    expect(decodeValue('not-an-object')).toBeNull();
    expect(decodeValue(row({ harness_slug: '' }))).toBeNull(); // empty harness_slug
    expect(decodeValue(row({ id: '' }))).toBeNull(); // empty id
    expect(decodeValue({ ...row(), id: undefined as never })).toBeNull(); // missing id
    expect(decodeValue({ ...row(), payload: 'not-a-record' as never })).toBeNull(); // payload not an object
    expect(decodeValue({ ...row(), payload: ['array', 'not', 'record'] as never })).toBeNull(); // payload is an array
    expect(decodeValue({ ...row(), payload: null as never })).toBeNull(); // payload null
    expect(decodeValue({ ...row(), created_at: undefined as never })).toBeNull(); // missing created_at
    expect(decodeValue({ ...row(), updated_at: 12345 as never })).toBeNull(); // non-string updated_at
  });
});

describe('writeToPg — H6 source partitioning + private-pot leak guard', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('drops ops for a foreign/non-admitted pot (demux guard) — no SQL issued, no leak', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(row({ harness_slug: 'other-pot-not-mine' }), {
      authorPubkey: 'k1',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(0);
  });

  it('a REMOTE op lands in its receiver-stamped source partition', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'stamped-source-log-key',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(1);
    // source_hive (the partition) must be the RECEIVER-stamped author key.
    expect(calls[0]).toContain('stamped-source-log-key');
    expect(calls[0]).toContain('remote');
  });

  it('a LOCAL echo keeps the NULL (local) partition', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'own-device',
      origin: 'local',
    } as never);
    expect(calls.length).toBe(1);
    // The local partition: source_hive interpolates as null.
    expect(calls[0]).toContain(null);
  });

  it('a remote op with no stamped author key falls back to the unknown-remote partition (never NULL/local)', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: '',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('unknown-remote');
  });
});

describe('writeToPg — retraction-of-sharing guard (EI-10393)', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('a REMOTE put whose payload carries shareable:false issues the partition-scoped DELETE, never the upsert', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(
      row({ payload: { user_id: 'u1', workspace_id: 'ws', shareable: false, text: 'now private' } }),
      { authorPubkey: 'stamped-source-log-key', origin: 'remote' } as never,
    );
    expect(calls.length).toBe(1);
    // Exactly the retraction delete's bindings: ws + id + THAT peer's stamped
    // partition + the LWW ts (null twice — no provenance ts on this op).
    expect(calls[0]).toEqual([
      'ws',
      '11111111-1111-1111-1111-111111111111',
      'stamped-source-log-key',
      null,
      null,
    ]);
  });

  it('an ABSENT shareable key retracts too — only an affirmative true stores', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(
      row({ payload: { user_id: 'u1', workspace_id: 'ws', text: 'no shareable key at all' } }),
      { authorPubkey: 'peer-log-key', origin: 'remote' } as never,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['ws', '11111111-1111-1111-1111-111111111111', 'peer-log-key', null, null]);
  });

  it('a LOCAL echo with shareable:false still takes the upsert path (the local partition is never deleted here)', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(opts(sql)).writeToPg(
      row({ payload: { user_id: 'u1', workspace_id: 'ws', shareable: false, text: 'private local row' } }),
      { authorPubkey: 'own-device', origin: 'local' } as never,
    );
    expect(calls.length).toBe(1);
    // The upsert's bindings (not the 5-value delete): origin + the NULL local partition.
    expect(calls[0]).toContain('local');
    expect(calls[0]).toContain(null);
    expect(calls[0]?.length).toBeGreaterThan(5);
  });
});

describe('deleteFromPg — local partition immunity', () => {
  it('issues the delete only for a non-blank key', async () => {
    const { sql, calls } = fakeSql();
    const proj = buildMemoriesProjection({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });
    await proj.deleteFromPg!('11111111-1111-1111-1111-111111111111', 123, undefined);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('11111111-1111-1111-1111-111111111111');
    await proj.deleteFromPg!('', undefined, undefined);
    expect(calls.length).toBe(1); // blank key = no-op
  });

  it('registers with the echo-breaker + the right tag', () => {
    const proj = buildMemoriesProjection({ workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(proj.tableTag).toBe('p2p-memories-by-id');
    expect((proj as { skipOwnOps?: boolean }).skipOwnOps).toBe(true);
  });
});

describe('onRefusedOp — per-source refused-op counter (malformed remote ops)', () => {
  const mkOpts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('bumps a malformed counter for a REMOTE declined memory op with the source', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(mkOpts(sql)).onRefusedOp!(
      { totally: 'not-a-memory' },
      { authorPubkey: 'peer-log-key', origin: 'remote' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['ws', 'papercusp', 'peer-log-key', 'p2p-memories-by-id', 'malformed']);
  });

  it('does NOT count a LOCAL decode failure', async () => {
    const { sql, calls } = fakeSql();
    await buildMemoriesProjection(mkOpts(sql)).onRefusedOp!(
      { x: 1 },
      { authorPubkey: 'self', origin: 'local' },
    );
    expect(calls).toHaveLength(0);
  });
});
