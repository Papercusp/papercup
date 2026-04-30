/**
 * Per-snapshot in-process lock.
 *
 * Serializes operations that race against the same tarball (Instantiate
 * reads it for tens of seconds; Delete unlinks it; Publish reads it). When
 * two requests target the same snapshot id concurrently, the second waits
 * for the first to finish before proceeding.
 *
 * In-process only — Next.js dev mode runs a single Node worker so this
 * suffices. If the operator ever fans out across workers, replace with a
 * filesystem advisory lock (flock on the tarball) or PG advisory lock.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function withSnapshotLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(id);
  if (prior) {
    // Someone else is operating on this snapshot — wait, ignoring their
    // result/error (that's their caller's problem).
    await prior.catch(() => {});
  }
  const p = (async () => fn())();
  inFlight.set(id, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(id) === p) inFlight.delete(id);
  }
}
