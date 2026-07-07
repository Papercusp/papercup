/**
 * Resolve the account this MACHINE's bees should egress through (hive-inference-gateway P-006/P-012).
 *
 * Resolution order (first match wins):
 *   1. `PAPERCUSP_ACCOUNT_ID` names a registered pool account → use its credentialRef.
 *   2. The pool has exactly one account → use it (the common single-account case, Q1).
 *   3. Fall back to the box's own login bundle (`~/.claude/.credentials.json`) as account
 *      `local` — so the gateway is runnable on a dev box with no pool account registered yet.
 *
 * The gateway holds the resolved account for its lifetime (one machine = one bound account at a
 * time); a rebind is a gateway restart (the supervised service, P-013). Account-pool's per-deploy
 * binding + scale-out (P-017) operate at the pool level above this.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_KEYCHAIN_SERVICES } from '../agent-auth-detect';
import { loadAccountPool } from '../deployment/account-pool-store';
import {
  accountByCredentialRef,
  type AccountEgress,
  type AccountPool,
  type AccountProvider,
} from '../deployment/account-pool';

export interface ResolvedAccount {
  accountId: string;
  credentialRef: string;
  /** How it was resolved (for /healthz + logs). `pool` = one entry of a multi-account pool;
   *  `sole-pool-account` = the single registered account; `env` = the PAPERCUSP_ACCOUNT_ID pin;
   *  `local-fallback` = the box's own login (no accounts registered). */
  source: 'env' | 'pool' | 'sole-pool-account' | 'local-fallback';
  /** Per-account upstream egress (per-account IP routing). Absent ⇒ default shared egress.
   *  Singular/legacy — superseded by a non-empty `egressPool`. */
  egress?: AccountEgress;
  /** Per-account egress IP POOL (rotating list) — gateway-per-account-egress-ip-pool-2026-06-30.
   *  When set, the gateway rotates this account's upstream across these IPs. Absent ⇒ singular `egress`. */
  egressPool?: AccountEgress[];
}

/**
 * Load the account pool, retrying a TRANSIENT read error (a PG blip) a few times, then THROWING.
 *
 * This is the fix for the silent-`local`-fallback fault: the gateway holds its resolved pool for its
 * whole lifetime, so a single swallowed read error used to collapse routing to the box's `local`
 * credential for hours — every `x-papercusp-account` pin silently ignored, all usage landing on the
 * wrong account. A THROW here fails the supervised gateway CLOSED (bin.ts → exit 1 → systemd
 * Restart=always), so it retries against a healthy DB instead of caching a wrong one-account pool.
 *
 * Crucially distinct from a genuinely EMPTY pool (a fresh box with no accounts registered):
 * loadAccountPool RESOLVES `{accounts:[]}` without throwing, which the callers still treat as the
 * legitimate `local` fallback. Only a read FAILURE fails closed.
 */
const POOL_LOAD_ATTEMPTS = 3;
const POOL_LOAD_BACKOFF_MS = 150;

async function loadPoolOrThrow(ws?: string): Promise<AccountPool> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= POOL_LOAD_ATTEMPTS; attempt++) {
    try {
      return await loadAccountPool(ws);
    } catch (e) {
      lastErr = e;
      if (attempt < POOL_LOAD_ATTEMPTS) {
        await new Promise<void>((r) => setTimeout(r, POOL_LOAD_BACKOFF_MS * attempt));
      }
    }
  }
  throw new Error(
    `inference-gateway: account-pool load failed after ${POOL_LOAD_ATTEMPTS} attempts ` +
      `(${(lastErr as Error)?.message ?? String(lastErr)}); failing closed rather than silently ` +
      `collapsing to the local credential and ignoring every account pin — the supervised gateway will retry`,
  );
}

function accountsFor(pool: AccountPool, provider: AccountProvider) {
  return pool.accounts.filter((a) => (a.provider === 'codex' ? 'codex' : 'claude') === provider);
}

/**
 * The credentialRef for the box's own Claude login (the `local` fallback account) — pure +
 * injectable for tests. Linux/WSL: the `~/.claude/.credentials.json` bundle. macOS: ALWAYS the
 * `keychain:` channel — credential-store's freshest-scan across the base Keychain item, every
 * per-CLAUDE_CONFIG_DIR sibling AND the disk bundle. A `~/.claude/.credentials.json` on a Mac is
 * typically a stale one-time snapshot whose refresh token a later rotation consumed — letting it
 * SHADOW the live Keychain bundles is the 2026-07-06 fleet-member "not logged in" root cause, so
 * it participates in the scan instead of preempting it.
 */
export function localLoginCredentialRef(opts?: {
  platform?: NodeJS.Platform;
  home?: string;
}): string {
  const platform = opts?.platform ?? process.platform;
  if (platform === 'darwin') return `keychain:${CLAUDE_KEYCHAIN_SERVICES[0]}`;
  const home = opts?.home ?? homedir();
  return `file:${join(home, '.claude', '.credentials.json')}`;
}

export async function resolveBoundAccount(ws?: string): Promise<ResolvedAccount> {
  const pool = await loadPoolOrThrow(ws);
  const accounts = accountsFor(pool, 'claude');
  const wanted = process.env.PAPERCUSP_ACCOUNT_ID?.trim();
  if (wanted) {
    const acct = accounts.find((a) => a.id === wanted);
    if (acct) return { accountId: acct.id, credentialRef: acct.credentialRef, egress: acct.egress, egressPool: acct.egressPool, source: 'env' };
    throw new Error(`inference-gateway: PAPERCUSP_ACCOUNT_ID='${wanted}' not in the account pool`);
  }
  if (accounts.length === 1) {
    const a = accounts[0];
    return { accountId: a.id, credentialRef: a.credentialRef, egress: a.egress, egressPool: a.egressPool, source: 'sole-pool-account' };
  }
  // No env pin and 0 or >1 pool accounts → the box's own login. (>1 with no pin is ambiguous;
  // the local login is the safe, explicit default rather than guessing which pool account.)
  return { accountId: 'local', credentialRef: localLoginCredentialRef(), source: 'local-fallback' };
}

/**
 * Resolve the FULL ordered account pool the gateway fails over across (EI-535) — the multi-account
 * generalization of resolveBoundAccount. `PAPERCUSP_ACCOUNT_ID` (if set + valid) is the PRIMARY
 * (index 0) and the remaining pool accounts follow as failover targets; with no pin, all pool
 * accounts in pool order; with an empty pool, the box's local login bundle as a single account.
 * Unlike resolveBoundAccount, a >1-account pool with no pin is NOT ambiguous here — the whole point
 * is to use them all, primary = pool order.
 */
export async function resolveAccountPool(ws?: string, provider: AccountProvider = 'claude'): Promise<ResolvedAccount[]> {
  const pool = await loadPoolOrThrow(ws);
  const accounts = accountsFor(pool, provider);
  const all: ResolvedAccount[] = accounts.map((a) => ({
    accountId: a.id,
    credentialRef: a.credentialRef,
    egress: a.egress,
    egressPool: a.egressPool,
    source: 'pool' as const,
  }));
  if (all.length === 0 && provider === 'claude') {
    return [{ accountId: 'local', credentialRef: localLoginCredentialRef(), source: 'local-fallback' }];
  }
  if (all.length === 0) {
    return [];
  }
  const wanted = process.env.PAPERCUSP_ACCOUNT_ID?.trim();
  if (wanted) {
    const idx = all.findIndex((a) => a.accountId === wanted);
    if (idx < 0) throw new Error(`inference-gateway: PAPERCUSP_ACCOUNT_ID='${wanted}' not in the account pool`);
    const [primary] = all.splice(idx, 1);
    return [{ ...primary, source: 'env' }, ...all];
  }
  return all;
}

/** The reverse lookup the pool-projection bridge uses to attribute a pause to an account id. */
export function poolAccountIdForRef(
  pool: { accounts: { id: string; credentialRef: string }[] },
  credentialRef: string,
): string | undefined {
  return accountByCredentialRef(pool as never, credentialRef)?.id;
}
