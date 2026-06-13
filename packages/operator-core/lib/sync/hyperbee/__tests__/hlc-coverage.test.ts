import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeHlc,
  decodeHlc,
  compareHlc,
  processHlc,
  _resetProcessHlcForTests,
} from '@papercusp/locks-core';
import { stampOpHlc, observeRemoteHlc } from '../hlc-stamp';
import { mergeAdmittedLogs, type AdmittedLog } from '../read-merge';
import { applyOpVia, type TableProjection } from '../projection';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * shared-hive-hardening-2026-06-13 P-010 — HLC coverage on the capture path.
 * Before this, NO federated write carried an `hlc` (the generic clock was never
 * imported by sync/hyperbee and `toEnvelope` dropped the field), so `lwwPick`
 * always fell back to wall-clock `ts` — a fast/stepped clock could win every
 * conflict. These tests pin the SEND seam (stamp), the RECV seam (causal
 * advance), and the merge passthrough that makes `lwwPick` order by HLC.
 */
beforeEach(() => _resetProcessHlcForTests());

function fakeLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}

describe('HLC send/recv coverage (P-010)', () => {
  it('stampOpHlc stamps a process-monotone HLC on each successive write', () => {
    const a = stampOpHlc({ table: 'queue', hbKey: 'k', ts: 5 });
    const b = stampOpHlc({ table: 'queue', hbKey: 'k', ts: 5 });
    expect(a.hlc).toBeTruthy();
    expect(b.hlc).toBeTruthy();
    // strictly increasing — the single-writer log's ops are totally ordered.
    expect(compareHlc(decodeHlc(b.hlc), decodeHlc(a.hlc))).toBe(1);
  });

  it('stampOpHlc preserves a pre-set hlc (replay / captured stamp)', () => {
    const pre = encodeHlc({ ms: 999, count: 7 });
    const out = stampOpHlc({ table: 'queue', hbKey: 'k', ts: 1, hlc: pre });
    expect(out.hlc).toBe(pre);
  });

  it('observeRemoteHlc advances the clock past a remote frontier — the causal equalizer vs a fast-clock peer', () => {
    // A peer whose wall clock is FAR ahead (skew/step): its HLC.ms is huge.
    const remote = encodeHlc({ ms: Date.now() + 10_000_000, count: 0 });
    observeRemoteHlc(remote);
    // Our next local write — even though OUR wall clock is far behind the peer's
    // — is stamped strictly GREATER, so it correctly wins LWW over the op we just
    // observed. Without recv-advance our write would lose to the skewed peer.
    const local = stampOpHlc({ table: 'queue', hbKey: 'k', ts: Date.now() });
    expect(compareHlc(decodeHlc(local.hlc), decodeHlc(remote))).toBe(1);
  });

  it('observeRemoteHlc is a no-op on a missing/blank/garbage hlc (back-compat)', () => {
    stampOpHlc({ table: 'queue', hbKey: 'seed', ts: 1 }); // give the clock a value
    const before = processHlc().peek();
    observeRemoteHlc(undefined);
    observeRemoteHlc(null);
    observeRemoteHlc('');
    expect(processHlc().peek()).toEqual(before);
  });

  it('the merge orders a same-key conflict by HLC carried through toEnvelope (not wall-clock ts)', async () => {
    // The HLC-causally-LATER op has the SMALLER ts (its author's wall clock
    // lagged). Pre-P-010 the merge dropped `hlc` → the bigger-ts (wrong) op won.
    // With passthrough, the HLC winner is applied.
    const winner: PeerLogOp = {
      type: 'put', table: 'queue', hbKey: 'F-1', value: { v: 'win' },
      ts: 10, schema_version: 1, author_pubkey: 'a', hlc: encodeHlc({ ms: 2000, count: 0 }),
    };
    const loser: PeerLogOp = {
      type: 'put', table: 'queue', hbKey: 'F-1', value: { v: 'lose' },
      ts: 9999, schema_version: 1, author_pubkey: 'b', hlc: encodeHlc({ ms: 1000, count: 0 }),
    };
    const applied: OpEnvelope[] = [];
    await mergeAdmittedLogs([fakeLog('aaaa', [winner]), fakeLog('bbbb', [loser])], {
      getTimeoutMs: 0,
      applyImpl: async (op) => {
        applied.push(op);
        return true;
      },
    });
    expect(applied).toHaveLength(1);
    expect((applied[0].value as { v: string }).v).toBe('win');
    expect(applied[0].hlc).toBe(winner.hlc); // hlc survived toEnvelope
  });

  it('applyOpVia advances the process clock when applying a REMOTE op carrying an hlc', async () => {
    const remoteHlc = encodeHlc({ ms: Date.now() + 5_000_000, count: 0 });
    const proj: TableProjection<{ k: string }> = {
      tableTag: 'queue',
      composeKey: (r) => r.k,
      decodeValue: (raw) => raw as { k: string },
      writeToPg: async () => {},
      deleteFromPg: async () => {},
    };
    const remoteOp: OpEnvelope = {
      type: 'put', table: 'queue', hbKey: 'F-1', value: { k: 'F-1' },
      ts: 1, hlc: remoteHlc, sourceLogKeyHex: 'REMOTE', writerPubkey: 'b',
    };
    await applyOpVia(() => proj, remoteOp, { ownLogKeyHex: 'OWN' });
    // Clock advanced past the remote frontier → next local write follows it.
    const next = stampOpHlc({ table: 'queue', hbKey: 'x', ts: 1 });
    expect(compareHlc(decodeHlc(next.hlc), decodeHlc(remoteHlc))).toBe(1);
  });

  it('applyOpVia does NOT advance the clock for an OWN op (we authored it)', async () => {
    const ownHlc = encodeHlc({ ms: Date.now() + 5_000_000, count: 0 });
    const proj: TableProjection<{ k: string }> = {
      tableTag: 'queue',
      composeKey: (r) => r.k,
      decodeValue: (raw) => raw as { k: string },
      writeToPg: async () => {},
      deleteFromPg: async () => {},
    };
    const ownOp: OpEnvelope = {
      type: 'put', table: 'queue', hbKey: 'F-1', value: { k: 'F-1' },
      ts: 1, hlc: ownHlc, sourceLogKeyHex: 'OWN', writerPubkey: 'me',
    };
    await applyOpVia(() => proj, ownOp, { ownLogKeyHex: 'OWN' });
    // The own op's (huge) HLC must NOT have been merged into our clock.
    const next = stampOpHlc({ table: 'queue', hbKey: 'x', ts: Date.now() });
    expect(compareHlc(decodeHlc(next.hlc), decodeHlc(ownHlc))).toBe(-1);
  });
});
