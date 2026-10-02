/**
 * Process face of the restricted-write fence for the RAW test router (WI-10005713, follow-up of
 * WI-10005634 — plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
 *
 * `testing:run` calls `restrictedHoldRefusal` in-process before it spawns `scripts/test-files.mjs`.
 * A raw `npm run test:file` reaches that router without `testing:run`, so the router spawns THIS
 * entry (via `node --import tsx`) before it starts vitest. One implementation, two doors: the
 * router never re-implements the census or the reach walk, so "refused by testing:run" and
 * "refused by the raw router" cannot drift apart.
 *
 * Usage:  node --import tsx restricted-hold-preflight-cli.ts <checkout-root> [test-file ...]
 * Output: exactly one stdout line `RESTRICTED_HOLD_PREFLIGHT <json>` where json is
 *         `{ "verdict": "admit" }` or `{ "verdict": "refuse", "error": ..., "hint": ... }`.
 * Exit:   0 admit · 3 refuse · 2 misuse. The router fails CLOSED on anything else (no line, bad
 *         JSON, a crash, a timeout), so a broken preflight can never read as an admit.
 */
import { RESTRICTED_HOLD_PREFLIGHT_EXIT, RESTRICTED_HOLD_PREFLIGHT_MARKER } from '../../../../../scripts/lib/restricted-hold-preflight.mjs';
import { restrictedHoldRefusal } from './restricted-hold-fence';

function emit(payload: Record<string, unknown>, exitCode: number): void {
  // The census opens a Postgres pool that would keep the event loop alive; exit explicitly, but
  // only after stdout has flushed — a pipe write is asynchronous, and the router parses this line.
  process.stdout.write(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify(payload)}\n`, () => process.exit(exitCode));
}

async function main(): Promise<void> {
  const [root, ...files] = process.argv.slice(2);
  if (!root) {
    emit(
      { verdict: 'refuse', error: 'restricted_hold_state_unknown', hint: 'restricted-hold preflight was started without a checkout root' },
      RESTRICTED_HOLD_PREFLIGHT_EXIT.misuse,
    );
    return;
  }
  const refusal = await restrictedHoldRefusal(root, files);
  if (refusal) emit({ verdict: 'refuse', ...refusal }, RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
  else emit({ verdict: 'admit' }, RESTRICTED_HOLD_PREFLIGHT_EXIT.admit);
}

main().catch((error: unknown) => {
  emit(
    {
      verdict: 'refuse',
      error: 'restricted_hold_state_unknown',
      hint: `restricted-hold preflight crashed; no test process was started (${error instanceof Error ? error.message : String(error)})`,
    },
    RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse,
  );
});
