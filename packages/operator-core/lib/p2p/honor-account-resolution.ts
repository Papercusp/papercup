/**
 * p2p/honor-account-resolution.ts — HONOR-TIME account routing resolution (WI-5316).
 *
 * A delegated seat carries a gateway account SELECTION authored on the DELEGATING
 * host — `AUTO` (route through the inference gateway), a pinned pool id, or the
 * direct system login. `seatLaunchOpts` maps `AUTO`→`'auto'`, so an AUTO seat
 * reaches the member launch as `--account=auto`. But whether `auto` is
 * FULFILLABLE depends on the HONORING host: psu (correctly) refuses `--account=auto`
 * when this box's inference-gateway pool has no registered account —
 *   `--account auto could not be honored: ... Refusing to fall back to the default system login.`
 * — and the member dies silently (the honor path only saw a Terminal "open"; WI-5306
 * is the sibling binary-missing case). Observed live on the mac rig: its gateway
 * ran local-fallback (empty pool) but it HAD a valid local `claude` login, and the
 * IDENTICAL command with `--account=default` booted cleanly.
 *
 * The delegating host cannot know the honoring host's pool state, so account
 * routing must be RE-RESOLVED at honor time against THIS host's reality:
 *   - `default` (direct system login) is always fulfillable — psu skips the gateway.
 *   - `auto` needs ≥1 registered claude pool account on this host; with an empty
 *     pool it is unfulfillable, so downgrade to `default` when a local login exists
 *     (the proven workaround), else REFUSE with a federated receipt.
 *   - a PIN to a specific pool id needs that id present in this host's pool; absent,
 *     it cannot be silently substituted — REFUSE (the requester asked for a
 *     specific account).
 *
 * PURE core (`resolveHonorAccount`) + injectable I/O so it unit-tests without
 * PG/fs. The delegated-spawn honor path wires the real pool loader + local-login
 * check and calls this as Gate 4.6 (after the WI-5306 runtime probe, before the
 * atomic claim).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Classify a `--account` value into its routing MODE. A faithful mirror of
 * psu-launcher's `accountRoutingMode` (apps/operator/scripts/psu-launcher.mjs) —
 * kept as a tiny local copy because the launcher is a `.mjs` outside the
 * operator-core type graph; the honor-time resolution MUST agree with what psu
 * will actually do at member boot, so a drift here is a regression (guarded by a
 * unit test that pins the exact cases).
 */
export function honorAccountRoutingMode(value: string | null | undefined): 'default' | 'auto' | 'pin' {
  const v = (value == null ? '' : String(value)).trim().toLowerCase();
  if (v === '' || v === 'default' || v === 'none' || v === 'system') return 'default';
  if (v === 'auto' || v === 'gateway') return 'auto';
  return 'pin';
}

/**
 * Best-effort: does THIS host have a usable local `claude` login for the
 * `--account=default` (direct system credential) route? Pure-ish + injectable.
 *
 * Linux/WSL: the `~/.claude/.credentials.json` bundle must exist. macOS: the live
 * login is the Keychain item, NOT the disk bundle (a `~/.claude/.credentials.json`
 * on a Mac is typically a stale one-time snapshot — see
 * inference-gateway/account-resolver `localLoginCredentialRef`), and probing the
 * Keychain non-interactively from a background operator is unreliable (it can
 * prompt or fail), so we ASSUME present — the Keychain login is the macOS member
 * design default. Worst case the downgrade lands on `default` and psu/claude
 * surfaces a login error, which is strictly better than the current silent dead
 * member and never worse than not downgrading at all.
 */
export function localClaudeLoginPresent(opts?: {
  platform?: NodeJS.Platform;
  home?: string;
  fileExists?: (p: string) => boolean;
}): boolean {
  const platform = opts?.platform ?? process.platform;
  if (platform === 'darwin') return true;
  const home = opts?.home ?? homedir();
  const fileExists = opts?.fileExists ?? existsSync;
  return fileExists(join(home, '.claude', '.credentials.json'));
}

export type HonorAccountResolution =
  | { ok: true; account: string; downgradedFrom?: 'auto'; note?: string }
  | { ok: false; code: 'account_unfulfillable'; detail: string };

export interface ResolveHonorAccountDeps {
  /** The claude pool account ids REGISTERED on this host (excludes the `local`
   *  fallback — an empty list means psu's gateway auto/pin route is unfulfillable). */
  listPoolAccountIds: () => Promise<string[]>;
  /** Whether a direct-login (`--account=default`) route is usable on this host. */
  localLoginPresent: () => boolean;
}

/**
 * PURE (given the injected I/O): resolve the account this host should actually
 * launch the delegated member with, or refuse if unfulfillable.
 */
export async function resolveHonorAccount(
  requestedAccount: string | null | undefined,
  deps: ResolveHonorAccountDeps,
): Promise<HonorAccountResolution> {
  const mode = honorAccountRoutingMode(requestedAccount);

  // `default` skips the gateway and uses the box's own login — always fulfillable
  // at the routing layer (a genuinely logged-out box is a separate, rare failure
  // psu surfaces at boot; it never REFUSES the default route the way it refuses auto/pin).
  if (mode === 'default') return { ok: true, account: 'default' };

  if (mode === 'auto') {
    const ids = await deps.listPoolAccountIds();
    if (ids.length > 0) return { ok: true, account: 'auto' };
    // Empty pool ⇒ psu will refuse `--account=auto` at boot. Downgrade to the
    // direct login when one exists (the live-proven workaround); else refuse LOUDLY.
    if (deps.localLoginPresent()) {
      return {
        ok: true,
        account: 'default',
        downgradedFrom: 'auto',
        note:
          "downgraded --account=auto → default: this host has no registered claude pool account (gateway would refuse auto), " +
          'using the local system login instead',
      };
    }
    return {
      ok: false,
      code: 'account_unfulfillable',
      detail:
        "seat requests --account=auto but this host has no registered claude pool account AND no usable local login — " +
        'the member cannot authenticate. Seed this host\'s gateway pool (accounts:register) or delegate a seat pinned to an account this host has.',
    };
  }

  // mode === 'pin' — a specific pool account. It cannot be silently substituted.
  const wanted = String(requestedAccount).trim();
  const ids = await deps.listPoolAccountIds();
  if (ids.includes(wanted)) return { ok: true, account: wanted };
  return {
    ok: false,
    code: 'account_unfulfillable',
    detail:
      `seat pins --account=${wanted} but that account is not in this host's claude pool ` +
      `(${ids.length ? `available: ${ids.join(', ')}` : 'pool is empty'}). A pinned account cannot be substituted — ` +
      'register it on this host or delegate a seat this host can fulfill.',
  };
}
