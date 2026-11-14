import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn());
const boundedPgReadTxn = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('./pg-read-query', () => ({
  boundedPgReadTxn: (...args: unknown[]) => boundedPgReadTxn(...args),
}));

import {
  READ_PROOF_READ_ACQUIRE_TIMEOUT_MS,
  READ_PROOF_READ_LOCK_TIMEOUT_MS,
  READ_PROOF_READ_TIMEOUT_MS,
  readSuccessfulReadProofs,
} from './carry-surface-read-proof';

const turnRef = '[turn:session1@2026-11-12T20:00:00.000Z]';

beforeEach(() => {
  sql.mockReset();
  boundedPgReadTxn.mockReset();
  boundedPgReadTxn.mockImplementation(async (read: unknown) => {
    if (typeof read !== 'function') throw new Error('expected bounded read callback');
    return (read as (tx: unknown) => Promise<unknown>)(sql);
  });
});

describe('carry-surface same-turn file-read proof', () => {
  it('returns only exact absolute paths from successful direct and nested read rows', async () => {
    sql.mockResolvedValue([
      { source: 'direct', args_json: { file_path: '/tmp/direct-run.log' } },
      { source: 'nested-code-run', args_json: { file_path: '/tmp/nested-run.log' } },
      { source: 'direct', args_json: { file_path: 'relative-run.log' } },
      { source: 'direct', args_json: { uri: 'papercusp://scratch/run.log' } },
    ]);

    const proofs = await readSuccessfulReadProofs({
      workspaceId: 'ws-1',
      coordOwnerId: 'su-owner',
      turnRef,
    });

    expect(proofs).toEqual([
      { path: '/tmp/direct-run.log', source: 'direct' },
      { path: '/tmp/nested-run.log', source: 'nested-code-run' },
    ]);
    const query = String(sql.mock.calls[0]?.[0]?.join(' '));
    expect(query).toContain('workspace_id');
    expect(query).toContain('coord_owner_id');
    expect(query).toContain('invoked_at >=');
    expect(query).toContain("status = 'ok'");
    expect(query).toContain("metadata_json->>'spillFailed'");
    expect(query).toContain('code_recipe_runs');
    expect(query).toContain("'{runEvidence,invocationId}'");
    expect(query).toContain('COUNT(DISTINCT run.execution_trace) = 1');
    expect(query).toContain('bool_and(run.success)');
    expect(query).toContain("bool_and(run.execution_trace #>> '{runEvidence,executed}' = 'true')");
    expect(query).toContain("'{toolGraph,runtimeCalls}'");
    expect(query).toContain("'dispatchCallId'");
    expect(query).toContain("'disposition' = 'settled'");
    expect(boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function), {
      client: sql,
      timeoutMs: READ_PROOF_READ_TIMEOUT_MS,
      acquireTimeoutMs: READ_PROOF_READ_ACQUIRE_TIMEOUT_MS,
      lockTimeoutMs: READ_PROOF_READ_LOCK_TIMEOUT_MS,
      acquirePool: 'org-admin',
    });
  });

  it('deduplicates the same exact path without normalizing away path identity', async () => {
    sql.mockResolvedValue([
      { source: 'direct', args_json: { file_path: '/tmp/a/../run.log' } },
      { source: 'direct', args_json: { file_path: '/tmp/a/../run.log' } },
      { source: 'direct', args_json: { file_path: '/tmp/run.log' } },
    ]);

    const proofs = await readSuccessfulReadProofs({ workspaceId: 'ws-1', coordOwnerId: 'su-owner', turnRef });

    expect(proofs).toEqual([
      { path: '/tmp/a/../run.log', source: 'direct' },
      { path: '/tmp/run.log', source: 'direct' },
    ]);
  });

  it('does not query without a host-resolved turn reference or a concrete scope', async () => {
    expect(await readSuccessfulReadProofs({ workspaceId: 'ws-1', coordOwnerId: 'su-owner', turnRef: 'turn:unknown' })).toBeNull();
    expect(await readSuccessfulReadProofs({ workspaceId: 'ws-1', turnRef })).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });

  it('keeps proof unavailable when the bounded ledger read fails', async () => {
    boundedPgReadTxn.mockRejectedValueOnce(new Error('ledger unavailable'));

    expect(await readSuccessfulReadProofs({ workspaceId: 'ws-1', coordOwnerId: 'su-owner', turnRef })).toBeNull();
  });
});
