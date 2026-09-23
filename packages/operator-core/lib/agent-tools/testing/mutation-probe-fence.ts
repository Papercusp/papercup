/** Read the active file-lock lease that marks an in-tree mutation window. */
import { realpath } from 'node:fs/promises';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';

/**
 * Return active mutation-probe paths for one physical checkout. The lock is a
 * checkout-wide test fence: a test may import the locked source indirectly, so
 * checking only the requested test-file paths would miss the relevant module.
 */
export async function activeMutationProbePaths(checkoutRoot: string): Promise<string[]> {
  const coordinationDomain = await realpath(checkoutRoot);
  await ensureBootstrap();
  const queue = await readQueue(getTxPool(), { coordinationDomain });
  return queue.active_locks
    .filter((lock) => String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe')
    .map((lock) => lock.path)
    .sort();
}
