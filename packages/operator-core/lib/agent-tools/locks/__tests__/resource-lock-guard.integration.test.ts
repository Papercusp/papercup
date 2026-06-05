/**
 * resource-lock-guard — the requiresLock enforcement primitive (Phase 8, P-025).
 *
 * guardResource acquires a named resource (drain for exclusive), runs the
 * wrapped body ONLY if acquired, and releases after (+ back-up broadcast for
 * exclusive). It is the "the body can't run without the lock" guarantee that
 * realizes the `enforced` rung — a handler HOF (withResourceLock) rather than
 * a dispatcher interceptor, so the generic tooldef lib stays domain-free
 * (D-016). Live PG; explicit identity so no tool-ctx mock is needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  readResourceQueue,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { _resetListenersForTests } from '../workspace-listener';
import { readInbox } from '../../coordination/messages';
import type { AgentIdentity } from '../../coordination/identity';
import { guardResource } from '../resource-lock-guard';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const uniqueWs = () => `guard-ws-${Date.now()}-${seq++}`;
const mkId = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: `res:${ownerId}`,
  source: 'static-client',
  workspaceId: null,
  userId: null,
});

describe('guardResource (requiresLock enforcement)', async () => {
  const live = await dbLive();

  beforeAll(async () => {
    if (live) await readInbox(`warmup-${Date.now()}`).catch(() => {});
  });

  it.skipIf(!live)('acquires exclusive, runs the body while held, releases after', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    let ran = false;
    let statusDuring: string | undefined;

    const out = await guardResource(
      {
        coordinationDomain: ws,
        ownerId: 'X',
        ownerLabel: 'res:X',
        coordIdentity: mkId('X'),
        resource: 'dev-server',
        mode: 'exclusive',
        maxDrainSec: 5,
      },
      async () => {
        ran = true;
        const q = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
        statusDuring = q.holders.find((h) => h.owner === 'X')?.status;
        return { ok: true, body: 'done' };
      },
    );

    expect(ran).toBe(true);
    expect(statusDuring).toBe('held'); // lock held while the body ran
    expect(out.acquired).toBe(true);
    if (out.acquired) expect(out.result).toEqual({ ok: true, body: 'done' });

    // Released after.
    const q2 = await readResourceQueue(getTxPool(), { coordinationDomain: ws, resource: 'dev-server' });
    expect(q2.holders.some((h) => h.owner === 'X')).toBe(false);
  });

  it.skipIf(!live)('does NOT run the body when another owner holds the exclusive', async () => {
    await ensureBootstrap();
    const ws = uniqueWs();
    await inWorkspaceTxn(ws, 'Y', (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource: 'dev-server',
        mode: 'exclusive',
        owner: 'Y',
        ownerLabel: 'res:Y',
        reason: 'held',
        ttlSec: 60,
      }),
    );

    let ran = false;
    const out = await guardResource(
      {
        coordinationDomain: ws,
        ownerId: 'X',
        ownerLabel: 'res:X',
        coordIdentity: mkId('X'),
        resource: 'dev-server',
        mode: 'exclusive',
        maxDrainSec: 1,
      },
      async () => {
        ran = true;
        return { ok: true };
      },
    );

    expect(ran).toBe(false);
    expect(out.acquired).toBe(false);

    await _resetListenersForTests();
    await _resetForTests();
  });
});
