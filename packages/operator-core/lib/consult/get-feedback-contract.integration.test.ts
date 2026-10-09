/** Public request schema and recovery remedies against the real consult store.
 * Reuses the registered tool, acceptance core, real migration, and shared PG
 * fixture. This is tree integration evidence; serving-runtime proof is separate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { lookupByMcpName } from '@papercusp/tooldef';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import tool from '../agent-tools/consult/get-feedback';
import { acceptFeedbackRequestCore, type GetFeedbackDeps, type GetFeedbackRequest } from './get-feedback-core';

const WS = 'public-consult-contract';
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('consult-contract');
  await db.sql.unsafe(`CREATE TABLE harness_shared.coord_conversations (
    workspace_id text NOT NULL, id text NOT NULL, kind text NOT NULL,
    PRIMARY KEY (workspace_id, id)
  )`);
  await applyMigrationForTest(db.sql, fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url,
  )));
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

const deps: Pick<GetFeedbackDeps, 'getSql' | 'open'> = {
  getSql: () => db.sql,
  open: async (input) => {
    if (!input.id) throw new Error('Durable acceptance must supply its identity');
    await db.sql`INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind)
      VALUES (${WS}, ${input.id}, ${input.kind}) ON CONFLICT DO NOTHING`;
    return { conversation_id: input.id, thread_id: `thread-${input.id}`, delivered: 0 };
  },
};

function request(requestKey: string, question = 'Recover this accepted consult'): GetFeedbackRequest {
  const args = tool.args.parse({ request_key: requestKey, question, allow_dispatch: false });
  return { workspaceId: WS, requesterId: 'contract-requester', requestKey: args.request_key,
    question: args.question, allowDispatch: args.allow_dispatch };
}

describe('registered consult contract and persisted recovery', () => {
  it('projects the same bounded retry field and recovery guidance that the store accepts', async () => {
    const projected = lookupByMcpName('consult:get_feedback');
    expect(projected).toBeDefined();
    const schema = projected!.inputSchema as {
      properties: { request_key: { minLength: number; maxLength: number } };
    };
    expect(schema.properties.request_key).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(projected!.description).toContain('conversations:get');
    expect(projected!.description).toContain('request_key');
    const input = request('x'.repeat(200));
    const accepted = await acceptFeedbackRequestCore(input, deps);
    const retry = await acceptFeedbackRequestCore(request(input.requestKey!), deps);
    expect(accepted).toMatchObject({ verdict: 'accepted', state: 'routing', pending: true });
    expect(retry.conversation_id).toBe(accepted.conversation_id);
    const rows = await db.sql`SELECT conversation_id, routing FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].routing.request.payload.requestKey).toBe(input.requestKey);
    expect(rows[0].routing.deliveryIntent).toBe('retrieval-only');
  });

  it('rejects invalid public retry fields before inserting a consult', async () => {
    const before = await db.sql`SELECT count(*)::int AS n FROM harness_shared.consult_state`;
    for (const key of ['', '   ', 'x'.repeat(201)]) {
      expect(() => request(key)).toThrow();
    }
    const after = await db.sql`SELECT count(*)::int AS n FROM harness_shared.consult_state`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('the persisted key-conflict remedy recovers the original payload or accepts a fresh key', async () => {
    const original = request('remedy-original');
    const accepted = await acceptFeedbackRequestCore(original, deps);
    const conflicting = await acceptFeedbackRequestCore(request('remedy-original', 'Changed question'), deps);
    expect(conflicting).toMatchObject({ error: 'request_key_conflict', conversation_id: accepted.conversation_id });
    expect(conflicting.hint).toContain('Reuse its original payload for recovery');
    expect(conflicting.hint).toContain('use a new key for a fresh consult');
    const recovered = await acceptFeedbackRequestCore(original, deps);
    const fresh = await acceptFeedbackRequestCore(request('remedy-fresh', 'Changed question'), deps);
    expect(recovered.conversation_id).toBe(accepted.conversation_id);
    expect(fresh).toMatchObject({ verdict: 'accepted', pending: true });
    expect(fresh.conversation_id).not.toBe(accepted.conversation_id);
    const rows = await db.sql`SELECT question FROM harness_shared.consult_state
      WHERE workspace_id = ${WS} AND conversation_id = ${accepted.conversation_id}`;
    expect(rows[0].question).toBe(original.question);
  });
});
