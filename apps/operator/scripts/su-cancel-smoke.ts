import { getTxPool, tryCancelWait, _resetForTests } from '../lib/agent-tools/locks/su-lock-store.ts';
import { inWorkspaceTxn } from '../lib/agent-tools/locks/in-workspace-txn.ts';
async function main() {
  const sql = getTxPool();
  const ws = 'cancel-test-ws-' + Date.now();
  const owner = 'cancel-agent';
  const inserted = await sql<Array<{ ticket_id: string }>>`
    INSERT INTO agent_lock_waiters (workspace_id, owner, owner_label, paths, intent, ttl_sec, wait_until)
    VALUES (${ws}, ${owner}, ${'cancel-label'}, ${['libs/foo.ts']}, ${'test'}, ${600}, ${new Date(Date.now()+60000)})
    RETURNING ticket_id
  `;
  const ticketId = inserted[0].ticket_id;
  console.log('inserted ticket:', ticketId);
  const r = await inWorkspaceTxn(ws, owner, (tx) => tryCancelWait(tx, ticketId, owner));
  console.log('cancel result:', JSON.stringify(r));
  if (!r.cancelled) { console.error('FAIL'); process.exit(1); }
  const r2 = await inWorkspaceTxn(ws, owner, (tx) => tryCancelWait(tx, ticketId, owner));
  console.log('second cancel (already cancelled):', JSON.stringify(r2));
  if (r2.cancelled) { console.error('FAIL - expected false on second call'); process.exit(1); }
  console.log('[OK] cancel_wait correct');
  await _resetForTests();
}
main().catch((e) => { console.error('CRASH:', e); process.exit(2); });
