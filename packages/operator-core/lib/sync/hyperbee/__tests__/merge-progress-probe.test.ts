import { describe, it, expect, vi } from 'vitest';
import {
  createMergeCursor,
  createMergeProgressProbe,
  describeMergeProgress,
  mergeAdmittedLogsIncremental,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * WI-10003427: the tower's root harness sat in ONE merge pass for 13h+, its
 * watchdog able to say only "stage 'incremental-merge'". The fold now stamps a
 * caller-owned probe before every await, so a parked pass names the log, the
 * position and the phase it is waiting in. These tests pin that contract: the
 * probe must name a pass parked inside an apply, and must read `folded` once
 * the pass completes.
 */

function put(hbKey: string, ts: number): PeerLogOp {
  return { type: 'put', table: 'queue', hbKey, value: { v: hbKey }, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string, ops: PeerLogOp[]): OwnLog {
  return {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

const KEY = 'ab'.repeat(32);

describe('merge progress probe (WI-10003427)', () => {
  it('names the log, position and phase of a pass parked inside an apply, then reads folded', async () => {
    const log = memLog(KEY, [put('A', 1), put('B', 2), put('C', 3)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied: string[] = [];
    const applyImpl = async (env: OpEnvelope) => {
      if (env.hbKey === 'B') await gate; // park the pass on the op at position 1
      applied.push(String(env.hbKey));
      return true;
    };
    const probe = createMergeProgressProbe();
    expect(describeMergeProgress(probe)).toBe(`no log entered yet (phase 'idle')`);

    const pass = mergeAdmittedLogsIncremental([log], createMergeCursor(), {
      applyImpl,
      getTimeoutMs: 0,
      maxOpsPerPass: 0,
      applyTimeoutMs: 60_000,
      progress: probe,
    });

    await vi.waitFor(() => {
      expect(probe.phase).toBe('apply');
      expect(probe.pos).toBe(1);
    });
    expect(probe.keyHex).toBe(KEY);
    expect(describeMergeProgress(probe, probe.phaseSince + 42_000)).toBe(
      `log ${KEY.slice(0, 8)}@1 phase 'apply' for 42s`,
    );

    release();
    const result = await pass;
    expect(applied).toEqual(['A', 'B', 'C']);
    expect(result.applied).toBe(3);
    expect(probe.phase).toBe('folded');
  });

  it('a pass without a probe folds exactly as before', async () => {
    const log = memLog(KEY, [put('A', 1), put('B', 2)]);
    const applied: string[] = [];
    const result = await mergeAdmittedLogsIncremental([log], createMergeCursor(), {
      applyImpl: async (env: OpEnvelope) => {
        applied.push(String(env.hbKey));
        return true;
      },
      getTimeoutMs: 0,
      maxOpsPerPass: 0,
    });
    expect(applied).toEqual(['A', 'B']);
    expect(result.applied).toBe(2);
  });
});
