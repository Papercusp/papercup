/**
 * rate-limit-enforcement.test.ts — EN-2 (P-RATE) end-to-end enforcement proof.
 *
 * Drives the REAL production merge (`mergeAdmittedLogsIncremental`) with the EN-2
 * `makeRateLimitedApply` wrapper as `applyImpl`, over in-memory peer logs + an
 * in-memory "canonical PG". Proves the brief's GREEN bar WITHOUT booting the
 * substrate / PG / network:
 *
 *  - a member over the owner-set cap has its excess DROPPED at op admission — the
 *    flood never lands in the canonical store on an honest peer;
 *  - two honest peers (independent limiters, different log read orders) CONVERGE on
 *    the identical canonical store WITHOUT the flood;
 *  - a malicious peer that ignores the policy locally cannot make the flood
 *    canonical on honest peers (honest-majority trust model);
 *  - default (no policy) ⇒ zero behavior change;
 *  - the flooder's legit-rate (next-window) ops still apply (no total ban);
 *  - TEETH: neuter the cap and the same flood fully lands (the RED control).
 */

import { describe, it, expect } from 'vitest';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  type AdmittedLog,
} from './read-merge';
import { MemberRateLimiter, type RateCaps } from './rate-limiter';
import { makeRateLimitedApply } from './rate-limit-admission';

const OWN_KEY = 'o'.repeat(64);
const FLOODER_KEY = 'f'.repeat(64);
const HONEST_KEY = 'h'.repeat(64);

const FLOODER_GH = 9001;
const HONEST_GH = 7;

/** A content (issues) put PeerLogOp authored by `authorPubkey`. */
function put(hbKey: string, ts: number, authorPubkey: string, value: unknown = { v: 1 }): PeerLogOp {
  return { type: 'put', table: 'issues', hbKey, value, ts, schema_version: 1, author_pubkey: authorPubkey };
}

function fakeLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i: number) => ops[i] ?? null };
}

/** The admission map: source log key → admitted github_user_id. */
const ADMISSION = new Map<string, number>([
  [FLOODER_KEY, FLOODER_GH],
  [HONEST_KEY, HONEST_GH],
]);

/** Run one honest peer: a fresh limiter + fresh in-memory PG, merging `logs`
 *  through the EN-2 wrapper. Returns the canonical store as a sorted snapshot. */
async function runPeer(
  logs: AdmittedLog[],
  caps: RateCaps | null,
): Promise<{ pg: Map<string, unknown>; limiter: MemberRateLimiter }> {
  const pg = new Map<string, unknown>();
  const limiter = new MemberRateLimiter();
  const apply = makeRateLimitedApply({
    limiter,
    ownLogKeyHex: OWN_KEY,
    resolveAuthorId: (k) => ADMISSION.get(k) ?? null,
    currentCaps: () => caps,
    apply: async (op: OpEnvelope) => {
      if (op.type === 'del') pg.delete(`${op.table}:${op.hbKey}`);
      else pg.set(`${op.table}:${op.hbKey}`, op.value);
      return true;
    },
  });
  await mergeAdmittedLogsIncremental(logs, createMergeCursor(), { applyImpl: apply });
  return { pg, limiter };
}

const sortedKeys = (pg: Map<string, unknown>) => [...pg.keys()].sort();

describe('EN-2 enforcement through the real merge', () => {
  it('drops a member flood over cap; honest store excludes the excess', async () => {
    // Flooder: 100 distinct-key content rows clustered in one hour-window.
    const base = 1_700_000_000_000;
    const floodOps = Array.from({ length: 100 }, (_, i) => put(`spam-${i}`, base + i, 'FLOODER_DEV'));
    const honestOps = [put('real-1', base + 5, 'HONEST_DEV'), put('real-2', base + 6, 'HONEST_DEV')];
    const logs = [fakeLog(FLOODER_KEY, floodOps), fakeLog(HONEST_KEY, honestOps)];

    const { pg } = await runPeer(logs, { rowsPerHour: 10 });
    // exactly 10 flood rows + 2 honest rows survive.
    const flooderRows = [...pg.keys()].filter((k) => k.startsWith('issues:spam-'));
    expect(flooderRows).toHaveLength(10);
    expect(pg.has('issues:real-1')).toBe(true);
    expect(pg.has('issues:real-2')).toBe(true);
  });

  it('TEETH: with the cap removed the SAME flood fully lands (RED control)', async () => {
    const base = 1_700_000_000_000;
    const floodOps = Array.from({ length: 100 }, (_, i) => put(`spam-${i}`, base + i, 'FLOODER_DEV'));
    const logs = [fakeLog(FLOODER_KEY, floodOps)];
    const { pg } = await runPeer(logs, null); // no policy ⇒ no enforcement
    expect([...pg.keys()].filter((k) => k.startsWith('issues:spam-'))).toHaveLength(100);
  });

  it('two honest peers converge on the identical canonical store WITHOUT the flood', async () => {
    const base = 1_700_000_000_000;
    const floodOps = Array.from({ length: 50 }, (_, i) => put(`spam-${i}`, base + i, 'FLOODER_DEV'));
    const honestOps = [put('real-1', base + 1, 'HONEST_DEV')];
    const caps: RateCaps = { rowsPerHour: 5 };

    // Peer 1 reads [flooder, honest]; peer 2 reads [honest, flooder]. Per-author
    // log order is identical on both — only the cross-author interleave differs.
    const p1 = await runPeer([fakeLog(FLOODER_KEY, floodOps), fakeLog(HONEST_KEY, honestOps)], caps);
    const p2 = await runPeer([fakeLog(HONEST_KEY, honestOps), fakeLog(FLOODER_KEY, floodOps)], caps);

    expect(sortedKeys(p1.pg)).toEqual(sortedKeys(p2.pg));
    // and the surviving flood is exactly the cap (5), not 50.
    expect(sortedKeys(p1.pg).filter((k) => k.startsWith('issues:spam-'))).toHaveLength(5);
  });

  it('honest-majority: a malicious peer ignoring policy cannot make the flood canonical on honest peers', async () => {
    const base = 1_700_000_000_000;
    const floodOps = Array.from({ length: 30 }, (_, i) => put(`spam-${i}`, base + i, 'FLOODER_DEV'));
    const logs = [fakeLog(FLOODER_KEY, floodOps)];

    // Malicious peer M ignores the policy locally (caps=null ⇒ no enforcement).
    const malicious = await runPeer(logs, null);
    // Honest peer H enforces the owner cap.
    const honest = await runPeer(logs, { rowsPerHour: 3 });

    expect([...malicious.pg.keys()]).toHaveLength(30); // M's local store has the flood
    expect([...honest.pg.keys()]).toHaveLength(3); // H drops the excess — the canonical view
  });

  it('no total ban: the flooder legit-rate (next-window) ops still apply', async () => {
    const base = 1_700_000_000_000;
    const hour = 3_600_000;
    // 20 ops in window 0 (cap 3 ⇒ 3 land), then 2 ops a full hour later (window 1).
    const ops = [
      ...Array.from({ length: 20 }, (_, i) => put(`w0-${i}`, base + i, 'FLOODER_DEV')),
      put('w1-a', base + hour + 1, 'FLOODER_DEV'),
      put('w1-b', base + hour + 2, 'FLOODER_DEV'),
    ];
    const { pg } = await runPeer([fakeLog(FLOODER_KEY, ops)], { rowsPerHour: 3 });
    expect([...pg.keys()].filter((k) => k.startsWith('issues:w0-'))).toHaveLength(3); // window 0 capped
    expect(pg.has('issues:w1-a')).toBe(true); // next window not banned
    expect(pg.has('issues:w1-b')).toBe(true);
  });

  it('local (own-log) ops are never limited', async () => {
    const base = 1_700_000_000_000;
    const ownOps = Array.from({ length: 50 }, (_, i) => put(`mine-${i}`, base + i, 'OWN_DEV'));
    const { pg } = await runPeer([fakeLog(OWN_KEY, ownOps)], { rowsPerHour: 5 });
    expect([...pg.keys()]).toHaveLength(50); // all own writes land
  });

  it('anti-OOM: a 5k-op flood through the merge keeps limiter window state bounded', async () => {
    const base = 1_700_000_000_000;
    const floodOps = Array.from({ length: 5000 }, (_, i) => put(`s-${i}`, base + i, 'FLOODER_DEV'));
    const { pg, limiter } = await runPeer([fakeLog(FLOODER_KEY, floodOps)], { rowsPerHour: 10 });
    expect([...pg.keys()]).toHaveLength(10); // only cap landed
    // ops + rows class each tracked for the one flooder, each bounded to ~retention windows.
    expect(limiter.windowCount()).toBeLessThanOrEqual(8);
  });
});
