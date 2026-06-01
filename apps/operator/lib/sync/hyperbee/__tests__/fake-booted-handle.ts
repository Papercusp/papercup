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
import type { PeerLogOp } from '../peer-log';
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
  /**
   * Optional retired-Autobase `base` shape. The orchestrator claim path
   * (get-claim-handle / distributed-claim) still reads `handle.base` until the
   * Stage-5 claim rewrite; those tests pass a legacy base here so the adapter
   * finds it. Attached via an `unknown` cast so the (no-longer-declared) `base`
   * property doesn't trip excess-property checks.
   */
  legacyBase?: unknown;
} = {}): FakeBootedHandle {
  const workspaceId = opts.workspaceId ?? 'ws-1';
  const harnessSlug = opts.harnessSlug ?? 'papercup';
  const keyHex = opts.keyHex ?? 'aa'.repeat(32);

  const appended: LocalWriteOp[] = [];
  const ops: PeerLogOp[] = [];

  const ownLog: AdmittedLog = {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
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
    swarm: null,
    close: vi.fn(async () => {}),
  };

  if (opts.legacyBase !== undefined) {
    (handle as unknown as { base: unknown }).base = opts.legacyBase;
  }

  return { handle, appended };
}
