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
      return effect();
    }
    const name = `blueprint-source-${createHash('sha256').update(physical[index]!).digest('hex')}`;
    return withFsMutex(name, () => enter(index + 1), {
      required: true, timeoutMs: 10_000, retryMs: 20,
    });
  };
  return enter(0);
}
