/**
 * First-password-setup token (EI-347).
 *
 * `/auth/change-password` is `auth: 'loopback'` (not a strict session gate) so the
 * cookie-less desktop webview can reach it (EI-338). `changePassword()` is "safe"
 * against a caller who already HAS a password (it verifies `current` before
 * allowing a change) — but the freshly-seeded `default` user boots with
 * `password_hash = NULL`, and the current-password check is skipped entirely in
 * that state (`if (current_hash !== null)`). Any process that can reach the
 * loopback HTTP port — not just the legitimate desktop app — can therefore POST
 * `{current: null, next: "theirs"}` and permanently claim the unconfigured
 * account before the real owner ever sets a password. Loopback binding narrows
 * this to LOCAL callers, but "local process" and "the app's own operator" are not
 * the same trust boundary (a sibling process, a compromised script, another OS
 * user on a shared box, all reach 127.0.0.1 too).
 *
 * Fix (this item's own "correct-state sketch" option (b), the same pattern
 * Jupyter/Grafana use for first-run credential bootstrap): generate ONE random
 * token per process lifetime, print it to the operator's own console/log at
 * boot, and require it — in addition to the existing loopback+CSRF gates — on
 * any `/auth/change-password` call that targets a password-less account. A
 * caller with only network reachability to the loopback port cannot read the
 * operator's own log; a caller who genuinely owns/runs the process can. Once a
 * password is set the token stops mattering (current_hash is no longer null,
 * so the normal current-password check takes back over for that account) — no
 * separate invalidation/expiry is needed.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

let cachedToken: string | null = null;
let printed = false;

/** Test-only: force a fresh token + reset the "already printed" latch. */
export function __resetSetupTokenForTests(): void {
  cachedToken = null;
  printed = false;
}

/**
 * The process-lifetime setup token, generated lazily on first access (so a
 * process that never touches auth never pays the randomBytes call). Printed to
 * console exactly once per process, with a banner explaining what it's for and
 * how to use it — the ONLY place this token is ever surfaced. There is
 * deliberately no HTTP/IPC route that returns it: exposing it over the same
 * loopback surface it's meant to gate would defeat the whole point.
 */
export function getSetupToken(): string {
  if (cachedToken === null) {
    cachedToken = randomBytes(18).toString('base64url');
  }
  if (!printed) {
    printed = true;
    // Deliberate: this IS the delivery channel (EI-347) — the token is never served
    // over HTTP/IPC, only printed here for a local operator to read.
    console.log(
      '\n' +
        '================================================================\n' +
        '  Papercusp first-time setup code (needed to set your password):\n' +
        `    ${cachedToken}\n` +
        '  Paste this into Settings > User the first time you add a\n' +
        '  password. It is only required while the account has none.\n' +
        '================================================================\n',
    );
  }
  return cachedToken;
}

/** Timing-safe compare against the current setup token. `null`/empty never matches. */
export function verifySetupToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getSetupToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
