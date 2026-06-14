/**
 * child-driver.test.ts — `spawnProcMesh` must signal a mesh-formation failure
 * with the TYPED `MeshFormationError` (carrying the failed peer index), not a
 * plain `Error` (EI-115 regression).
 *
 * EI-115 was a weekly Tier-2 netem run crashing fatal with
 *   `Error: proc mesh: reader 1 never admitted the writer`
 * — a PLAIN Error from `spawnProcMesh` that propagated to netem-inner's fatal
 * handler. The EI-116 + audit-P-022 fix makes the failure typed so
 * `resolveNetemFailure` can fold it into a recorded did-not-form cell instead of
 * crashing the sweep. If a future edit regressed the throw back to a plain
 * `Error`, that did-not-form machinery would silently break and the fatal would
 * return — these tests lock the contract.
 *
 * The `spawnChild` test seam drives the formation OUTCOME without spawning real
 * OS processes (no testnet: an explicit non-empty `bootstrap`; no tmp dirs: an
 * explicit `roots`).
 */

import { describe, expect, it } from 'vitest';
import { spawnProcMesh, type PeerChildHandle } from './child-driver';
import { MeshFormationError } from './mesh-outcome';
import type { PeerChildConfig } from './peer-child';

/** A fake peer child whose `waitFor(evt)` resolves an event (success) or null
 *  (that event never fires → a formation failure). `writerReady` gates the
 *  writer's `ready`; `admits(peerIndex)` gates each reader's `admitted`. */
function fakeChild(opts: { writerReady?: boolean; admits: (peerIndex: number) => boolean }) {
  return (cfg: PeerChildConfig): PeerChildHandle =>
    ({
      cfg,
      waitFor: (pred: string | ((e: unknown) => boolean)) => {
        const evt = typeof pred === 'string' ? pred : '';
        if (evt === 'ready') {
          const ready = cfg.role === 'writer' ? opts.writerReady !== false : true;
          return Promise.resolve(ready ? { evt } : null);
        }
        if (evt === 'admitted') return Promise.resolve(opts.admits(cfg.peerIndex) ? { evt } : null);
        return Promise.resolve(null);
      },
      kill: () => {},
    }) as unknown as PeerChildHandle;
}

const FIXED = {
  log: () => {},
  // Non-empty bootstrap → no real testnet is created; explicit roots → no mkdtemp.
  bootstrap: [{ host: '127.0.0.1', port: 49737 }],
  roots: { writer: '/tmp/ei115-fake-w', readers: ['/tmp/ei115-fake-r0'] },
  meshTimeoutMs: 10,
};

describe('spawnProcMesh formation failure is typed (EI-115)', () => {
  it('a reader that never admits throws MeshFormationError carrying its peerIndex', async () => {
    const err = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ admits: () => false }),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshFormationError);
    expect(err.name).toBe('MeshFormationError');
    // reader peerIndex is i+1 = 1 — the exact value EI-115 reported.
    expect(err.peerIndex).toBe(1);
    expect(err.message).toContain('reader 1 never admitted');
  });

  it('a writer that never becomes ready throws MeshFormationError (no peerIndex)', async () => {
    const err = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ writerReady: false, admits: () => true }),
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeshFormationError);
    expect(err.peerIndex).toBeUndefined();
    expect(err.message).toContain('writer never became ready');
  });

  it('a mesh that forms resolves to the writer + readers (no throw)', async () => {
    const mesh = await spawnProcMesh({
      readers: 1,
      ...FIXED,
      spawnChild: fakeChild({ admits: () => true }),
    });
    expect(mesh.writer.cfg.role).toBe('writer');
    expect(mesh.readers).toHaveLength(1);
    expect(mesh.readers[0].cfg.peerIndex).toBe(1);
    await mesh.teardown();
  });
});
