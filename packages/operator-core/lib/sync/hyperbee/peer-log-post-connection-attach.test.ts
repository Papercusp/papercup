/**
 * WI-5673 — DEPENDENCY INVARIANT: a peer core opened AFTER the replication
 * stream is already established still attaches to that stream on its own.
 *
 * This is load-bearing for the production admission path: boot.ts admits a
 * peer log (openRemoteLog → getCore + core.ready(), issuing NO get/download/
 * update) long after `store.replicate(socket)` ran for that connection. If a
 * post-connection open did NOT attach, every such log would sit permanently at
 * peersCount 0 — the `connected_never_replicated [never_attached]` symptom.
 *
 * WHY THIS TEST EXISTS (it guards an assumption, not our code): the attach is
 * driven by hypercore's ACTIVE SESSION COUNT, not by download requests —
 * hypercore/index.js `_open` calls `replicator.updateActivity(_active ? 1 : 0)`
 * on session open, which flips `downloading` false→true, which fires
 * corestore's `core.replicator.ondownloading` → `streamTracker.attachAll(core)`.
 * That chain is entirely INTERNAL to corestore/hypercore, so a dependency bump
 * could remove it silently and our admission path would stall with no local
 * diff to blame. An investigation already burned real time on the inverted
 * theory ("openRemoteLog never makes the replicator downloading, so admission
 * never attaches") and nearly shipped a no-op fix forcing the transition by
 * hand; this test is the cheap, permanent refutation of that theory.
 *
 * If this test ever goes red after a corestore/hypercore upgrade, the fix IS
 * to force the downloading transition at admission (a no-op download/update
 * after core.ready() in openRemoteLog) — but do NOT add that while this is
 * green, because it buys nothing.
 */
import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, openRemoteLog } from './peer-log';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

/** Poll `fn` until truthy or `timeoutMs` elapses (attach is async, not sync-at-open). */
async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

describe('peer-log post-connection attach (WI-5673)', () => {
  it('a remote log opened AFTER replicate() attaches with no download/update issued', async () => {
    const s1 = makeStore('pca-w-');
    await s1.ready();
    const s2 = makeStore('pca-r-');
    await s2.ready();

    const own = await openOwnLog(s1);
    await own.append({
      type: 'put',
      table: 'features_consolidated',
      hbKey: 'R-1',
      value: {},
      ts: 10,
      schema_version: 1,
      author_pubkey: 'A',
    });

    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);

    // Let the handshake settle so the stream is genuinely ESTABLISHED before
    // the core is opened — this is the production ordering (connection first,
    // log admitted later), and it is the ordering the falsified theory claimed
    // could never attach.
    await waitFor(() => false, 250);

    const remote = await openRemoteLog(s2, own.keyHex);

    // The invariant: attaching requires NO explicit download and NO update() —
    // opening the session is sufficient. It is ASYNC (peersCount is still 0 in
    // the same tick as the open), hence the poll rather than an immediate read.
    const attached = await waitFor(() => (remote.peersCount() ?? 0) > 0);
    expect(attached).toBe(true);
    expect(remote.peersCount()).toBeGreaterThan(0);

    // And the attach is real: content flows over it.
    await remote.update();
    expect(remote.length).toBe(1);
    expect(await remote.get(0)).toMatchObject({ hbKey: 'R-1' });
  }, 30_000);
});
