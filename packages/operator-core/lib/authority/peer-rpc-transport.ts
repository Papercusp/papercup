/**
 * peer-rpc-transport — the pluggable wire-leg for {@link routeToAuthority}.
 *
 * There is no peer-to-peer request/response RPC transport in the tree yet: the
 * Model-B Hyperswarm substrate REPLICATES append-only data (it is not a
 * request/response channel), `coord_event_log` is a PG table, and `loopbackFetch`
 * only reaches localhost. So routing to a *remote* lock authority has nothing to
 * call over today.
 *
 * Rather than block Track B on building a whole network stack, the remote leg is
 * a seam. The default transport reports every peer unreachable, which makes
 * {@link routeToAuthority} fail open — exactly the designed degradation (D-004:
 * git-merge is the data-safety backstop, so a missed serialization only costs
 * extra merge churn, never correctness).
 *
 * When a real transport lands — the natural candidates are (a) HTTP to the
 * authority peer's operator endpoint over the existing mesh/tunnel (mirroring the
 * lock hook's POST to `:3070`), or (b) an RPC channel multiplexed over the
 * Hyperswarm connection the substrate already holds open per harness — register
 * it once via {@link setPeerRpcTransport} and the remote path activates with zero
 * changes to callers.
 */

import type { PeerRef } from './lock-authority';

/** The request an authority RPC carries. */
export interface AuthorityRpcRequest {
  harnessSlug: string;
  kind: string;
  payload: unknown;
}

/** A transport that can deliver an authority RPC to a remote peer. */
export interface PeerRpcTransport {
  /**
   * Deliver `req` to `peer` (the resolved authority) and return its raw
   * response. MUST throw {@link PeerUnreachableError} when the peer cannot be
   * reached, so the caller fails open rather than blocking.
   */
  rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown>;
}

/** Thrown by a transport when the authority peer is unreachable → fail-open. */
export class PeerUnreachableError extends Error {
  constructor(message: string, readonly peer?: PeerRef) {
    super(message);
    this.name = 'PeerUnreachableError';
  }
}

/**
 * The default transport: no peer is reachable. Every call throws
 * {@link PeerUnreachableError}, so {@link routeToAuthority} always fails open
 * until a real transport is injected. This is the correct behavior on a single
 * box (there are no remote peers to route to anyway) and a safe default
 * cross-machine (git is the backstop).
 */
export const NULL_PEER_RPC_TRANSPORT: PeerRpcTransport = {
  async rpc(peer: PeerRef): Promise<never> {
    throw new PeerUnreachableError(
      'no peer RPC transport is registered — lock-authority routing fails open',
      peer,
    );
  },
};

let _transport: PeerRpcTransport | null = null;

/**
 * Register the peer RPC transport. Call once at boot when a real transport is
 * available. Passing `null` resets to the null transport (fail-open).
 */
export function setPeerRpcTransport(transport: PeerRpcTransport | null): void {
  _transport = transport;
}

/** The currently-registered transport, or the null (fail-open) transport. */
export function getPeerRpcTransport(): PeerRpcTransport {
  return _transport ?? NULL_PEER_RPC_TRANSPORT;
}

/** Test-only: reset the registered transport. */
export function __resetPeerRpcTransportForTests(): void {
  _transport = null;
}
