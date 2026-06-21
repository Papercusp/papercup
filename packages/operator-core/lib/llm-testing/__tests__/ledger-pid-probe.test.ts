/**
 * ledger-pid-probe.test.ts — the EI-281 dead-runner liveness probe.
 *
 * A crashed llm-test runner used to hold its scenario claim for the full
 * 10-min TTL with a dead pid (this stalled the gate's runner-aggregate su-S11
 * attempt). `holderIsDeadLocalPid` is the pure decision seam wired into
 * `tryClaim`'s conflict path: a same-host holder whose pid is gone is
 * reapable immediately. Host + pid-probe are injectable so this lane stays
 * unit (no PG, no real signals).
 */
import { describe, expect, it } from 'vitest';

import { holderIsDeadLocalPid, defaultOwnerId, buildClaimKey } from '../ledger';

const HOST = 'test-box';
const dead = () => false;
const alive = () => true;

describe('holderIsDeadLocalPid (EI-281)', () => {
  it('same host + dead pid → reapable', () => {
    expect(holderIsDeadLocalPid(`${HOST}:1326356`, HOST, dead)).toBe(true);
  });

  it('same host + live pid → held', () => {
    expect(holderIsDeadLocalPid(`${HOST}:1234`, HOST, alive)).toBe(false);
  });

  it('another host is never probed — cannot signal a remote pid', () => {
    expect(holderIsDeadLocalPid('other-box:1326356', HOST, dead)).toBe(false);
  });

  it('custom owner ids without the host:pid shape are never treated as dead', () => {
    expect(holderIsDeadLocalPid('su-8f37687c-e0a1-46c6-821f-49d658f', HOST, dead)).toBe(false);
    expect(holderIsDeadLocalPid('', HOST, dead)).toBe(false);
    expect(holderIsDeadLocalPid(':123', HOST, dead)).toBe(false);
    expect(holderIsDeadLocalPid(`${HOST}:not-a-pid`, HOST, dead)).toBe(false);
    expect(holderIsDeadLocalPid(`${HOST}:-5`, HOST, dead)).toBe(false);
  });

  it('hostnames containing colons still parse pid off the LAST segment', () => {
    expect(holderIsDeadLocalPid('weird:host:42', 'weird:host', dead)).toBe(true);
    expect(holderIsDeadLocalPid('weird:host:42', 'weird:host', alive)).toBe(false);
  });

  it("the testing-shell runner's <host>:<pid>/<runId> owner id is reapable (regression — the /runId suffix used to NaN the pid)", () => {
    // The runner owns claims as `${hostname()}:${pid}/${runId.slice(0,8)}`. Before
    // the strip, Number('1326356/b713ddcb') was NaN → a killed runner's claim was
    // NEVER reaped and blocked its scenario for the full 10-min TTL.
    expect(holderIsDeadLocalPid(`${HOST}:1326356/b713ddcb`, HOST, dead)).toBe(true);
    expect(holderIsDeadLocalPid(`${HOST}:1234/b713ddcb`, HOST, alive)).toBe(false);
    // host-safety still holds with the suffix present.
    expect(holderIsDeadLocalPid('other-box:1326356/b713ddcb', HOST, dead)).toBe(false);
    // a bad pid before the slash is still rejected.
    expect(holderIsDeadLocalPid(`${HOST}:not-a-pid/b713ddcb`, HOST, dead)).toBe(false);
  });

  it('the real default owner id reports its own (live) process as held', () => {
    // No injected probe: this process is alive, so its own id is never reaped.
    expect(holderIsDeadLocalPid(defaultOwnerId())).toBe(false);
  });
});

describe('buildClaimKey shape (pinned — the probe deletes by claim_key + owner_id)', () => {
  it('scenario @ identity-prefix # matrix index', () => {
    expect(buildClaimKey({ scenarioId: 'su-S11', identityHash: 'abcdef0123456789ffff', matrixIndex: 2 })).toBe(
      'su-S11@abcdef0123456789#2',
    );
    expect(buildClaimKey({ scenarioId: 'su-S11', identityHash: 'abcdef0123456789ffff' })).toBe(
      'su-S11@abcdef0123456789#0',
    );
  });
});
