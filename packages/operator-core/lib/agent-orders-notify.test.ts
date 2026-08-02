/**
 * agent-orders-notify.test.ts — the enforcement half of WI-6974.
 *
 * `resolver-backing-table-coverage.test.ts` lets a declared (query, table) pair opt
 * out of table-driven invalidation via PUSH_EXEMPT + a reason. That reason is PROSE.
 * For the five `agentOrders.byOwner` tables the reason is a factual claim — "the
 * PRODUCER pushes instead" — and the whole point of that guard's own docblock is
 * that *a comment is not a guard*. If the push is deleted, PUSH_EXEMPT keeps the
 * coverage suite green while the Orders panel silently reverts to refresh-on-remount:
 * exactly the `accounts.pool` / WI-6796 failure, now hiding behind an allow-list.
 *
 * So this file makes the exemption's claim checkable, in two layers:
 *
 *   1. BEHAVIOURAL — `setMode` really does push, for the right owner, past both of
 *      its no-op guards. It is the one producer with an injectable `sql` seam, so it
 *      is provable hermetically rather than asserted.
 *   2. STRUCTURAL — every OTHER table declared on `agentOrders.byOwner` has a named
 *      producer module that still calls `notifyAgentOrdersChanged`. The required set
 *      is DERIVED from the resolver's own `backingTables`, so declaring a sixth table
 *      without giving it a producer fails here instead of passing quietly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

vi.mock('./agent-orders-notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-orders-notify')>();
  return { ...actual, notifyAgentOrdersChanged: vi.fn(async () => {}) };
});

import { notifyAgentOrdersChanged, AGENT_ORDERS_QUERY_NAME } from './agent-orders-notify';
import { setMode } from './modes/store';
import { getRegistryEntryV2 } from './sync-resolver';

const pushed = vi.mocked(notifyAgentOrdersChanged);

const HERE = dirname(fileURLToPath(import.meta.url));

interface ModeRowShape {
  workspace_id: string;
  owner_id: string;
  axis_key: string;
  mode: string;
  reason: string;
  set_by: string;
  owner_directed: boolean;
  set_at: string;
}

/** In-memory agent_modes + agent_mode_changes behind a postgres.js-shaped tagged
 *  template — the same seam modes/store.test.ts drives, kept local so this file
 *  proves the push without coupling to that file's internals. */
function mockSql() {
  const modes = new Map<string, ModeRowShape>();
  const key = (ws: string, o: string, a: string) => `${ws}|${o}|${a}`;
  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    if (text.includes('INSERT INTO harness_shared.agent_mode_changes')) return Promise.resolve([]);
    if (text.includes('INSERT INTO harness_shared.agent_modes')) {
      const [ws, owner, axis, mode, reason, setBy, ownerDirected] = vals as string[];
      modes.set(key(ws, owner, axis), {
        workspace_id: ws, owner_id: owner, axis_key: axis, mode, reason, set_by: setBy,
        owner_directed: Boolean(ownerDirected), set_at: '2026-08-02T00:00:00Z',
      });
      return Promise.resolve([]);
    }
    if (text.includes('DELETE FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      modes.delete(key(ws, owner, axis));
      return Promise.resolve([]);
    }
    if (text.includes('SELECT * FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      const row = modes.get(key(ws, owner, axis));
      return Promise.resolve(row ? [row] : []);
    }
    throw new Error(`mockSql: unrecognized query: ${text.slice(0, 80)}`);
  };
  return fn as unknown as Sql;
}

const WS = 'test-ws';
const OWNER = 'su-orders-push';

describe('agentOrders.byOwner — the producer push actually fires (WI-6974)', () => {
  beforeEach(() => pushed.mockClear());

  it('a mode SET pushes, scoped to that owner', async () => {
    const sql = mockSql();
    const r = await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: true, reason: 'test', sql });
    expect(r.ok).toBe(true);
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveBeenCalledWith(OWNER);
  });

  it('a mode CLEAR pushes too — the clear branch is a separate return path', async () => {
    const sql = mockSql();
    await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: true, reason: 'on', sql });
    pushed.mockClear();
    const r = await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: false, reason: 'off', sql });
    expect(r.ok).toBe(true);
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it('a NO-OP re-assert does NOT push — this is the property a table trigger cannot have', async () => {
    // The exact reason these tables are producer-pushed rather than bridged: a row
    // trigger fires on the write, and would push here on every re-assert. If this
    // ever goes green-by-pushing, the panel is back on a timer.
    const sql = mockSql();
    await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: true, reason: 'same', sql });
    pushed.mockClear();
    const again = await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: true, reason: 'same', sql });
    expect(again.noop).toBe(true);
    expect(pushed).not.toHaveBeenCalled();
  });

  it('clearing a mode that is not set does NOT push', async () => {
    const sql = mockSql();
    const r = await setMode({ workspaceId: WS, ownerId: OWNER, setBy: OWNER, modeId: 'auto', enabled: false, reason: 'noop', sql });
    expect(r.noop).toBe(true);
    expect(pushed).not.toHaveBeenCalled();
  });
});

describe('agentOrders.byOwner — every PUSH_EXEMPT table still has a live producer', () => {
  /** table → the module that writes it AND owes the push. */
  const PRODUCERS: Record<string, string> = {
    'harness_shared.session_briefs': 'agent-tools/coordination/control-anchor.ts',
    'harness_shared.plan_item_claims': 'plan-items/claims.ts',
    'harness_shared.carry_notes': 'carry-note.ts',
    'harness_shared.agent_modes': 'modes/store.ts',
    'harness_shared.agent_mode_changes': 'modes/store.ts',
  };

  /** Derived from the resolver, not hardcoded: work_items is bridged through
   *  TABLE_TO_QUERY_NAMES, so every OTHER declared table owes a producer push. */
  const producerOwed = (getRegistryEntryV2(AGENT_ORDERS_QUERY_NAME)?.backingTables ?? []).filter(
    (t) => t !== 'harness_shared.work_items',
  );

  it('sanity: the resolver declares the tables this guard is about', () => {
    // Guards against an empty derived set making every check below vacuous.
    expect(producerOwed.length).toBeGreaterThanOrEqual(5);
  });

  it('every declared non-bridged table names a producer module', () => {
    const unmapped = producerOwed.filter((t) => !PRODUCERS[t]).sort();
    expect(
      unmapped,
      `agentOrders.byOwner declares backing table(s) with neither a table-to-query-names entry nor a ` +
        `named producer. Either wire the table, or add its producer module here AND a PUSH_EXEMPT ` +
        `reason in resolver-backing-table-coverage.test.ts: [${unmapped.join(', ')}]`,
    ).toEqual([]);
  });

  it('each producer module still calls notifyAgentOrdersChanged', () => {
    const silent: string[] = [];
    for (const table of producerOwed) {
      const rel = PRODUCERS[table];
      if (!rel) continue;
      const src = readFileSync(resolve(HERE, rel), 'utf8');
      if (!src.includes('notifyAgentOrdersChanged(')) silent.push(`${table} (${rel})`);
    }
    expect(
      silent,
      `Producer module(s) no longer push agentOrders.byOwner. Their PUSH_EXEMPT entry in ` +
        `resolver-backing-table-coverage.test.ts claims they do, so the coverage suite stays GREEN ` +
        `while the Orders panel silently reverts to refresh-on-remount — the WI-6796 failure hiding ` +
        `behind an allow-list. Restore the push, or wire the table and drop the exemption: ` +
        `[${silent.join(', ')}]`,
    ).toEqual([]);
  });

  it('the heartbeat writers stay silent — the push must never ride a liveness renewal', () => {
    // renewOwnerActivityClaims / heartbeatClaimLocal / extendOwnerClaimsForAwait rewrite
    // last_activity_ts on every turn. Pushing from any of them re-creates, in producer
    // code, exactly the timer-driven refresh that kept these tables off the bridge.
    const claims = readFileSync(resolve(HERE, 'plan-items/claims.ts'), 'utf8');
    for (const fn of ['renewOwnerActivityClaims', 'heartbeatClaimLocal', 'extendOwnerClaimsForAwait']) {
      const start = claims.indexOf(`export async function ${fn}`);
      expect(start, `${fn} not found — this guard has drifted from claims.ts`).toBeGreaterThan(-1);
      const next = claims.indexOf('\nexport ', start + 1);
      const body = claims.slice(start, next === -1 ? undefined : next);
      expect(
        body.includes('notifyAgentOrdersChanged('),
        `${fn} is a LIVENESS heartbeat (it rewrites last_activity_ts every turn) and must not push ` +
          `agentOrders.byOwner — that would push every open Orders panel on a timer, which is the ` +
          `defect WI-6974 kept plan_item_claims off the table bridge to avoid.`,
      ).toBe(false);
    }
  });
});
