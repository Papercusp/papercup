import { randomUUID } from 'node:crypto';
import { guardResource } from '@papercusp/operator-core/lib/agent-tools/locks/resource-lock-guard';
import { resourceLockDomain } from '@papercusp/operator-core/lib/agent-tools/locks/coordination-domain';

const ownerId = `cloud-portal-reconcile:${process.pid}:${randomUUID()}`;

/** Serialize unattended cutovers with the same registered lock manual deployers use. */
export async function withPortalHandoffLock<T>(handoff: () => Promise<T>): Promise<T> {
  const outcome = await guardResource({
    coordinationDomain: resourceLockDomain('cloud-portal'),
    ownerId,
    ownerLabel: 'cloud-portal-reconcile',
    coordIdentity: {
      ownerId,
      ownerLabel: 'cloud-portal-reconcile',
      source: 'static-client',
      workspaceId: 'papercusp-workspace',
      userId: null,
    },
    resource: 'cloud-portal',
    mode: 'exclusive',
    maxDrainSec: 0,
    ttlSec: 600,
    reason: 'Health-checked automatic Cloud Portal handoff',
    hostLocalOwnerPid: (holder) => {
      const match = /^cloud-portal-reconcile:(\d+):[\w-]+$/.exec(holder);
      return match ? Number(match[1]) : null;
    },
  }, async (fence) => {
    const current = await fence.assertCurrent();
    if (!current.current) throw new Error('portal_handoff_lock_lost');
    return handoff();
  });
  if (!outcome.acquired) throw new Error(`portal_handoff_lock_unavailable:${outcome.reason}`);
  return outcome.result;
}
