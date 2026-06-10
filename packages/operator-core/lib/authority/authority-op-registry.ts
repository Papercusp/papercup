/**
 * authority-op-registry — the AUTHORITY (receiving) side of the lock-authority
 * RPC (Phase 2 of distributed-coordination-shared-harness-2026-06-04).
 *
 * When a peer routes a control op to a remote authority (routeToAuthority →
 * PeerRpcTransport), the authority's operator receives the {kind, payload}
 * envelope and must RUN the op against ITS local store (its own papercusp_su lock
 * store, or its claim store). This registry maps an op `kind` to the handler that
 * executes it locally. Producers register their handler at boot:
 *
 *   registerAuthorityOp('lock.acquire', async (payload, harness) => locks.acquire(payload));
 *   registerAuthorityOp('claim.lease',  async (payload, harness) => claims.lease(payload));
 *
 * `handleAuthorityRpc` is the pure dispatch the receiving endpoint wraps. Keeping
 * it pure (no HTTP) makes the whole remote leg testable over a loopback server
 * without the Hono host.
 *
 * SECURITY NOTE: a real cross-machine deployment must authenticate the caller
 * (the operator endpoints are bearer-gated + the mesh is authenticated) AND
 * re-verify that THIS machine is actually the elected authority for `harnessSlug`
 * before running the op (a peer could mis-route during a failover gap). The
 * `verifyIsAuthority` hook does the latter; pass it so the authority refuses ops
 * it shouldn't serialize.
 */

export interface AuthorityRpcEnvelope {
  harnessSlug: string;
  kind: string;
  payload: unknown;
}

/** A handler that executes one op kind locally on the authority. */
export type AuthorityOpHandler = (payload: unknown, harnessSlug: string) => Promise<unknown>;

const _handlers = new Map<string, AuthorityOpHandler>();

/** Register the handler for one op kind. Throws on a duplicate (a programming
 *  error — two producers claiming the same kind). */
export function registerAuthorityOp(kind: string, handler: AuthorityOpHandler): void {
  if (!kind) throw new Error('registerAuthorityOp: kind required');
  if (_handlers.has(kind)) throw new Error(`registerAuthorityOp: kind '${kind}' already registered`);
  _handlers.set(kind, handler);
}

/** The kinds currently registered (debug / tests). */
export function registeredAuthorityOpKinds(): string[] {
  return [..._handlers.keys()].sort();
}

/** Test-only: clear the registry. */
export function __resetAuthorityOpsForTests(): void {
  _handlers.clear();
}

export interface HandleAuthorityRpcResult {
  ok: boolean;
  result?: unknown;
  /** Set when ok is false — a machine-readable reason. */
  error?: 'unknown_kind' | 'not_authority' | 'handler_error';
  message?: string;
}

export interface HandleAuthorityRpcOpts {
  /** Re-verify THIS machine is the authority for the harness before running the
   *  op (refuses a mis-routed op during a failover gap). Default: allow. */
  verifyIsAuthority?: (harnessSlug: string) => Promise<boolean> | boolean;
  /**
   * Dispatch against these handlers instead of the process-global registry.
   * Lets a multi-instance rig (cross-machine E2E) give each simulated machine
   * its own handler set — a single process can only hold one global registry.
   */
  handlers?: Record<string, AuthorityOpHandler>;
}

/**
 * Dispatch one received RPC envelope to its registered handler. Pure (no HTTP) —
 * the receiving route/endpoint wraps this. Never throws: a handler error is
 * returned as `{ ok:false, error:'handler_error' }` so the transport surfaces a
 * clean result rather than a 500.
 */
export async function handleAuthorityRpc(
  env: AuthorityRpcEnvelope,
  opts: HandleAuthorityRpcOpts = {},
): Promise<HandleAuthorityRpcResult> {
  const handler = opts.handlers ? opts.handlers[env.kind] : _handlers.get(env.kind);
  if (!handler) return { ok: false, error: 'unknown_kind', message: `no handler for kind '${env.kind}'` };

  if (opts.verifyIsAuthority) {
    let isAuth = false;
    try {
      isAuth = await opts.verifyIsAuthority(env.harnessSlug);
    } catch {
      isAuth = false;
    }
    if (!isAuth) {
      return { ok: false, error: 'not_authority', message: `this machine is not the authority for harness '${env.harnessSlug}'` };
    }
  }

  try {
    const result = await handler(env.payload, env.harnessSlug);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: 'handler_error', message: err instanceof Error ? err.message : String(err) };
  }
}
