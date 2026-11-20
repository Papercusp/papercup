/** Shared filesystem boundary for blueprint source writers, including bootstrap
 * before PG exists. Reuses the required host filesystem mutex; this is not a
 * permission grant or protection against an unconfined OS writer. */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { physicalPath } from '../agent-tools/locks/external-path';

export async function withBlueprintSourceMutation<T>(roots: readonly string[], effect: () => Promise<T>): Promise<T> {
  if (!roots.length || roots.some(root => !root || !isAbsolute(root) || root.includes('\0')))
    throw new Error('blueprint source mutation requires absolute library roots');
  const pinned = roots.map(root => ({ root, physical: physicalPath(root) }));
  const physical = [...new Set(pinned.map(root => root.physical))].sort();
  const enter = async (index: number): Promise<T> => {
    if (index === physical.length) {
      // A queued alias can be retargeted while another writer holds the lease.
      if (pinned.some(root => physicalPath(root.root) !== root.physical))
        throw new Error('blueprint source root changed while awaiting mutation custody');
      // notify-classification: {"id":"packages/operator-core/lib/blueprint/source-lock.ts#<module>/withBlueprintSourceMutation/enter:e1d81736545ad410136c:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      return effect();
    }
    const name = `blueprint-source-${createHash('sha256').update(physical[index]!).digest('hex')}`;
    // notify-classification: {"id":"packages/operator-core/lib/blueprint/source-lock.ts#<module>/withBlueprintSourceMutation/enter:a4063a634d667431c2b2:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    // notify-classification: {"id":"packages/operator-core/lib/blueprint/source-lock.ts#<module>/withBlueprintSourceMutation/enter/<callback>:661bf2ec742a03798686:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    return withFsMutex(name, () => enter(index + 1), {
      required: true, timeoutMs: 10_000, retryMs: 20,
    });
  };
  // notify-classification: {"id":"packages/operator-core/lib/blueprint/source-lock.ts#<module>/withBlueprintSourceMutation:4e373ef6a905de9a0db3:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
  return enter(0);
}
