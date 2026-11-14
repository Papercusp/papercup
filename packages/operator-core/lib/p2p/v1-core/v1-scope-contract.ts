/**
 * P2P v1 scope contract — p2p-v1-core-release-2026-11-13 P-001 (R-7, R-8), D-001.
 *
 * The single declaration of what P2P v1 ships and what it does not. Everything a v1
 * check needs to know about scope is read from HERE, never re-stated in the code under
 * test: the R-8 admission limit, the R-7 commerce roots, and the not-in-v1 list.
 *
 * "Release build" means a process launched with the P2P_V1_RELEASE_BUILD flag ON
 * (env `PAPERCUSP_FLAG_PAPERCUSP_P2P_V1_RELEASE_BUILD=1`). It is resolved synchronously
 * from the environment because the commerce guard runs at module-evaluation time,
 * before any override store could be consulted.
 *
 * Commerce exclusion (R-7). The money-movement ROOTS below call
 * `refuseCommerceLoadInV1ReleaseBuild` at the top of their module body, so in a release
 * build evaluating a root throws — and therefore so does evaluating any module that
 * statically imports one, directly or transitively. The derived population is not
 * hand-maintained here: the contract test re-derives it from the import graph and
 * asserts it equals `V1_COMMERCE_MODULES`, and that the importers outside lib/p2p are
 * exactly the closed `V1_COMMERCE_HOST_MODULES` island, so no boot-path module reaches
 * commerce statically. Boot-path callers reach commerce only through lazy `import()`.
 *
 * This module must stay free of commerce imports and safe to load in the webview.
 */
import { FLAGS, resolveFlagFromEnv, type FlagKey } from '@papercusp/flags';

/** The five things v1 does (D-001). */
export const V1_IN_SCOPE = ['join', 'replicate', 'catch-up', 'restart-identity', 'revoke'] as const;
export type V1InScopeCapability = (typeof V1_IN_SCOPE)[number];

export type V1NotInScopeCapabilityId =
  | 'git-bridge-live-flip'
  | 'delegated-seats'
  | 'protected-effect-fencing'
  | 'owner-recovery'
  | 'commerce'
  | 'above-limit-hive';

/** One entry of the not-in-v1 capability registry ({@link V1_NOT_IN_SCOPE}). */
export interface V1NotInScopeCapability {
  readonly id: V1NotInScopeCapabilityId;
  readonly title: string;
  /**
   * Flags that gate the capability. The release build locks each one OFF ahead of every
   * other flag source (`P2P_V1_RELEASE_BUILD_FORCED_OFF` in @papercusp/flags).
   */
  readonly flags: readonly FlagKey[];
  /**
   * Public activation and dispatch seams that refuse the capability in a release build, as
   * `<path relative to operator-core/lib>#<export>`. `#module` means loading the module is
   * refused. The seam test invokes every entry here and nothing else.
   */
  readonly seams: readonly string[];
}

/**
 * R-8: the v1 hive size limit N, in members. A join that would take a hive above N is
 * refused; an existing member reconnecting at N uses no slot. P-001 default (8 peers)
 * unless P-002 measurements support more; recorded as a plan Decision at completion.
 */
export const V1_HIVE_SIZE_LIMIT = 8;

/**
 * R-7 money-movement roots, as paths relative to packages/operator-core/lib: the modules
 * that open, fund, charge, settle on chain or hold money. p2p/revenue-settlement.ts is
 * deliberately NOT a root: it is a pure split calculator with no I/O (only node:crypto
 * and canonical JSON), which identity offers use for split validation; every root that
 * settles money (evm-settlement, treasury-controls) still imports it.
 */
export const V1_COMMERCE_ROOTS = [
  'p2p/channel-funding.ts',
  'p2p/evm-settlement.ts',
  'p2p/microcharge.ts',
  'p2p/payment-channel.ts',
  'p2p/treasury-controls.ts',
] as const;

/**
 * The not-in-v1 commerce list: every lib/p2p module that statically imports a root,
 * directly or transitively (roots included). The contract test derives this set from the
 * tree and fails when the two differ.
 */
export const V1_COMMERCE_MODULES = [
  'p2p/_payment-voucher-fixture.ts',
  'p2p/byoc-execution.ts',
  'p2p/channel-funding.ts',
  'p2p/delegated-spawn-honor.ts',
  'p2p/evm-settlement.ts',
  'p2p/metered-invocation.ts',
  'p2p/microcharge.ts',
  'p2p/onchain-governance-bridge.ts',
  'p2p/payment-channel.ts',
  'p2p/treasury-controls.ts',
  'p2p/two-peer-commerce/commerce-peer-child.ts',
  'p2p/two-peer-commerce/escrow-authority.ts',
  'p2p/two-peer-commerce/run-two-peer-commerce.ts',
] as const;

/**
 * Commerce modules outside lib/p2p that statically import the population. This island
 * must be CLOSED: nothing outside it (and outside V1_COMMERCE_MODULES) may statically
 * import any of its members, or a release-build boot would load commerce and crash.
 */
export const V1_COMMERCE_HOST_MODULES = [
  'cupboard/funded-tool-turn-store.ts',
  'cupboard/funded-turn-host.ts',
  'cupboard/funded-turn-store.ts',
  'cupboard/installed-tool-funding.ts',
  'cupboard/metered-invocation-door-io.ts',
  'cupboard/prepaid-credits.ts',
  'cupboard/seller-receipt-rpc.ts',
] as const;

/**
 * The not-in-v1 capability registry (D-001's exclusions plus R-8's above-limit hive): what
 * v1 does not ship, each with the flags the release build locks off and the seams that refuse
 * it. The release build disables exactly this set; the contract tests check that both ways.
 */
export const V1_NOT_IN_SCOPE: readonly V1NotInScopeCapability[] = [
  {
    id: 'git-bridge-live-flip',
    title: 'Git bridge live flip (hive P2P git <-> GitHub bridge)',
    flags: [FLAGS.GITHUB_BRIDGE],
    seams: ['harness/git-sync/hive-git-mode.ts#setPotGitMode'],
  },
  {
    id: 'delegated-seats',
    title: 'Delegated agent seats (remote owner spawns on this host)',
    flags: [FLAGS.ACCEPT_DELEGATED_SEATS],
    seams: ['p2p/accept-delegated-seats.ts#assertHostAcceptsDelegatedSeats', 'p2p/delegated-spawn-honor.ts#module'],
  },
  {
    id: 'protected-effect-fencing',
    title: 'Protected-effect fencing (owning-hive exclusive Git effects)',
    flags: [],
    seams: ['sync/pot-git/hive-effect-authority.ts#requireHiveEffectAuthority'],
  },
  {
    id: 'owner-recovery',
    title: 'Owner recovery (protected effects resume once owning-hive proof is restored)',
    flags: [],
    seams: ['sync/pot-git/hive-effect-authority.ts#loadHiveEffectAuthority'],
  },
  {
    id: 'commerce',
    title: 'Commerce modules (payments, settlement, treasury, metering charges)',
    flags: [],
    seams: V1_COMMERCE_ROOTS.map((root) => `${root}#module`),
  },
  {
    id: 'above-limit-hive',
    title: `Hives above ${V1_HIVE_SIZE_LIMIT} members (R-8)`,
    flags: [],
    seams: ['hive-membership-admission.ts#evaluateJoinAdmission'],
  },
];

export const V1_SCOPE_REFUSAL_CODE = 'not_in_v1' as const;

/** Thrown when a not-in-v1 capability is loaded or activated in a v1 release build. */
export class V1ScopeRefusal extends Error {
  readonly code = V1_SCOPE_REFUSAL_CODE;
  constructor(
    readonly capability: V1NotInScopeCapabilityId,
    readonly subject: string,
  ) {
    super(`${subject} is not in P2P v1 (${capability}); the v1 release build refuses it`);
    this.name = 'V1ScopeRefusal';
  }
}

type EnvMap = Readonly<Record<string, string | undefined>>;

function processEnv(): EnvMap {
  const proc = (globalThis as { process?: { env?: EnvMap } }).process;
  return proc?.env ?? {};
}

/** True when this process runs as the P2P v1 release build. */
export function isV1ReleaseBuild(env: EnvMap = processEnv()): boolean {
  return resolveFlagFromEnv(FLAGS.P2P_V1_RELEASE_BUILD, env).value === true;
}

/**
 * Called at the top of each commerce root's module body. In a release build it throws,
 * so the root — and every static importer of it — refuses to load.
 */
export function refuseCommerceLoadInV1ReleaseBuild(moduleId: string, env: EnvMap = processEnv()): void {
  if (isV1ReleaseBuild(env)) throw new V1ScopeRefusal('commerce', moduleId);
}

/** True when `error` (or anything in its `cause` chain) is a v1 scope refusal. */
export function isV1ScopeRefusal(error: unknown): error is V1ScopeRefusal {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof V1ScopeRefusal) return true;
    if ((e as { code?: unknown; name?: unknown }).code === V1_SCOPE_REFUSAL_CODE &&
        (e as { name?: unknown }).name === 'V1ScopeRefusal') return true;
  }
  return false;
}
