import {
  ensureBootstrap, getTxPool, normalizePaths,
  tryAcquire, tryRelease, tryHeartbeat,
  readQueue, _resetForTests,
} from '../lib/agent-tools/locks/su-lock-store.ts';
import { inWorkspaceTxn } from '../lib/agent-tools/locks/in-workspace-txn.ts';

async function main() {
  console.log('1. ensureBootstrap...');
  await ensureBootstrap();
  console.log('   OK');

  const ws = 'smoke-test-ws-' + Date.now();
  const owner = 'smoke-agent-a';

  console.log('2. acquire 3 paths...');
  const r1 = await inWorkspaceTxn(ws, owner, (tx) => tryAcquire(tx, {
    coordinationDomain: ws, owner, ownerLabel: 'smoke:a',
    paths: normalizePaths(['libs/foo.ts', 'libs/bar.ts', 'apps/baz.ts']),
    intent: 'smoke test acquire', ttlSec: 60,
  }));
  console.log('   result:', JSON.stringify(r1));
  if (!r1.ok) { console.error('FAIL'); process.exit(1); }

  const sql = getTxPool();
  console.log('3. read queue...');
  const q1 = await readQueue(sql, { coordinationDomain: ws });
  console.log('   active:', q1.active_locks.length, 'waiting:', q1.waiting.length);
  if (q1.active_locks.length !== 3) { console.error('FAIL'); process.exit(1); }

  console.log('4. concurrent acquire (overlapping paths, different owner) — should be busy...');
  const r2 = await inWorkspaceTxn(ws, 'smoke-agent-b', (tx) => tryAcquire(tx, {
    coordinationDomain: ws, owner: 'smoke-agent-b', ownerLabel: 'smoke:b',
    paths: normalizePaths(['libs/foo.ts', 'libs/qux.ts']),
    intent: 'smoke test conflict', ttlSec: 60,
  }));
  console.log('   result:', JSON.stringify(r2));
  if (r2.ok) { console.error('FAIL'); process.exit(1); }

  console.log('5. heartbeat the original...');
  const h = await inWorkspaceTxn(ws, owner, (tx) => tryHeartbeat(tx, ws, owner, r1.lock_id, 120));
  console.log('   result:', JSON.stringify(h));
  if (!h.extended) { console.error('FAIL'); process.exit(1); }

  console.log('6. release the original...');
  const rel = await inWorkspaceTxn(ws, owner, (tx) => tryRelease(tx, {
    coordinationDomain: ws, owner, lockId: r1.lock_id,
  }));
  console.log('   released:', rel.released.length, 'paths');
  if (rel.released.length !== 3) { console.error('FAIL'); process.exit(1); }

  console.log('7. final queue (should be empty)...');
  const q2 = await readQueue(sql, { coordinationDomain: ws });
  console.log('   active:', q2.active_locks.length, 'waiting:', q2.waiting.length);
  if (q2.active_locks.length !== 0) { console.error('FAIL'); process.exit(1); }

  console.log('8. path validation...');
  try { normalizePaths(['/abs/path']); console.error('FAIL'); process.exit(1); }
  catch (e: any) { console.log('   rejected /abs/path:', e.message); }
  try { normalizePaths(['../etc/passwd']); console.error('FAIL'); process.exit(1); }
  catch (e: any) { console.log('   rejected ../etc/passwd:', e.message); }

  console.log('\n[OK] ALL SMOKE CHECKS PASSED');
  await _resetForTests();
}

main().catch((e) => { console.error('CRASH:', e); process.exit(2); });
