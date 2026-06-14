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
import { loadAccountPool } from '../deployment/account-pool-store';
import { accountByCredentialRef } from '../deployment/account-pool';

export interface ResolvedAccount {
  accountId: string;
  credentialRef: string;
  /** How it was resolved (for /healthz + logs). */
  source: 'env' | 'sole-pool-account' | 'local-fallback';
}

export async function resolveBoundAccount(ws?: string): Promise<ResolvedAccount> {
  const pool = await loadAccountPool(ws).catch(() => ({ accounts: [] as never[] }));
  const wanted = process.env.PAPERCUSP_ACCOUNT_ID?.trim();
  if (wanted) {
    const acct = pool.accounts.find((a) => a.id === wanted);
    if (acct) return { accountId: acct.id, credentialRef: acct.credentialRef, source: 'env' };
    throw new Error(`inference-gateway: PAPERCUSP_ACCOUNT_ID='${wanted}' not in the account pool`);
  }
  if (pool.accounts.length === 1) {
    const a = pool.accounts[0];
    return { accountId: a.id, credentialRef: a.credentialRef, source: 'sole-pool-account' };
  }
  // No env pin and 0 or >1 pool accounts → the box's own login. (>1 with no pin is ambiguous;
  // the local login is the safe, explicit default rather than guessing which pool account.)
  const localBundle = join(homedir(), '.claude', '.credentials.json');
  return { accountId: 'local', credentialRef: `file:${localBundle}`, source: 'local-fallback' };
}

/**
 * Resolve the FULL ordered account pool the gateway fails over across (EI-535) — the multi-account
 * generalization of resolveBoundAccount. `PAPERCUSP_ACCOUNT_ID` (if set + valid) is the PRIMARY
 * (index 0) and the remaining pool accounts follow as failover targets; with no pin, all pool
 * accounts in pool order; with an empty pool, the box's local login bundle as a single account.
 * Unlike resolveBoundAccount, a >1-account pool with no pin is NOT ambiguous here — the whole point
 * is to use them all, primary = pool order.
 */
export async function resolveAccountPool(ws?: string): Promise<ResolvedAccount[]> {
  const pool = await loadAccountPool(ws).catch(() => ({ accounts: [] as never[] }));
  const all: ResolvedAccount[] = pool.accounts.map((a) => ({
    accountId: a.id,
    credentialRef: a.credentialRef,
    source: 'sole-pool-account' as const,
  }));
  if (all.length === 0) {
    const localBundle = join(homedir(), '.claude', '.credentials.json');
    return [{ accountId: 'local', credentialRef: `file:${localBundle}`, source: 'local-fallback' }];
  }
  const wanted = process.env.PAPERCUSP_ACCOUNT_ID?.trim();
  if (wanted) {
    const idx = all.findIndex((a) => a.id === wanted);
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
