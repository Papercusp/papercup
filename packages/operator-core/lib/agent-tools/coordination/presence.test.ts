/**
 * presence.test.ts — pure-function coverage for `probeProcessLiveness`
 * (WI-3898 P1, coord:presence liveness parity's local-only pid probe).
 *
 * The rest of presence.ts (writePresence/touchHeartbeat/listPresence/…) is a
 * thin PG-backed wrapper, covered by presence.integration.test.ts against
 * real Postgres — this file is only the pure kill(pid,0) probe, which needs
 * no DB and is cheap to pin exhaustively.
 */
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { probeProcessLiveness } from './presence';

const LOCAL = hostname();

describe('probeProcessLiveness (WI-3898 P1: local-only kill(pid,0) liveness probe)', () => {
  it('true: a live pid on THIS machine — probing our own process is always alive', () => {
    expect(probeProcessLiveness({ host: LOCAL, pid: process.pid })).toBe(true);
  });

  it('false: a pid that does not exist on this machine (ESRCH) reads confirmed-dead', () => {
    // A pid astronomically unlikely to be live (max pid on Linux is ~4.19M by
    // default; pid_max can be raised, but this is still not a real process).
    expect(probeProcessLiveness({ host: LOCAL, pid: 999_999_999 })).toBe(false);
  });

  it('null: a DIFFERENT/remote host is never probed, even with a real-looking pid', () => {
    expect(probeProcessLiveness({ host: 'some-other-machine', pid: process.pid })).toBeNull();
  });

  it('null: no host recorded at all (declare-intent-only rows never carry one)', () => {
    expect(probeProcessLiveness({ host: null, pid: process.pid })).toBeNull();
    expect(probeProcessLiveness({ host: undefined, pid: process.pid })).toBeNull();
    expect(probeProcessLiveness({ host: '', pid: process.pid })).toBeNull();
  });

  it('null: no pid recorded at all', () => {
    expect(probeProcessLiveness({ host: LOCAL, pid: null })).toBeNull();
    expect(probeProcessLiveness({ host: LOCAL, pid: undefined })).toBeNull();
    expect(probeProcessLiveness({ host: LOCAL, pid: 0 })).toBeNull();
  });

  it('inconclusive (EPERM-shaped): pid 1 (init/systemd) is refused, not reported dead', () => {
    // On a real Linux box `kill(1, 0)` from an unprivileged process is EPERM
    // (the process exists but we can't signal it) — this must read `null`
    // ("cannot be determined"), never `false` ("confirmed dead"), or a
    // liveness reader would misreport a live process as gone. Best-effort:
    // if the CI sandbox runs as root (EPERM never fires), pid 1 reads
    // `true` instead — both are non-`false`, which is the actual invariant.
    const result = probeProcessLiveness({ host: LOCAL, pid: 1 });
    expect(result).not.toBe(false);
  });
});
