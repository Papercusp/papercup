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
    onAnnounce: vi.fn(
      async (_frame: SignedAnnounce): Promise<AdmissionResult> => ({
        admit: false,
        reason: 'binding_invalid',
      }),
    ),
    revoke: vi.fn(async (_devicePubkey: string): Promise<void> => {}),
    swarm: null,
    close: vi.fn(async () => {}),
  };

  return { handle, appended };
}
