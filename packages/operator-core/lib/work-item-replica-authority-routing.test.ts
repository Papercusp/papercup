/**
 * work-item-replica-authority-routing.test.ts — the replica-authority ROUTING SEAM
 * (EI-266; C5 of BRIEF-test-coverage gaps).
 *
 * Every redundancy store op funnels through `getWorkItemReplicaAuthority().route(scopeKey, op)`
 * (work-item-replica-authority.ts:48). All the *redundancy* integration tests run with the
 * default `LocalWorkItemReplicaAuthority` (which just runs `op.local()`), so the ROUTER
 * itself — that `setWorkItemReplicaAuthority(...)` actually installs a custom authority,
 * that the store hands it the right `(scopeKey, op)`, and that `resetWorkItemReplicaAuthority()`
 * restores the local one — is untested. This locks that seam WITHOUT touching PG: the
 * recording authority intercepts route() and answers from a CANNED value (never calling
 * op.local()), so the wiring is asserted without a database — the *Local SQL is covered by
 * work-item-redundancy.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityOp } from './authority';
import type { WorkItemReplicaAuthority } from './work-item-replica-authority';

vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const redundancy = await import('./work-item-redundancy');
const {
  getWorkItemReplicaAuthority,
  setWorkItemReplicaAuthority,
  resetWorkItemReplicaAuthority,
  LocalWorkItemReplicaAuthority,
} = await import('./work-item-replica-authority');

/**
 * A recording authority that captures every route(scopeKey, op) call and answers from a
 * CANNED value — it deliberately does NOT call op.local(), so no *Local store fn (and hence
 * no PG) is reached. The point under test is the routing wiring, not the local execution.
 */
interface RouteCall {
  scopeKey: string;
  remoteKind: string | undefined;
}
function recordingAuthority() {
  const calls: RouteCall[] = [];
  const routeSpy = vi.fn();
  // Typed as the real interface so the generic route() signature is honored (vi.fn alone
  // erases the <T> generic and won't satisfy WorkItemReplicaAuthority).
  const authority: WorkItemReplicaAuthority = {
    isSelf: async () => false, // a "remote authority" — would RPC, so op.local() is never run here
    route: async <T>(scopeKey: string, op: AuthorityOp<T>): Promise<T> => {
      routeSpy(scopeKey, op);
      calls.push({ scopeKey, remoteKind: op.remote?.kind });
      return { ok: true, routed: true } as unknown as T; // canned — no op.local(), no DB
    },
  };
  return { authority, calls, routeSpy };
}

const WS = 'default';
const HARNESS = 'h1';

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkItemReplicaAuthority();
});
afterEach(() => resetWorkItemReplicaAuthority());

describe('replica-authority routing seam (EI-266) — install / route / reset', () => {
  it('default authority is the LOCAL one (isSelf always true)', async () => {
    expect(getWorkItemReplicaAuthority()).toBeInstanceOf(LocalWorkItemReplicaAuthority);
    expect(await getWorkItemReplicaAuthority().isSelf('any-hive')).toBe(true);
  });

  it('setWorkItemReplicaAuthority installs the router; a claim op routes THROUGH it with the hive scope', async () => {
    const { authority, calls, routeSpy } = recordingAuthority();
    setWorkItemReplicaAuthority(authority);
    expect(getWorkItemReplicaAuthority()).toBe(authority);

    const res = await redundancy.claimReplicaSlot({
      workspaceId: WS, harnessSlug: HARNESS, workItemId: 'WI-1', owner: 'su-a', hiveSlug: 'hive-x',
    });
    // The op was routed through the installed authority (not run locally).
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, routed: true });

    // Scope key = the Hive home (the per-Hive authority), and the op carries the claim-slot kind.
    expect(calls[0].scopeKey).toBe('hive-x');
    expect(calls[0].remoteKind).toBe(redundancy.WORK_ITEM_REPLICA_OP_KINDS.claimSlot);
  });

  it('without a hiveSlug the scope key FALLS BACK to the harness slug (single-box correct)', async () => {
    const { authority, calls } = recordingAuthority();
    setWorkItemReplicaAuthority(authority);
    await redundancy.claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'WI-2', owner: 'su-a' });
    expect(calls[0].scopeKey).toBe(HARNESS);
  });

  it('every replica op kind routes through the installed authority with the matching op kind', async () => {
    const { authority, calls, routeSpy } = recordingAuthority();
    setWorkItemReplicaAuthority(authority);
    const scope = { workspaceId: WS, harnessSlug: HARNESS, workItemId: 'WI-3', hiveSlug: 'hive-y' };

    await redundancy.claimReplicaSlot({ ...scope, owner: 'su-a' });
    await redundancy.heartbeatReplica({ ...scope, replicaIndex: 0, claimId: '00000000-0000-0000-0000-000000000000', owner: 'su-a' });
    await redundancy.recordReplicaResult({ ...scope, replicaIndex: 0, owner: 'su-a', result: { text: 'r' } });
    await redundancy.releaseReplica({ ...scope, replicaIndex: 0, claimId: '00000000-0000-0000-0000-000000000000', owner: 'su-a' });
    await redundancy.listReplicas('WI-3', { harness: HARNESS, workspaceId: WS, hiveSlug: 'hive-y' });
    await redundancy.judgeRedundancyGroup(
      { workspaceId: WS, harness: HARNESS, workItemId: 'WI-3', hiveSlug: 'hive-y' },
      { llmCall: (async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as never },
    );

    const K = redundancy.WORK_ITEM_REPLICA_OP_KINDS;
    expect(routeSpy).toHaveBeenCalledTimes(6);
    expect(calls.map((c) => c.remoteKind)).toEqual([
      K.claimSlot, K.heartbeat, K.recordResult, K.release, K.list, K.judge,
    ]);
    // All scope to the same Hive authority.
    expect(new Set(calls.map((c) => c.scopeKey))).toEqual(new Set(['hive-y']));
  });

  it('resetWorkItemReplicaAuthority restores the LOCAL authority (an installed router no longer sees ops)', async () => {
    const { authority, routeSpy } = recordingAuthority();
    setWorkItemReplicaAuthority(authority);
    resetWorkItemReplicaAuthority();
    expect(getWorkItemReplicaAuthority()).toBeInstanceOf(LocalWorkItemReplicaAuthority);

    // A post-reset list op runs locally — it never touches the (uninstalled) recording authority.
    // We assert ONLY that the recording authority is bypassed (the local read would need PG, so
    // we don't await its result here — the routing seam, not the SQL, is the unit under test).
    void redundancy.listReplicas('WI-4', { harness: HARNESS, workspaceId: WS }).catch(() => {});
    expect(routeSpy).not.toHaveBeenCalled();
  });
});
