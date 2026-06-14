/**
 * substrate-peer-log-compaction-2026-06-13 P-008 — the $0 LOCAL-PARITY leg of the
 * compaction-under-live-replication proof (design A, D-005). Multi-PROCESS (real
 * substrate peers on a local hyperdht testnet), so the snapshot op genuinely
 * replicates peer→peer through the wire-leg the same way it will cross machines —
 * the from-scratch-process equivalent the in-process snapshot-fold suites can't give.
 *
 * What it proves (single box, real cross-process replication):
 *  1. COMPACTION UNDER LIVE REPLICATION — a writer that auto-compacts MID-STREAM
 *     (its own log crosses SNAPSHOT_COMPACT_EVERY_OPS = 1000 ops → boot.ts appends one
 *     `__snapshot__` op inside the merge pass) does NOT break a CONNECTED reader's
 *     replication stream: the reader keeps folding and converges to ALL the writer's
 *     winners (no lost ops, no stuck fold) despite the large snapshot op landing mid-stream.
 *  2. FRESH-JOINER FOLD FROM THE SNAPSHOT — a peer that joins AFTER the writer has
 *     compacted (flag on → `seedCursorFromSnapshots` positions its merge cursor at the
 *     writer's latest snapshot index) reconstitutes the FULL winner set by folding the
 *     snapshot + the post-snapshot tail — i.e. the snapshot-fold path is correct over a
 *     real replicated log, not just the in-memory fixture. Convergence here is the
 *     regression guard: a buggy snapshot expansion would drop the pre-snapshot keys and
 *     the joiner would never catch up.
 *
 * The flag is enabled per-process via the `PAPERCUSP_FLAG_*` env override (precedence over
 * FLAG_DEFAULTS, no PG needed) — the local children inherit it through `spawnPeerChild`'s
 * `...process.env`, so this needs ZERO production-code change.
 *
 * Real-hardware residual (the literal P-008 `needs-human` gate, NOT covered here): the
 * sparse-fetch BYTE-SKIP — that the joiner downloads only `[snapshotIndex, len)` of the
 * writer's Hypercore over a real WAN — needs download-stat instrumentation + two real
 * machines; this local leg proves the LOGIC (compaction replicates cleanly + folds
 * correctly cross-process), which is the prerequisite for that run.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { spawnPeerChild, type PeerChildHandle } from './perf/child-driver';
import type { PeerChildConfig } from './perf/peer-child';

const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_SUBSTRATE_LOG_SNAPSHOT';
const TEN_MIN = 10 * 60_000;
// MUST exceed read-merge's SNAPSHOT_SCAN_LOOKBACK (SNAPSHOT_COMPACT_EVERY_OPS * 4 = 4000) for
// the BYTE-SKIP (proof 3) to manifest: `findLatestSnapshotIndex` floors its backward snapshot
// scan at `max(0, len - 4000)`, so a log SHORTER than the lookback floors at 0 and a fresh
// joiner scans (= downloads) the whole log to find the snapshot — no skip. Above the lookback,
// the floor is > 0 and the joiner touches only the tail `[snapshotIndex, len)`, skipping the
// pre-snapshot prefix. (1000 is also > SNAPSHOT_COMPACT_EVERY_OPS so the writer auto-compacts
// mid-stream regardless — proofs 1/2.)
const COUNT = 4600;

describe('substrate compaction under live replication — $0 local parity (multi-process, local testnet)', () => {
  it(
    'writer auto-compacts mid-stream → connected reader converges + a FRESH joiner folds from the snapshot, zero lost ops',
    async () => {
      process.env[FLAG_ENV] = '1'; // design-A snapshot compaction ON in every child (inherited via process.env)
      const testnet = await createTestnet(3);
      const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
        host: b.host,
        port: b.port,
      }));
      const slug = `sub-compact-${Date.now()}`;
      const dirs: string[] = [];
      const root = (tag: string): string => {
        const d = mkdtempSync(join(tmpdir(), `sub-compact-${tag}-`));
        dirs.push(d);
        return d;
      };
      const cfg = (over: Partial<PeerChildConfig> & Pick<PeerChildConfig, 'role' | 'peerIndex' | 'root'>): PeerChildConfig => ({
        workspaceId: 'p2p-compact',
        harnessSlug: slug,
        bootstrap,
        corpusAuthor: 'a'.repeat(64),
        ...over,
      });
      const handles: PeerChildHandle[] = [];
      try {
        // ── Writer (slot 0): appends COUNT ops as fast as possible; its merge pass
        //    auto-compacts once the own log passes 1000 ops (one additive `__snapshot__`). ──
        const writer = spawnPeerChild(cfg({ role: 'writer', peerIndex: 0, root: root('w'), rate: 0, count: COUNT, seed: 7 }), () => {});
        handles.push(writer);
        const writerReady = await writer.waitFor('ready', TEN_MIN);
        expect(writerReady).toBeTruthy();
        const writerKeyHex = (writerReady as { keyHex: string }).keyHex;

        // ── Connected reader (slot 1): joins BEFORE the load → replicates THROUGH the compaction. ──
        const reader = spawnPeerChild(
          cfg({ role: 'reader', peerIndex: 1, root: root('r'), expectedWinners: COUNT, mergePollMs: 500, catchUpTimeoutMs: TEN_MIN }),
          () => {},
        );
        handles.push(reader);
        expect(await reader.waitFor('ready', TEN_MIN)).toBeTruthy();
        expect(await reader.waitFor('admitted', TEN_MIN)).toBeTruthy();

        // Run the load. The writer auto-compacts mid-stream (op-count crosses 1000).
        writer.send('go');
        expect(await writer.waitFor('writer-done', TEN_MIN)).toBeTruthy();

        // PROOF 1: the connected reader converged to ALL COUNT winners despite the
        // mid-stream snapshot op — stream not broken, no ops lost.
        expect(await reader.waitFor('caught-up', TEN_MIN)).toBeTruthy();

        // ── Fresh joiner (slot 2): boots AFTER the writer compacted → with the flag on it
        //    seeds its cursor at the writer's snapshot index and folds forward. ──
        const joiner = spawnPeerChild(
          cfg({ role: 'reader', peerIndex: 2, root: root('j'), expectedWinners: COUNT, mergePollMs: 500, catchUpTimeoutMs: TEN_MIN }),
          () => {},
        );
        handles.push(joiner);
        expect(await joiner.waitFor('ready', TEN_MIN)).toBeTruthy();
        expect(await joiner.waitFor('admitted', TEN_MIN)).toBeTruthy();

        // PROOF 2: the fresh joiner reconstitutes the FULL winner set by folding the
        // snapshot + tail (a buggy snapshot-fold would drop the pre-snapshot keys and
        // never converge). This is the new-joiner replay-bound the compaction buys.
        expect(await joiner.waitFor('caught-up', TEN_MIN)).toBeTruthy();

        // PROOF 3 (the load-bearing P-008 claim): the fresh joiner SPARSE-FETCHED — it
        // downloaded only the post-snapshot TAIL of the writer's log, SKIPPING the
        // pre-snapshot prefix, while the from-start reader has the whole log.
        const joinerResult = await joiner.stopAndCollect();
        const readerResult = await reader.stopAndCollect();
        expect(joinerResult).toBeTruthy();
        expect(readerResult).toBeTruthy();
        const joinerW = joinerResult!.admittedStats?.find((s) => s.keyHex === writerKeyHex);
        const readerW = readerResult!.admittedStats?.find((s) => s.keyHex === writerKeyHex);
        expect(joinerW, 'joiner should have admitted the writer log').toBeTruthy();
        expect(readerW, 'reader should have admitted the writer log').toBeTruthy();
        // The joiner converged (has the tail) but never downloaded block 0 (pre-snapshot) —
        // the byte-skip: contiguousLength (the downloaded prefix from 0) is 0.
        expect(joinerW!.hasLast).toBe(true);
        expect(joinerW!.has0).toBe(false);
        expect(joinerW!.contiguousLength).toBe(0);
        // Control: the from-start reader downloaded the full log (block 0 present), so it
        // paid the O(history) replay the snapshot lets a fresh joiner skip.
        expect(readerW!.has0).toBe(true);
        expect(readerW!.contiguousLength).toBeGreaterThan(joinerW!.contiguousLength);
      } finally {
        for (const h of handles) {
          try {
            h.send('stop');
          } catch {
            /* already gone */
          }
        }
        await new Promise((r) => setTimeout(r, 800));
        for (const h of handles) {
          try {
            h.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        await testnet.destroy().catch(() => {});
        for (const d of dirs) {
          try {
            rmSync(d, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        delete process.env[FLAG_ENV];
      }
    },
    TEN_MIN,
  );
});
