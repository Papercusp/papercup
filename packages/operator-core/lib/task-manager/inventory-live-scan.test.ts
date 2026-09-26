/**
 * EI-24342043796392664 — the live scan must never read procfs metadata
 * synchronously on the request-serving thread, and the header pill's
 * `countsOnly` read must not pay for per-process metadata at all.
 *
 * Measured before this fix: runLiveScan ran readlinkSync + readFileSync for up to
 * 4000 processes on every 5s memo refresh, even for the pill that discards the
 * rows, and that chain was ~13% of the :3170 main thread during the P-007 popup
 * stalls. These tests pin the WIRING: which reader runs, and when.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannedProcess } from './reconcile';

const H = vi.hoisted(() => ({
  syncReads: 0,
  asyncReads: [] as number[],
  scanned: [] as ScannedProcess[],
}));

vi.mock('./store', () => ({ listTasks: vi.fn(async () => []) }));
vi.mock('./scan', () => ({ defaultForeignSignature: () => undefined }));
vi.mock('../superuser-token', () => ({ readSuperuserToken: () => null }));
vi.mock('./reconcile-tick', () => ({
  reconcileTick: vi.fn(async () => ({
    summary: { scanned: H.scanned.length },
    degraded: false,
    degradedReason: null,
    scan: {},
    result: { unaccounted: [] },
    scannedProcesses: H.scanned,
  })),
}));
vi.mock('../process-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-metadata')>();
  return {
    ...actual,
    readProcessMetadata: vi.fn(() => {
      H.syncReads += 1;
      throw new Error('synchronous procfs read on the live-scan path');
    }),
    readProcessMetadataAsync: vi.fn(async (pid: number) => {
      H.asyncReads.push(pid);
      return { executable: `exe-${pid}`, role: null, build: null };
    }),
  };
});

import { getTaskInventory, resetLiveScanMemoForTest } from './inventory';

const proc = (pid: number, scope: ScannedProcess['scope']): ScannedProcess => ({
  pid,
  cmdline: `worker-${pid} --token=secret-${pid}`,
  cgroupPath: `/papercusp.slice/pc-${pid}.scope`,
  processIdentity: `linux:boot:${pid}`,
  owned: scope === 'owned',
  scope,
  exemptReason: null,
});

beforeEach(() => {
  resetLiveScanMemoForTest();
  H.syncReads = 0;
  H.asyncReads = [];
  H.scanned = [proc(30, 'exempt'), proc(20, 'unaccounted'), proc(10, 'owned')];
});

describe('task inventory live scan — procfs metadata', () => {
  it('CALIBRATION: a pane read projects every row through the async reader', async () => {
    const inv = await getTaskInventory({ live: true });
    expect(inv.liveProcesses.map((r) => [r.pid, r.executable])).toEqual([
      [10, 'exe-10'],
      [20, 'exe-20'],
      [30, 'exe-30'],
    ]);
    expect(H.asyncReads.sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(H.syncReads).toBe(0);
    expect(JSON.stringify(inv.liveProcesses)).not.toContain('secret-');
  });

  it('the header pill (countsOnly) reads NO per-process metadata', async () => {
    const inv = await getTaskInventory({ live: true, countsOnly: true });
    expect(inv.live).toMatchObject({ scanned: 3 });
    expect(inv.liveProcesses).toEqual([]);
    expect(H.asyncReads).toEqual([]);
    expect(H.syncReads).toBe(0);
  });

  it('pane reads inside one scan TTL share ONE projection', async () => {
    await getTaskInventory({ live: true, countsOnly: true });
    await getTaskInventory({ live: true });
    await getTaskInventory({ live: true });
    expect(H.asyncReads).toHaveLength(3);
  });
});
