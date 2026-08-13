/**
 * WI-5781 — boot-history stdout mirror.
 *
 * Both boot-history rings are process-local, so the admission-decision trail
 * dies with the process. That makes restart-class federation bugs (cold-restart
 * re-peer, join-path) structurally undiagnosable post-hoc, and it fails
 * SILENTLY: a banked serve log shows zero admission events for a PASSING run
 * exactly as for a failing one. These tests pin the mirror that makes the
 * sparse forensic kinds survive into the banked logs.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetBootHistoryForTests,
  _setMirrorForTests,
  listBootHistory,
  recordBootEvent,
} from './boot-history';

function captureMirror(): string[] {
  const lines: string[] = [];
  _setMirrorForTests((line) => lines.push(line));
  return lines;
}

describe('boot-history stdout mirror (WI-5781)', () => {
  beforeEach(() => {
    _resetBootHistoryForTests();
  });

  it('mirrors admission DECISIONS — the WI-5781 blind spot — including the buffered miss', () => {
    const lines = captureMirror();

    // The decisive pair: an admit is observable, and so is a 'miss' that only
    // BUFFERS. The buffered case is the one that was invisible: a log that is
    // never admitted never enters the merge pass, so the replication-liveness
    // detector never samples it and emits nothing at all.
    recordBootEvent('ws1', 'hello-world', 'announce_admitted', 'log=5fe26c2e0135');
    recordBootEvent('ws1', 'hello-world', 'announce_pending', 'log=004b6867bece membership miss');

    expect(lines).toEqual([
      '[boot-history] announce_admitted harness=hello-world log=5fe26c2e0135',
      '[boot-history] announce_pending harness=hello-world log=004b6867bece membership miss',
    ]);
  });

  it('mirrors the join-lifecycle and peer-admissibility forensic kinds', () => {
    const lines = captureMirror();

    for (const kind of [
      'announce_rejected',
      'announce_clock_skew',
      'announce_error',
      'join_started',
      'join_succeeded',
      'swarm_join_failed',
      'peer_revoked',
      'peer_unrevoked',
      'boot_fail',
    ] as const) {
      recordBootEvent('ws1', 'h', kind);
    }

    expect(lines).toHaveLength(9);
    expect(lines.every((l) => l.startsWith('[boot-history] '))).toBe(true);
  });

  it('mirrors the epoch boot device identity so restart cannot erase split-identity evidence', () => {
    const lines = captureMirror();

    recordBootEvent(
      'ws1',
      'h',
      'epoch_boot_device',
      'pubkey=device-a keychainId=github:1 tiers=secretTool:false,securityCli:true,file:primary',
    );

    expect(lines).toEqual([
      '[boot-history] epoch_boot_device harness=h pubkey=device-a keychainId=github:1 tiers=secretTool:false,securityCli:true,file:primary',
    ]);
  });

  it('does NOT mirror the high-frequency epoch trace or peer_connected', () => {
    const lines = captureMirror();

    // peer_connected is already emitted by `[swarm]` (~110/run) and the epoch
    // trace is per-op: mirroring either would turn a sparse forensic signal
    // into a hot path and re-create the eviction problem in the log itself.
    recordBootEvent('ws1', 'h', 'peer_connected', 'peer=abc');
    recordBootEvent('ws1', 'h', 'epoch_gate_seen');
    recordBootEvent('ws1', 'h', 'epoch_defer');
    recordBootEvent('ws1', 'h', 'epoch_decrypt_fail');
    recordBootEvent('ws1', 'h', 'epoch_applied');

    expect(lines).toEqual([]);
  });

  it('still records mirrored kinds to the ring (the mirror ADDS a sink, never replaces one)', () => {
    captureMirror();
    recordBootEvent('ws1', 'hello-world', 'announce_pending', 'log=004b6867bece');

    const entries = listBootHistory({ workspaceId: 'ws1' });
    expect(entries.some((e) => e.kind === 'announce_pending')).toBe(true);
  });

  it('never lets a throwing console break the caller', () => {
    // Every call site is a diagnostic on a live boot/merge/announce path, so a
    // logging failure must not propagate into federation.
    _setMirrorForTests(() => {
      throw new Error('stdout closed');
    });

    expect(() =>
      recordBootEvent('ws1', 'h', 'announce_admitted', 'log=deadbeef'),
    ).not.toThrow();
    // and the ring write still happened
    expect(
      listBootHistory({ workspaceId: 'ws1' }).some((e) => e.kind === 'announce_admitted'),
    ).toBe(true);
  });
});
