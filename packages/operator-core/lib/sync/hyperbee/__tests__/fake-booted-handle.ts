/**
 * Shared test helper — build a Model B `BootedHarnessHandle` fake.
 *
 * Stage 4a replaced the boot handle's Autobase (`base`) with a per-peer
 * own-log + read-merge driver. These fakes capture `append`ed local ops and
 * expose an in-memory own log so the per-table write helpers + the
 * in-process status surfaces can be exercised without a real Corestore.
 */

import { vi } from 'vitest';
import type { BootedHarnessHandle, LocalWriteOp } from '../boot';
import type { OwnLog, PeerLogOp } from '../peer-log';
import type { AdmittedLog } from '../read-merge';
import type { AdmissionResult } from '../read-admission';
import type { SignedAnnounce } from '../announce';

export interface FakeBootedHandle {
  handle: BootedHarnessHandle;
  /** Local ops captured via handle.append (the write-helper path). */
  appended: LocalWriteOp[];
}

export function makeFakeBootedHandle(opts: {
  workspaceId?: string;
  harnessSlug?: string;
  keyHex?: string;
} = {}): FakeBootedHandle {
  const workspaceId = opts.workspaceId ?? 'ws-1';
  const harnessSlug = opts.harnessSlug ?? 'papercup';
  const keyHex = opts.keyHex ?? 'aa'.repeat(32);

  const appended: LocalWriteOp[] = [];
  const ops: PeerLogOp[] = [];

  // Typed as the writable `OwnLog` (Stage 5): the claim path appends to it
  // directly, so it exposes `append` alongside the read surface.
  const ownLog: OwnLog = {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp): Promise<void> {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]): Promise<void> {
      ops.push(...batch);
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return ops[i] ?? null;
    },
  };
  const admitted = new Map<string, AdmittedLog>([[keyHex, ownLog]]);

  const handle: BootedHarnessHandle = {
    workspaceId,
    harnessSlug,
    store: {} as never,
    ownLog,
    // P-203 Leg A: the fake never joins a swarm, so it greets peers as nobody —
    // a git-sync leg reading it falls back to the gh-login actor, as before.
    announceIdentity: null,
    async append(op: LocalWriteOp): Promise<void> {
      appended.push(op);
      ops.push({
        type: op.type,
        table: op.table,
        hbKey: op.hbKey,
        value: op.value,
        ts: op.ts,
        schema_version: op.schema_version,
        author_pubkey: op.writerPubkey ?? '',
      });
    },
    admitted,
    mergeNow: vi.fn(async () => 0),
    // P-019 (D-012). Deliberately reports `appended: false` rather than faking a
    // landed snapshot: no test using this fixture exercises the real producer, and a
    // fixture that claims a snapshot exists would let a sparse-cut assertion pass
    // against a log that has none. The real behaviour is covered end-to-end against a
    // REAL booted substrate in __tests__/on-demand-head-snapshot.test.ts.
    produceHeadSnapshotNow: vi.fn(async () => ({
      appended: false,
      coversUpTo: 0,
      rowCount: 0,
      chunkCount: 0,
    })),
    // D-023: same stance as produceHeadSnapshotNow — reports nothing appended. The real
    // run is covered against a booted substrate in own-compaction-off-gate.test.ts.
    compactOwnLogNow: vi.fn(async () => ({
      ok: true as const,
      appended: false,
      coversUpTo: 0,
      chunkCount: 0,
      rowCount: 0,
      droppedGovernorReceipts: 0,
      liveGovernorReceiptKeys: 0,
      elapsedMs: 0,
    })),
    onAnnounce: vi.fn(
      async (_frame: SignedAnnounce): Promise<AdmissionResult> => ({
        admit: false,
        reason: 'binding_invalid',
      }),
    ),
    onAdmitted: vi.fn((_listener: (info: { logKeyHex: string; admittedSize: number }) => void) => () => {}),
    revoke: vi.fn(async (_devicePubkey: string): Promise<void> => {}),
    reverifyAdmitted: vi.fn(async () => {}),
    swarm: null,
    ensureScopeParticipation: vi.fn(async () => {}),
    rediscloseScopes: vi.fn(async () => {}),
    scopeFederation: null,
    rekey: vi.fn(async (_binding) => {}),
    registerCloseHook: vi.fn((_hook: () => void | Promise<void>) => () => {}),
    close: vi.fn(async () => {}),
  };

  return { handle, appended };
}
