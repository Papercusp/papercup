/**
 * MCP write idempotency / result replay — regression for full-app-audit
 * P-046 (EI-68), mig 220 + _mcp-result-replay.ts.
 *
 * The reconnect contract: a tools/call carrying `_meta.idempotencyKey`
 * persists its serialized result; a re-call with the SAME key (after the
 * first response died on a dropped connection) replays the stored
 * outcome, tagged `_meta.replayed: true`, instead of re-executing.
 *
 * Live-PG test against harness_shared.mcp_tool_results.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import {
  validIdempotencyKey,
  lookupStoredMcpResult,
  storeMcpResult,
  sweepExpiredMcpResults,
  type StoredMcpResult,
} from '../_mcp-result-replay';

const RUN = Date.now();
const OWNER_A = `replay-test-owner-a-${RUN}`;
const OWNER_B = `replay-test-owner-b-${RUN}`;

const RESULT: StoredMcpResult = {
  content: [{ type: 'text', text: '{"ok":true,"created":"WI-42"}' }],
  _meta: { format: 'json' },
};

async function dbLive(): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('MCP result replay (audit P-046 / EI-68)', async () => {
  const live = await dbLive();

  afterAll(async () => {
    if (!live) return;
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.mcp_tool_results WHERE owner_key LIKE 'replay-test-owner-%'`;
  });

  it('validates caller-supplied keys (non-empty bounded strings only)', () => {
    expect(validIdempotencyKey('write-1')).toBe('write-1');
    expect(validIdempotencyKey('  padded ')).toBe('padded');
    expect(validIdempotencyKey('')).toBeNull();
    expect(validIdempotencyKey('   ')).toBeNull();
    expect(validIdempotencyKey(42)).toBeNull();
    expect(validIdempotencyKey(undefined)).toBeNull();
    expect(validIdempotencyKey('x'.repeat(201))).toBeNull();
  });

  it.skipIf(!live)('stores a result and replays it tagged _meta.replayed', async () => {
    expect(await lookupStoredMcpResult(OWNER_A, 'k1')).toBeNull();

    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k1',
      toolName: 'work_items:create',
      workspaceId: 'default',
      result: RESULT,
    });

    const replayed = await lookupStoredMcpResult(OWNER_A, 'k1');
    expect(replayed).not.toBeNull();
    expect(replayed!.content).toEqual(RESULT.content);
    expect(replayed!._meta).toMatchObject({ format: 'json', replayed: true });
    expect(replayed!.isError).toBeUndefined();
  });

  it.skipIf(!live)('keys are scoped per owner — another caller with the same key sees nothing', async () => {
    expect(await lookupStoredMcpResult(OWNER_B, 'k1')).toBeNull();
  });

  it.skipIf(!live)('first write wins — a concurrent same-key store never clobbers the original', async () => {
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k1',
      toolName: 'work_items:create',
      workspaceId: 'default',
      result: { content: [{ type: 'text', text: 'SECOND EXECUTION' }] },
    });
    const replayed = await lookupStoredMcpResult(OWNER_A, 'k1');
    expect(replayed!.content).toEqual(RESULT.content);
  });

  it.skipIf(!live)('error results replay with isError preserved', async () => {
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k-err',
      toolName: 'plans:set-status',
      workspaceId: 'default',
      result: { content: [{ type: 'text', text: 'claim_conflict: held by peer' }], isError: true },
    });
    const replayed = await lookupStoredMcpResult(OWNER_A, 'k-err');
    expect(replayed!.isError).toBe(true);
    expect(replayed!._meta).toMatchObject({ replayed: true });
  });

  it.skipIf(!live)('the sweep removes only rows past the 1h TTL; lookup ignores them either way', async () => {
    const { sql } = getOrgPg();
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k-old',
      toolName: 'plans:set-now',
      workspaceId: 'default',
      result: RESULT,
    });
    await sql`
      UPDATE harness_shared.mcp_tool_results
         SET created_at = now() - interval '2 hours'
       WHERE owner_key = ${OWNER_A} AND idempotency_key = 'k-old'
    `;
    // Expired → invisible to lookup even before the sweep runs.
    expect(await lookupStoredMcpResult(OWNER_A, 'k-old')).toBeNull();

    const swept = await sweepExpiredMcpResults();
    expect(swept).toBeGreaterThanOrEqual(1);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.mcp_tool_results
       WHERE owner_key = ${OWNER_A} AND idempotency_key = 'k-old'
    `;
    expect(Number(rows[0].n)).toBe(0);
    // Fresh rows survive.
    expect(await lookupStoredMcpResult(OWNER_A, 'k1')).not.toBeNull();
  });
});
