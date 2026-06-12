/**
 * pack-bar.test.ts — the D-006 learning-pack transfer bar (P-022 / FB-08):
 * dark ⇒ no gating, proven failure ⇒ blocked, everything else (untested /
 * validated / infra-error / IO trouble) ⇒ open. Fake flag + sql, zero IO.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { packCandidateTransferBar } from './pack-bar';

const Q = { workspaceId: 'ws', candidateId: 'cand-1', signature: 'sig-1' };

function sqlReturning(rows: Array<Record<string, unknown>>): { sql: Sql; calls: () => number } {
  let n = 0;
  const fn = async () => {
    n += 1;
    return rows;
  };
  return { sql: fn as unknown as Sql, calls: () => n };
}

describe('packCandidateTransferBar', () => {
  it('flag dark (the D-001 default) ⇒ no gating and the pool is never touched', async () => {
    const { sql, calls } = sqlReturning([{ tier: 'retired', status: 'failed' }]);
    const verdict = await packCandidateTransferBar(Q, {
      enabled: async () => false,
      getSql: async () => sql,
    });
    expect(verdict).toEqual({ blocked: false });
    expect(calls()).toBe(0);
  });

  it('no matching lesson ⇒ open (an untestable candidate is the owner’s call)', async () => {
    const { sql } = sqlReturning([]);
    const verdict = await packCandidateTransferBar(Q, { enabled: async () => true, getSql: async () => sql });
    expect(verdict).toEqual({ blocked: false });
  });

  it('a FAILED lesson blocks, with the evidence in the detail', async () => {
    const { sql } = sqlReturning([
      { id: 'L1', tier: 'probationary', status: 'failed', fail_count: 2, last_delta: -0.8 },
    ]);
    const verdict = await packCandidateTransferBar(Q, {
      enabled: async () => true,
      getSql: async () => sql,
      log: () => {},
    });
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.detail).toContain('failed');
      expect(verdict.detail).toContain('L1');
      expect(verdict.lesson.failCount).toBe(2);
    }
  });

  it('a RETIRED lesson blocks', async () => {
    const { sql } = sqlReturning([{ id: 'L2', tier: 'retired', status: 'failed', fail_count: 3, last_delta: null }]);
    const verdict = await packCandidateTransferBar(Q, { enabled: async () => true, getSql: async () => sql });
    expect(verdict.blocked).toBe(true);
  });

  it('a VALIDATED lesson is open (it passed)', async () => {
    const { sql } = sqlReturning([{ id: 'L3', tier: 'validated', status: 'passed', fail_count: 0, last_delta: 1.2 }]);
    const verdict = await packCandidateTransferBar(Q, { enabled: async () => true, getSql: async () => sql });
    expect(verdict).toEqual({ blocked: false });
  });

  it('a test-infra ERROR never blocks (not a lesson failure)', async () => {
    const { sql } = sqlReturning([{ id: 'L4', tier: 'probationary', status: 'error', fail_count: 0, last_delta: null }]);
    const verdict = await packCandidateTransferBar(Q, { enabled: async () => true, getSql: async () => sql });
    expect(verdict).toEqual({ blocked: false });
  });

  it('IO trouble fails OPEN — the curation queue is never wedged by the bar', async () => {
    const verdict = await packCandidateTransferBar(Q, {
      enabled: async () => true,
      getSql: async () => {
        throw new Error('pool down');
      },
      log: () => {},
    });
    expect(verdict).toEqual({ blocked: false });
  });
});
