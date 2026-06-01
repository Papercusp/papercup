/**
 * peer-log.test.ts — unit tests for the per-peer single-writer log module
 * (Model B substrate, Stage 1).
 *
 * Pure over an injected Corestore so it runs without the network:
 *  - own writable log: append + ordered read + 64-hex key shape;
 *  - a second store reads the first log read-only by key after update()
 *    (Stage-0 finding: store.replicate(bool) piped both ways replicates).
 *
 * Real replication wiring is Stage 4; here we exercise the handle + update().
 */

import { describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, openRemoteLog, type PeerLogOp } from './peer-log';

describe('peer-log', () => {
  it('own log appends + reads ops in order, exposes a 64-hex key', async () => {
    const store = new Corestore(mkdtempSync(join(tmpdir(), 'mb-own-')));
    await store.ready();
    const log = await openOwnLog(store);
    const op: PeerLogOp = { type: 'put', table: 'features_consolidated', hbKey: 'F-1', value: { id: 'F-1' }, ts: 100, schema_version: 1, author_pubkey: 'devkeyA' };
    await log.append(op);
    expect(log.length).toBe(1);
    expect(await log.get(0)).toMatchObject({ hbKey: 'F-1', ts: 100, author_pubkey: 'devkeyA' });
    expect(log.keyHex).toMatch(/^[0-9a-f]{64}$/);
    await store.close();
  });

  it('a second store reads the first log by key after update()', async () => {
    const s1 = new Corestore(mkdtempSync(join(tmpdir(), 'mb-w-'))); await s1.ready();
    const s2 = new Corestore(mkdtempSync(join(tmpdir(), 'mb-r-'))); await s2.ready();
    const own = await openOwnLog(s1);
    await own.append({ type: 'put', table: 'features_consolidated', hbKey: 'R-1', value: {}, ts: 10, schema_version: 1, author_pubkey: 'A' });
    // replicate the two stores (mirror Stage-0 finding: store.replicate(bool) → pipe both ways)
    // .replicate() is typed loosely upstream; it returns a duplex stream.
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);
    const remote = await openRemoteLog(s2, own.keyHex);
    await remote.update();
    expect(remote.length).toBe(1);
    expect(await remote.get(0)).toMatchObject({ hbKey: 'R-1' });
    await s1.close(); await s2.close();
  });
});
