/**
 * file-lock-routing — the file-claim integration for the lock authority (Phase 2
 * steps 2 + 5 of distributed-coordination-shared-harness-2026-06-04).
 *
 * # Scope guard (D-009)
 *
 * ONLY file-claim / repo-root (`coordination_domain`) locks route to the
 * authority — those guard concurrent edits to the SHARED repo's files, the one
 * thing that genuinely needs cross-machine serialization. The NAMED-RESOURCE
 * locks (`dev-server`, `db-schema`, `shop`, `desktop-sidecar`,
 * `libs-papercusp-submodule`) guard MACHINE-LOCAL resources — each user runs
 * their own dev-server / embedded-pg — so they stay local and never call
 * through here. This module is deliberately import-free of the named-resource
 * lock paths.
 *
 * # Domain → harness is a seam
 *
 * A file lock is keyed by `coordination_domain` = the realpath of the repo root
 * (see ../agent-tools/locks/coordination-domain.ts). To pick the authority we
 * need the HARNESS that checkout belongs to. There is no per-harness id stored
 * alongside a lock today (D-009 notes this), so the domain→harness mapping is an
 * injectable resolver. Its default returns `null` (= "no federated harness for
 * this checkout") which routes the op LOCALLY — the correct, safe behavior on a
 * single box and for unmanaged repos. Wire the real registry mapping at boot via
 * {@link configureFileLockDomainResolver} and cross-machine routing engages.
 *
 * # Not wired into the live acquire hot path (yet)
 *
 * The lock hook fires `locks:acquire` on EVERY edit. On the single shared-PG dev
 * box the authority is always self, so wrapping the hot path would add a
 * `shared_presence` query per edit for zero functional change — a regression risk
 * on the fleet's most safety-critical path. So {@link routeFileLockOp} is the
 * ready, tested integration wrapper, but the acquire handler is NOT yet changed
 * to call it. The cutover (have `locks:acquire` route file-claim ops through this
 * wrapper) lights up when machines run separate embedded-pg and remote peers
 * appear in `shared_presence`; see the README.
 */

import {
  routeToAuthority,
  routeToAuthorityForHive,
  type AuthorityOp,
  type LockAuthorityDeps,
  type RouteResult,
} from './lock-authority';
import { hasRemotePeers, hasRemoteHivePeers, type RemotePeersCacheDeps } from './remote-peers-cache';

/** Resolve a `coordination_domain` (repo realpath) to its harness slug, or null. */
export type DomainToHarnessSlug = (domain: string) => string | null;

/** Resolve a harness slug to its home HIVE slug, or null when the harness is not a
 *  Hive member (P-009). When non-null, the file-lock authority is the HIVE's. */
export type HarnessToHiveSlug = (harnessSlug: string) => string | null;

let _domainResolver: DomainToHarnessSlug | null = null;
let _hiveResolver: HarnessToHiveSlug | null = null;

/**
 * Register the domain→harness resolver at boot. The operator wires this to its
 * harness registry (which knows each managed harness's checkout realpath). Until
 * registered, the default returns null → file-lock ops run locally.
 */
export function configureFileLockDomainResolver(fn: DomainToHarnessSlug | null): void {
  _domainResolver = fn;
}

/** The default resolver: no harness known for any domain → route locally. */
function defaultDomainToHarnessSlug(_domain: string): string | null {
  return null;
}

/** The currently-registered resolver, or the local-only default. */
export function getDomainToHarnessSlug(): DomainToHarnessSlug {
  return _domainResolver ?? defaultDomainToHarnessSlug;
}

/**
 * Register the harness→Hive resolver at boot (P-009). The operator wires it to its
 * harness registry (ProjectEntry.hive_slug — a member harness's home Hive). Until
 * registered, the default returns null → every harness uses HARNESS-scoped authority
 * (the pre-Hive behavior, unchanged).
 */
export function configureFileLockHiveResolver(fn: HarnessToHiveSlug | null): void {
  _hiveResolver = fn;
}

/** The default: no harness is a Hive member → harness-scoped authority. */
function defaultHarnessToHiveSlug(_harnessSlug: string): string | null {
  return null;
}

/** The currently-registered harness→Hive resolver, or the non-Hive default. */
export function getHarnessToHiveSlug(): HarnessToHiveSlug {
  return _hiveResolver ?? defaultHarnessToHiveSlug;
}

export interface FileLockRoutingDeps extends LockAuthorityDeps, RemotePeersCacheDeps {
  /** Override the domain→harness mapping (tests). */
  domainToHarnessSlug?: DomainToHarnessSlug;
  /** Override the harness→Hive mapping (tests). */
  harnessToHiveSlug?: HarnessToHiveSlug;
  /** Skip the cached remote-peers fast-path (tests / force authority routing). */
  skipRemotePeersFastPath?: boolean;
}

/**
 * Route a FILE-CLAIM lock operation (acquire/release/queue) to the authority for
 * the harness that owns `domain`.
 *
 * - Unknown / unmanaged domain (no federated harness) → run `op.local()`
 *   directly (`via:'local-authority'`).
 * - Otherwise delegate to {@link routeToAuthority}: local when we are the
 *   authority, RPC when a transport + remote envelope exist, else fail open.
 *
 * Named-resource locks MUST NOT call this — they are machine-local (D-009).
 */
export async function routeFileLockOp<T>(
  domain: string,
  op: AuthorityOp<T>,
  deps: FileLockRoutingDeps = {},
): Promise<RouteResult<T>> {
  const resolve = deps.domainToHarnessSlug ?? getDomainToHarnessSlug();
  const harnessSlug = resolve(domain);
  if (!harnessSlug) {
    // No federated harness for this checkout → there is no remote authority to
    // defer to. Run locally (single box / unmanaged repo).
    return { value: await op.local(), via: 'local-authority' };
  }

  // P-009: when this harness federates within a shared Hive, its file-claim locks
  // serialize at the HIVE's authority (one authority across all the Hive's Swarms),
  // not the harness's. Default resolver returns null → harness scope (unchanged).
  const hiveSlug = (deps.harnessToHiveSlug ?? getHarnessToHiveSlug())(harnessSlug);
  const scope: { kind: 'hive' | 'harness'; key: string } = hiveSlug
    ? { kind: 'hive', key: hiveSlug }
    : { kind: 'harness', key: harnessSlug };

  // Hot-path guard: when the scope has NO live remote peers (the common case — a
  // single box), skip authority resolution entirely and run locally. The answer is
  // cached (remote-peers-cache) so the per-edit lock hook pays a cached boolean, not
  // a shared_presence query. A stale "no peers" only costs a missed serialization
  // (fail-open, D-004) for up to the cache TTL after a peer appears.
  const hasPeers =
    scope.kind === 'hive' ? hasRemoteHivePeers(scope.key, deps) : hasRemotePeers(scope.key, deps);
  if (!deps.skipRemotePeersFastPath && !(await hasPeers)) {
    return { value: await op.local(), via: 'local-authority' };
  }

  return scope.kind === 'hive'
    ? routeToAuthorityForHive(scope.key, op, deps)
    : routeToAuthority(scope.key, op, deps);
}

export const _testing = { defaultDomainToHarnessSlug };
