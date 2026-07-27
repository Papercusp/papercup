/**
 * machine-expects-stamp.test.ts — P-033 (d) / D-072.
 *
 * The system emitters call `sendMessage` directly, so they never pass through
 * the `coord:send` tool that requires `expects`. The seam stamps `expects:'none'`
 * for them, and stamps it as DERIVED so adoption measurement never counts a
 * machine default as sender intent.
 *
 * ⚠ THE REGRESSION THESE PIN is the near-miss that made two signals necessary:
 * `isMachineAuthoredSender` is conservative (a false positive would silence the
 * human `pc-admin-coord-ui`), so it matches `system-watchdog` but NOT
 * `service-health` / `rate-governor` / `boot-migrate` / `hive-owner-key-health`.
 * Keying the stamp on that predicate alone would have LOOKED like a one-seam fix
 * while covering a third of the emitter population.
 */

import { describe, it, expect } from 'vitest';
import { isMachineAuthoredSender } from './machine-authored';

/** The seam's rule, extracted so it can be asserted without a live DB. */
function stampsMachineExpects(from: string, auto?: boolean): boolean {
  return isMachineAuthoredSender(from) || auto === true;
}

describe('which senders the seam stamps', () => {
  it('stamps identities the conservative pattern DOES match', () => {
    expect(stampsMachineExpects('system-watchdog')).toBe(true);
    expect(stampsMachineExpects('system:operator-directive')).toBe(true);
    expect(stampsMachineExpects('claim-discipline-watch')).toBe(true);
    expect(stampsMachineExpects('work-items')).toBe(true);
  });

  it('⚠ the pattern alone MISSES these — the gap the second signal closes', () => {
    for (const id of ['service-health', 'rate-governor', 'boot-migrate', 'hive-owner-key-health']) {
      expect(isMachineAuthoredSender(id)).toBe(false);
      // …which is why each of those emitters now marks itself `auto: true`.
      expect(stampsMachineExpects(id, true)).toBe(true);
    }
  });

  it('NEVER stamps the human owner or a real agent — a derived FYI would silence them', () => {
    // pc-admin-coord-ui is the human typing in the admin coord UI; silencing it
    // would hide the sender whose message most deserves to preempt an agent.
    expect(stampsMachineExpects('pc-admin-coord-ui')).toBe(false);
    expect(stampsMachineExpects('human')).toBe(false);
    expect(stampsMachineExpects('su-8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804')).toBe(false);
  });

  it('an explicit auto:false does not opt a real correspondent IN', () => {
    expect(stampsMachineExpects('su-abc', false)).toBe(false);
  });
});
