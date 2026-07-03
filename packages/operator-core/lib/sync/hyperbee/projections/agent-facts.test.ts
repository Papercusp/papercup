/**
 * agent-facts projection (F1-1, federated-scout-gym-learning-2026-07-02) —
 * hermetic tests for the wire validators + the H6 source-partitioning
 * properties: a remote op lands in ITS OWN source partition; a remote delete
 * can never touch the local partition.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { buildAgentFactsProjection, _testing, type AgentFactWireRow } from './agent-facts';

const { composeKey, decodeValue } = _testing;

const row = (over: Partial<AgentFactWireRow> = {}): AgentFactWireRow => ({
  harness_slug: 'papercusp',
  scope: 'harness',
  scope_ref: 'papercusp',
  key: 'tests-need-docker',
  body: 'This harness integration tests require Docker (testcontainers).',
  source_ref: 'WI-42',
  expires_at: new Date(86_400_000).toISOString(),
  retracted_at: null,
  created_by: 'bee-7',
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

describe('composeKey — matches mig 462 fed_key exactly', () => {
  it('scope/ref/key, with empty string for a null ref', () => {
    expect(composeKey(row())).toBe('harness/papercusp/tests-need-docker');
    expect(composeKey(row({ scope: 'workspace', scope_ref: null, key: 'k' }))).toBe('workspace//k');
  });
});

describe('decodeValue — defensive on every field', () => {
  it('accepts a well-formed wire row (extra to_jsonb fields tolerated)', () => {
    expect(decodeValue({ ...row(), shareable: true, origin: 'local', fed_key: 'x' })).not.toBeNull();
  });
  it('rejects malformed rows', () => {
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue(row({ harness_slug: '' }))).toBeNull();
    expect(decodeValue(row({ scope: 'galaxy' as never }))).toBeNull();
    expect(decodeValue(row({ body: 'x'.repeat(501) }))).toBeNull();
    expect(decodeValue({ ...row(), key: undefined as never })).toBeNull();
  });
});

describe('writeToPg — H6 source partitioning', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('drops ops for a different hive home (demux guard) — no SQL issued', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(row({ harness_slug: 'other-hive' }), {
      authorPubkey: 'k1',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(0);
  });

  it('a REMOTE op lands in its receiver-stamped source partition', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(row(), {
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
    await buildAgentFactsProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'own-device',
      origin: 'local',
    } as never);
    expect(calls.length).toBe(1);
    // The local partition: source_hive interpolates as null.
    expect(calls[0]).toContain(null);
  });
});

describe('deleteFromPg — local partition immunity', () => {
  it('issues the retract-update only for parseable keys', async () => {
    const { sql, calls } = fakeSql();
    const proj = buildAgentFactsProjection({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });
    await proj.deleteFromPg!('harness/papercusp/tests-need-docker', 123, undefined);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('tests-need-docker');
    await proj.deleteFromPg!('', undefined, undefined);
    expect(calls.length).toBe(1); // blank key = no-op
  });

  it('registers with the echo-breaker + the right tag', () => {
    const proj = buildAgentFactsProjection({ workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(proj.tableTag).toBe('agent-facts-by-key');
    expect((proj as { skipOwnOps?: boolean }).skipOwnOps).toBe(true);
  });
});

describe('onRefusedOp — per-source refused-op counter (F1-4 / P-012)', () => {
  const mkOpts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('bumps a malformed counter for a REMOTE declined fact op with the source', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(mkOpts(sql)).onRefusedOp!(
      { totally: 'not-a-fact' },
      { authorPubkey: 'peer-log-key', origin: 'remote' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['ws', 'papercusp', 'peer-log-key', 'agent-facts-by-key', 'malformed']);
  });

  it('does NOT count a LOCAL decode failure', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(mkOpts(sql)).onRefusedOp!(
      { x: 1 },
      { authorPubkey: 'self', origin: 'local' },
    );
    expect(calls).toHaveLength(0);
  });
});
