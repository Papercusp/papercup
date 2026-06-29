/**
 * substrate-sidecar-host.test.ts — Phase 1 of the substrate store relocation
 * (substrate-sidecar-store-relocation-2026-06-23, P-001).
 *
 * Proves the IPC append seam end-to-end IN THE HOST (no socket / no spawned
 * process): the sidecar host opens a real per-harness corestore + own-log, and
 * `substrate:appendOp` HLC-stamps a LocalWriteOp and persists it to the
 * relocated own-log. Verified by REOPENING the store from disk after the host
 * closes it (the file lock is released) and reading the ops back — i.e. the op
 * really crossed into the sidecar-owned store, not a mock.
 *
 * Resource hygiene: every temp dir + the host store are torn down in afterEach.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubstrateSidecarHost, type SubstrateSidecarHost } from './substrate-sidecar-host';
import { openOwnLog, type PeerLogOp } from './peer-log';
import type { BootedHarnessHandle, BootHarnessOpts, LocalWriteOp } from './boot';
import { recordBootEvent, _resetBootHistoryForTests } from './boot-history';
import { makeFakeBootedHandle } from './__tests__/fake-booted-handle';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort teardown
    }
  }
});

function tempStoragePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempWorkspace(prefix: string): { workspaceRoot: string; storagePath: string } {
  const workspaceRoot = tempStoragePath(prefix);
  return {
    workspaceRoot,
    storagePath: join(workspaceRoot, '.papercusp', SLUG, 'hyperbee'),
  };
}

function makeHost(): SubstrateSidecarHost {
  const host = createSubstrateSidecarHost({
    wireOutbox: async () => {},
    wirePresence: async () => {},
  });
  cleanups.push(() => host.closeAll());
  return host;
}

const WS = 'ws-test';
const SLUG = 'harness-reloc';

function localOp(over: Partial<LocalWriteOp> = {}): LocalWriteOp {
  return {
    type: 'put',
    table: 'feature_queue',
    hbKey: 'k-1',
    value: { feature_id: 'F-1', queued_at: 100 },
    ts: 100,
    schema_version: 1,
    ...over,
  };
}

describe('substrate sidecar host — store relocation (P-001)', () => {
  it('bootHarness opens the store + own-log and returns a 64-hex own-log key', async () => {
    const host = makeHost();
    const { workspaceRoot } = tempWorkspace('reloc-boot-');
    const r = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
      workspaceRoot,
    })) as { storeId: string; ownLogKey: string; ownLogLength: number };

    expect(r.storeId).toMatch(/^store-\d+$/);
    expect(r.ownLogKey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ownLogLength).toBe(0);
    expect(host.storeCount()).toBe(1);
  });

  it('bootHarness is idempotent per (workspace, harness) — same storeId', async () => {
    const host = makeHost();
    const { workspaceRoot } = tempWorkspace('reloc-idem-');
    const a = (await host.methods['substrate:bootHarness']({ workspaceId: WS, harnessSlug: SLUG, workspaceRoot })) as {
      storeId: string;
    };
    const b = (await host.methods['substrate:bootHarness']({ workspaceId: WS, harnessSlug: SLUG, workspaceRoot })) as {
      storeId: string;
    };
    expect(b.storeId).toBe(a.storeId);
    expect(host.storeCount()).toBe(1);
  });

  it('appendOp HLC-stamps + persists into the relocated own-log (verified by reopening from disk)', async () => {
    const host = makeHost();
    const { workspaceRoot, storagePath } = tempWorkspace('reloc-append-');
    const boot = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
      workspaceRoot,
    })) as { storeId: string; ownLogKey: string };

    const r1 = (await host.methods['substrate:appendOp']({
      storeId: boot.storeId,
      op: localOp({ hbKey: 'k-1', value: { feature_id: 'F-1' } }),
    })) as { ok: boolean; ownLogLength: number; hlc: string | null };
    const r2 = (await host.methods['substrate:appendOp']({
      storeId: boot.storeId,
      op: localOp({ hbKey: 'k-2', value: { feature_id: 'F-2' } }),
    })) as { ok: boolean; ownLogLength: number; hlc: string | null };

    expect(r1.ok).toBe(true);
    expect(r1.ownLogLength).toBe(1);
    expect(r2.ownLogLength).toBe(2);
    // The real boot handle stamps HLC internally; the RPC response does not
    // expose that private stamp, so persistence below is the assertion.
    expect(r1.hlc).toBeNull();

    const status = (await host.methods['substrate:getStoreStatus']({ storeId: boot.storeId })) as {
      ownLogLength: number;
      ownLogKey: string | null;
    };
    expect(status.ownLogLength).toBe(2);
    expect(status.ownLogKey).toBe(boot.ownLogKey);

    // Close the host store (releases the file lock), then REOPEN from disk and
    // read the ops back — proves they persisted into the sidecar-owned store.
    await host.closeAll();
    const verifyStore = new Corestore(storagePath);
    cleanups.push(() => verifyStore.close());
    await verifyStore.ready();
    const log = await openOwnLog(verifyStore);
    expect(log.length).toBe(2);
    expect(log.keyHex).toBe(boot.ownLogKey);
    const op0 = (await log.get(0)) as PeerLogOp;
    const op1 = (await log.get(1)) as PeerLogOp;
    expect(op0).toMatchObject({ type: 'put', table: 'feature_queue', hbKey: 'k-1' });
    expect(op0.hlc).toBeTruthy();
    expect(op1).toMatchObject({ hbKey: 'k-2' });
  });

  it('appendOp { raw } appends a fully-formed PeerLogOp verbatim (no HLC stamp)', async () => {
    const host = makeHost();
    const { workspaceRoot, storagePath } = tempWorkspace('reloc-raw-');
    const boot = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
      workspaceRoot,
    })) as { storeId: string };

    const rawOp: PeerLogOp = {
      type: 'put',
      table: 'feature_claims',
      hbKey: 'claim-1',
      value: { claimed: true },
      ts: 200,
      schema_version: 1,
      author_pubkey: 'devkeyA',
      // no hlc — the append-only claim path never carries one
    };
    const r = (await host.methods['substrate:appendOp']({ storeId: boot.storeId, op: rawOp, raw: true })) as {
      ok: boolean;
      hlc: string | null;
    };
    expect(r.ok).toBe(true);
    expect(r.hlc).toBeNull();

    await host.closeAll();
    const verifyStore = new Corestore(storagePath);
    cleanups.push(() => verifyStore.close());
    await verifyStore.ready();
    const log = await openOwnLog(verifyStore);
    const op0 = (await log.get(0)) as PeerLogOp;
    expect(op0).toMatchObject({ table: 'feature_claims', hbKey: 'claim-1', author_pubkey: 'devkeyA' });
    expect(op0.hlc).toBeUndefined();
  });

  it('appendOp on an unknown storeId throws store-not-found', async () => {
    const host = makeHost();
    await expect(host.methods['substrate:appendOp']({ storeId: 'store-999', op: localOp() })).rejects.toThrow(
      /Store not found/,
    );
  });

  it('closeStore removes the store', async () => {
    const host = makeHost();
    const { workspaceRoot } = tempWorkspace('reloc-close-');
    const boot = (await host.methods['substrate:bootHarness']({ workspaceId: WS, harnessSlug: SLUG, workspaceRoot })) as {
      storeId: string;
    };
    expect(host.storeCount()).toBe(1);
    const r = (await host.methods['substrate:closeStore']({ storeId: boot.storeId })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(host.storeCount()).toBe(0);
  });

  it('delegates merge/admission/revoke/rekey RPCs to the relocated booted handle', async () => {
    const fake = makeFakeBootedHandle({ workspaceId: WS, harnessSlug: SLUG, keyHex: 'ab'.repeat(32) }).handle;
    fake.mergeNow = vi.fn(async () => 7);
    fake.onAnnounce = vi.fn(async () => ({ admit: true, reason: 'verified' }) as never);
    fake.revoke = vi.fn(async () => {});
    fake.rekey = vi.fn(async () => {});
    const bootHarnessImpl = vi.fn(async () => fake);
    const host = createSubstrateSidecarHost({
      bootHarnessImpl: bootHarnessImpl as (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>,
      wireOutbox: async () => {},
      wirePresence: async () => {},
    });
    cleanups.push(() => host.closeAll());

    const boot = (await host.methods['substrate:bootHarness']({
      workspaceId: WS,
      harnessSlug: SLUG,
      workspaceRoot: tempWorkspace('reloc-delegate-').workspaceRoot,
    })) as { storeId: string; admittedPeerCount: number };

    expect(boot.admittedPeerCount).toBe(1);
    const merge = (await host.methods['substrate:triggerMergeNow']({ storeId: boot.storeId })) as { mergedOps: number };
    expect(merge.mergedOps).toBe(7);
    expect(fake.mergeNow).toHaveBeenCalledOnce();

    const announce = { log_core_key: 'peer-key' };
    await host.methods['substrate:onAnnounce']({ storeId: boot.storeId, announce });
    expect(fake.onAnnounce).toHaveBeenCalledWith(announce);

    const logs = (await host.methods['substrate:getAdmittedLogs']({ storeId: boot.storeId })) as { logs: string[] };
    expect(logs.logs).toEqual(['ab'.repeat(32)]);

    await host.methods['substrate:revoke']({ storeId: boot.storeId, devicePubkey: 'devpub' });
    expect(fake.revoke).toHaveBeenCalledWith('devpub');

    const binding = { kind: 'gh', github_repository_id: 123 };
    await host.methods['substrate:rekey']({ storeId: boot.storeId, binding });
    expect(fake.rekey).toHaveBeenCalledWith(binding);
  });
});

describe('substrate:getBootHistory (sidecar-ring read surface)', () => {
  it('returns the sidecar process boot-history ring (entries + depth), honoring filters', () => {
    _resetBootHistoryForTests();
    cleanups.push(() => _resetBootHistoryForTests());
    // These are recorded HERE (the sidecar process) in SUBSTRATE_SIDECAR mode.
    recordBootEvent(WS, SLUG, 'boot_ok');
    recordBootEvent(WS, SLUG, 'announce_admitted', 'peer-x');
    recordBootEvent('other-ws', 'other', 'boot_fail');

    const host = makeHost();
    const all = host.methods['substrate:getBootHistory']({}) as {
      entries: Array<{ kind: string }>;
      depth: number;
    };
    expect(all.depth).toBe(3);
    expect(all.entries).toHaveLength(3);

    // Filter pass-through (workspace + kind) — the route forwards ListBootHistoryOpts verbatim.
    const filtered = host.methods['substrate:getBootHistory']({
      workspaceId: WS,
      kinds: ['announce_admitted'],
    }) as { entries: Array<{ kind: string; message?: string }>; depth: number };
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]!.kind).toBe('announce_admitted');
    expect(filtered.entries[0]!.message).toBe('peer-x');
    expect(filtered.depth).toBe(3); // depth is the whole ring, unaffected by filters
  });
});
