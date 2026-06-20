/**
 * Build the per-account egress undici dispatcher (per-account IP routing — D-003 / B-GW-3).
 *
 * Single source of truth for "given an AccountEgress, what undici Dispatcher routes this account's
 * upstream through its OWN IP". Two consumers:
 *   - the inference gateway's `dispatcherFor` (the live egress chokepoint), and
 *   - `accounts:test-egress` / the egress-probe (the clean-IP gate) — so the gate verifies the EXACT
 *     dispatcher the gateway would use, never a divergent copy.
 *
 * undici's `ProxyAgent` is an HTTP-CONNECT proxy client — it does NOT speak SOCKS. A `socks://` (or
 * any non-http(s)) `proxyUrl` CONSTRUCTS without error but fails at REQUEST time (the proxy rejects
 * the HTTP CONNECT), which would silently 502 every request for that account. So honor only http(s)
 * proxies; a non-http(s) scheme is IGNORED (it falls through to a bound source IP if set, else the
 * default shared egress) and surfaced via `ignoredProxyUrl` so the caller can warn. Native SOCKS
 * egress is a tracked follow-up (WI-284).
 *
 * NOTE (convergence): the gateway's `dispatcherFor` still inlines this logic + a per-account cache;
 * it should adopt this helper so the two never drift (coordinated with the B-HOT-2 dispatcher-close
 * work). This module is the canonical version.
 */
import type { AccountEgress } from '../deployment/account-pool';

type UndiciDispatcher = import('undici').Dispatcher;
type UndiciModule = typeof import('undici');

export interface EgressDispatcherResult {
  /** The dispatcher to attach to fetch's `dispatcher` option; undefined ⇒ default shared egress. */
  dispatcher?: UndiciDispatcher;
  /** The http(s) proxy URL actually honored (undefined when none / a non-http(s) scheme was ignored). */
  httpProxy?: string;
  /** The bound source IP actually used (undefined when a proxy was used / none). */
  localAddress?: string;
  /** A non-http(s) proxyUrl that was IGNORED (e.g. `socks5://…`) — caller should warn. */
  ignoredProxyUrl?: string;
}

let cachedUndici: UndiciModule | undefined;

/** True iff `proxyUrl` is an http(s) forward proxy undici's ProxyAgent can route through. */
export function egressIsHttpProxy(proxyUrl: string | undefined): boolean {
  return !!proxyUrl && /^https?:\/\//i.test(proxyUrl);
}

/** A stable per-account dispatcher cache key (matches the gateway's `accountId|proxyUrl|localAddress`). */
export function egressCacheKey(accountId: string, egress: AccountEgress | undefined): string {
  const httpProxy = egressIsHttpProxy(egress?.proxyUrl) ? egress!.proxyUrl : '';
  return `${accountId}|${httpProxy ?? ''}|${egress?.localAddress ?? ''}`;
}

/**
 * Build (without caching — callers cache) the undici dispatcher for an egress config. Returns
 * `{ dispatcher: undefined }` when the egress is absent or only a non-http(s) proxy was given (→
 * default shared egress, with `ignoredProxyUrl` set). `importUndici` is injectable for tests.
 */
export async function buildEgressDispatcher(
  egress: AccountEgress | undefined,
  deps: { importUndici?: () => Promise<UndiciModule> } = {},
): Promise<EgressDispatcherResult> {
  if (!egress || (!egress.proxyUrl && !egress.localAddress)) return {};
  const httpProxy = egressIsHttpProxy(egress.proxyUrl) ? egress.proxyUrl : undefined;
  const ignoredProxyUrl = egress.proxyUrl && !httpProxy ? egress.proxyUrl : undefined;
  if (!httpProxy && !egress.localAddress) return { ignoredProxyUrl };
  const mod = deps.importUndici ? await deps.importUndici() : (cachedUndici ??= await import('undici'));
  const dispatcher: UndiciDispatcher = httpProxy
    ? new mod.ProxyAgent(httpProxy)
    : new mod.Agent({ connect: { localAddress: egress.localAddress } });
  return {
    dispatcher,
    httpProxy,
    localAddress: httpProxy ? undefined : egress.localAddress,
    ignoredProxyUrl,
  };
}
