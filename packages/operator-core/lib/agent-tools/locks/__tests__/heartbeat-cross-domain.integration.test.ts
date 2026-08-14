/**
 * locks:heartbeat CROSS-DOMAIN integration tests (EI-20413003247462580).
 *
 * Drives the REAL `locks:heartbeat` handler against live PG. Only the ambient
 * identity seam is mocked — `readFileLockIdentity` normally reports the
 * operator process's own repo root, which a test cannot vary. Everything the
 * fix actually depends on (the store, the domain resolution, the retry) runs
 * for real, because the bug being fixed is a RUNTIME behaviour that reads
 * correct in source: `tryHeartbeat` pins `coordination_domain = $1`, so a lock
 * held in another domain simply does not match and returns extended:false —
 * indistinguishable from expired/stolen/not-yours.
 *
 * The concrete failure: a PreToolUse hook acquires a lock in a HIVE tree's
 * domain, the agent calls bare `locks:heartbeat` from the canonical tree, gets
 * `not_found_or_not_yours_or_expired`, and its lock silently expires mid-edit.
 *
 * Run: npx vitest run lib/agent-tools/locks/__tests__/heartbeat-cross-domain.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so the mutable identity the
// tests steer has to be hoisted with them.
const ident = vi.hoisted(() => ({ ownerId: '', callerDomain: '' }));

vi.mock('../identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../identity')>()),
  readFileLockIdentity: () => ({
    ownerId: ident.ownerId,
    ownerLabel: 'heartbeat-cross-domain-suite',
    coordinationDomain: ident.callerDomain,
  }),
}));

import { ensureBootstrap, getTxPool, tryAcquire, tryHeartbeat, _resetForTests } from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';

const tool = (await import('../heartbeat')).default;

const SUITE_PREFIX = `vitest-hb-xdomain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let idx = 0;
const nextDomain = (): string => `${SUITE_PREFIX}-${++idx}`;

type Out = { data?: unknown; content?: { text: string }[] };
type HeartbeatRow = {
  ok: boolean;
  lock_id: string;
  extended: boolean;
  expires_ts: string | null;
  coordination_domain: string;
  cross_domain_extended?: { requested: string; actual: string };
  error?: string;
  searched_coordination_domains?: string[];
};
type HeartbeatBody = { ok: boolean; counts: { ok: number; failed: number }; results: HeartbeatRow[] };

const callHeartbeat = async (args: Record<string, unknown>): Promise<HeartbeatBody> => {
  const out = (await tool.handler(args as never, {} as never)) as Out;
  return (out.data ?? JSON.parse(out.content![0]!.text)) as HeartbeatBody;
};

/** Acquire a lock directly in `domain` for `owner`, bypassing the tool. */
async function acquireIn(domain: string, owner: string, path: string): Promise<string> {
  const res = await inWorkspaceTxn(domain, owner, async (tx) =>
    tryAcquire(tx, {
      coordinationDomain: domain,
      owner,
      ownerLabel: 'heartbeat-cross-domain-suite',
      paths: [path],
      intent: 'EI-20413003247462580 cross-domain heartbeat suite',
      ttlSec: 600,
    }),
  );
  if (!res.ok) throw new Error(`fixture acquire failed in ${domain}: ${JSON.stringify(res.busy)}`);
  return res.lock_id;
}

beforeAll(async () => {
  await ensureBootstrap();
});

afterAll(async () => {
  const sql = getTxPool();
  try {
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
  } catch {
    /* db may have been torn down; ignore */
  }
  await _resetForTests();
});

describe('locks:heartbeat across coordination domains (EI-20413003247462580)', () => {
  /**
   * PERMANENT CONTROL. This pins the CAUSE the fix routes around, at the store
   * layer, so the suite cannot silently start passing for the wrong reason. If
   * someone "fixes" this by making tryHeartbeat domain-agnostic, this test
   * fails and forces that decision to be made deliberately — a lock's domain
   * is a real scoping boundary, not an accident.
   */
  it('CONTROL: the store cannot extend a lock from another domain', async () => {
    const owner = `${SUITE_PREFIX}-control-owner`;
    const held = nextDomain();
    const elsewhere = nextDomain();
    const lockId = await acquireIn(held, owner, 'control.ts');

    const wrongDomain = await inWorkspaceTxn(elsewhere, owner, async (tx) =>
      tryHeartbeat(tx, elsewhere, owner, lockId, 900),
    );
    expect(wrongDomain.extended).toBe(false);

    // ...and the SAME call in the right domain succeeds, so the control is
    // isolating the domain and nothing else (a lock that was simply expired
    // would fail both ways and prove nothing).
    const rightDomain = await inWorkspaceTxn(held, owner, async (tx) =>
      tryHeartbeat(tx, held, owner, lockId, 900),
    );
    expect(rightDomain.extended).toBe(true);
  });

  it('extends a lock held in ANOTHER domain, and says it crossed', async () => {
    const owner = `${SUITE_PREFIX}-cross-owner`;
    const held = nextDomain();
    const caller = nextDomain();
    const lockId = await acquireIn(held, owner, 'crossed.ts');

    ident.ownerId = owner;
    ident.callerDomain = caller;

    const body = await callHeartbeat({ lock_id: lockId, ttl_sec: 900 });
    const row = body.results[0]!;

    expect(row.extended).toBe(true);
    expect(row.ok).toBe(true);
    // Reported against the domain the lock ACTUALLY lives in, not the one asked.
    expect(row.coordination_domain).toBe(held);
    expect(row.cross_domain_extended).toEqual({ requested: caller, actual: held });

    // The TTL really moved in the holding domain — not just a cheerful payload.
    const rows = await getTxPool()<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${held} AND lock_id = ${lockId}::uuid
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Date(row.expires_ts!).getTime()).toBe(rows[0]!.expires_ts.getTime());
  });

  it('same-domain heartbeat still works and reports NO crossing', async () => {
    const owner = `${SUITE_PREFIX}-same-owner`;
    const domain = nextDomain();
    const lockId = await acquireIn(domain, owner, 'same.ts');

    ident.ownerId = owner;
    ident.callerDomain = domain;

    const row = (await callHeartbeat({ lock_id: lockId, ttl_sec: 900 })).results[0]!;
    expect(row.extended).toBe(true);
    expect(row.coordination_domain).toBe(domain);
    expect(row.cross_domain_extended).toBeUndefined();
  });

  /**
   * The security property the cross-domain retry must not break. Reaching into
   * other domains by lock_id would be a privilege escalation if the owner check
   * did not travel with it: any agent holding a leaked lock_id could keep a
   * PEER's lock alive indefinitely. tryHeartbeat's `owner = $` predicate and
   * domainsHoldingLocks' owner filter both have to hold for this to pass.
   */
  it('SECURITY: never extends a PEER lock, even when it can see the domain', async () => {
    const peer = `${SUITE_PREFIX}-peer`;
    const me = `${SUITE_PREFIX}-not-peer`;
    const peerDomain = nextDomain();
    const caller = nextDomain();
    const peerLock = await acquireIn(peerDomain, peer, 'peer-owned.ts');
    // I hold something of my own elsewhere, so the domain scan has rows to walk
    // and the refusal cannot be an artifact of my holding nothing at all.
    await acquireIn(caller, me, 'mine.ts');

    const before = await getTxPool()<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${peerDomain} AND lock_id = ${peerLock}::uuid
    `;

    ident.ownerId = me;
    ident.callerDomain = caller;

    const row = (await callHeartbeat({ lock_id: peerLock, ttl_sec: 900 })).results[0]!;
    expect(row.extended).toBe(false);
    expect(row.error).toBe('not_found_or_not_yours_or_expired');

    const after = await getTxPool()<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${peerDomain} AND lock_id = ${peerLock}::uuid
    `;
    expect(after[0]!.expires_ts.getTime()).toBe(before[0]!.expires_ts.getTime());
  });

  it('a genuinely absent lock reports the error AND names the domains searched', async () => {
    const owner = `${SUITE_PREFIX}-absent-owner`;
    const caller = nextDomain();
    const other = nextDomain();
    await acquireIn(other, owner, 'somewhere-else.ts');

    ident.ownerId = owner;
    ident.callerDomain = caller;

    const row = (await callHeartbeat({ lock_id: '11111111-2222-3333-4444-555555555555' })).results[0]!;
    expect(row.extended).toBe(false);
    expect(row.error).toBe('not_found_or_not_yours_or_expired');
    // The legacy message named three causes and omitted the fourth (wrong
    // domain). Reporting where we looked is what lets a caller tell "my lock
    // is elsewhere" from "my lock is gone".
    expect(row.searched_coordination_domains).toContain(caller);
  });
});
