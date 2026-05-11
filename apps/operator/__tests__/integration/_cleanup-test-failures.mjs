/**
 * Shared cleanup helper for the spawn-signing integration test suites.
 *
 * Each suite deliberately POSTs bad/expired/tampered signatures to
 * verify the rejection path — this populates
 * harness_shared.spawn_sig_verification_failures with rows whose
 * `claimed_spawn` follows a per-suite prefix. Without cleanup, the
 * audit table accumulates indefinitely and a human (or operator on
 * call) can't tell "ongoing prompt-injection attempt" from "the test
 * suite ran in CI."
 *
 * Call `cleanupTestFailures('s_test_%')` (or the suite's own prefix)
 * at the end of each suite.
 *
 * If the cleanup itself fails (PG unreachable, auth changed), the
 * test still passes — we don't want a flaky audit-cleanup step to
 * mask a genuine signing regression.
 */
import { execSync } from 'node:child_process';

export function cleanupTestFailures(claimedSpawnPattern) {
  try {
    execSync(
      `PGPASSWORD=harness_admin_pwd psql -h localhost -p 5432 -U harness_admin -d papercusp -c "DELETE FROM harness_shared.spawn_sig_verification_failures WHERE claimed_spawn LIKE '${claimedSpawnPattern}'" -q`,
      { stdio: 'pipe' },
    );
  } catch (err) {
    console.warn(
      `[test cleanup] could not purge spawn_sig_verification_failures rows matching ${claimedSpawnPattern}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
