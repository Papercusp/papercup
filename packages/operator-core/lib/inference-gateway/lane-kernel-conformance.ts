/**
 * P-008 — the strangler surface is a SHRINK-ONLY ratchet, so the per-lane duplication
 * the kernel adoption removed cannot grow back while the remaining users burn down.
 *
 * WHY THIS IS A RATCHET AND NOT A DELETION CHECK (D-021). P-008's original text expected
 * that once every lane's inner attempt ladder ran on `executeGatewayRequestKernel`, the
 * strangler scaffolding could simply be deleted. It cannot: `executeLegacyLaneTask` is
 * still the gateway's ONLY admission crossing. Five of the six `executeGatewayRequestKernel`
 * call sites in gateway.ts pass a no-op admission (`run: (_context, task) => task()`), four
 * of them naming this scaffolding as the reason ("already runs inside executeLegacyLaneTask's
 * Governor.admit, so re-admitting would deadlock on its own slot"). Deleting the bridge today
 * would remove gateway queueing altogether — no priority, no tier, no provider-storm
 * backpressure. So this guard encodes the CURRENT truth (every lane is bridge-admitted) and
 * makes that set unable to grow, rather than asserting a post-re-homing end state that is not
 * true yet.
 *
 * THE BURN-DOWN. Re-homing moves a lane's admission crossing onto the kernel's own admission
 * controller — the lane flips from "no-op admission inside, real admission outside" to "real
 * admission inside". As each lane flips, its `legacyEntryExecutor` goes away and its entry
 * leaves `LANES_ADMITTED_VIA_LEGACY_BRIDGE`. When the allowlist is EMPTY, the scaffolding
 * (`GatewayLegacyExecutorId`, `legacyGatewayEntryExecutors`, `executeLegacyLaneTask`,
 * `executeGatewayLegacyLane`) is mechanically deletable and this module goes with it.
 *
 * The allowlist is therefore a burn-down counter, not a parking lot: an entry may only ever
 * be REMOVED. Adding one means a newly registered lane took the legacy bridge instead of the
 * kernel's admission, which is precisely the regrowth P-008 exists to prevent.
 */

import type { GatewayLaneDescriptor, GatewayLaneRegistry } from './provider-adapters';

export const GATEWAY_LANE_KERNEL_CONFORMANCE_SCHEMA_VERSION = 'gateway-lane-kernel-conformance-v1';

export type GatewayLaneId = GatewayLaneDescriptor['id'];

/**
 * Lanes whose admission still crosses `executeLegacyLaneTask` rather than the kernel's own
 * admission controller. SHRINK-ONLY (D-021) — remove an entry when that lane's re-homing
 * lands; never add one.
 *
 * Measured 2026-08-30, AFTER the first re-homing (P-011 / D-022): TWO of the three registered
 * lanes still declare a `legacyEntryExecutor` (`anthropic-messages` -> `proxy`,
 * `openai-responses` -> `proxyOpenAi`); `local-openai-chat` declares none and is off the
 * bridge. gateway.ts holds two `executeLegacyLaneTask(` call sites and three
 * `legacyGatewayEntryExecutors[` index sites, both re-seeded from a measuring run of the
 * counters below — never by hand, and only ever downward.
 */
export const LANES_ADMITTED_VIA_LEGACY_BRIDGE: readonly GatewayLaneId[] = [
  'anthropic-messages',
  'openai-responses',
  // 'local-openai-chat' RETIRED 2026-08-30 (P-011 / D-022) — first lane re-homed. It is now
  // entered directly through `withDurableGatewayAdmission` + `proxyLocal` and declares no
  // `legacyEntryExecutor`, so rule 2 below would FAIL on this entry had it been left here.
];

/**
 * Source-surface counts that must never grow. These are deliberately COUNTS rather than a
 * parse of which lane each call site serves: the call sites reach their lane through several
 * different expressions (`gatewayLaneRegistry.localOpenAiChat`, `providerAdapters.codex.lane`,
 * `providerAdapter.lane`), so a count is the honest, non-fragile signal. Which LANES are
 * bridge-admitted is derived from the registry instead, which is real data.
 *
 * Re-seed these ONLY from a measuring run (`scanGatewayLaneKernelConformance` reports the
 * observed value in every finding), and only ever downward.
 */
export const LEGACY_STRANGLER_SURFACE_BASELINE = {
  /** `executeLegacyLaneTask(` invocations in gateway.ts, excluding its own declaration. */
  executeLegacyLaneTaskCallSites: 2,
  /** `legacyGatewayEntryExecutors[` indexing sites in gateway.ts. */
  legacyEntryExecutorIndexSites: 3,
} as const;

export type LegacyStranglerSurfaceBaseline = typeof LEGACY_STRANGLER_SURFACE_BASELINE;

export interface LaneKernelConformanceSourceFile {
  path: string;
  source: string;
}

export interface ScanGatewayLaneKernelConformanceOptions {
  /** Override the allowlist (tests + falsifiability controls). */
  allowlist?: readonly GatewayLaneId[];
  /** Override the source-surface baseline (tests + falsifiability controls). */
  baseline?: LegacyStranglerSurfaceBaseline;
}

/** The gateway source file whose strangler surface is counted. */
export const GATEWAY_STRANGLER_SURFACE_FILE = 'packages/operator-core/lib/inference-gateway/gateway.ts';

/**
 * Count real invocations of `executeLegacyLaneTask`, excluding its own declaration.
 * Comment mentions are excluded by requiring the call to not be preceded by `//` or `*` on
 * the same line, which is what the surrounding prose in gateway.ts actually looks like.
 */
export function countExecuteLegacyLaneTaskCallSites(source: string): number {
  let count = 0;
  for (const rawLine of source.split('\n')) {
    if (!rawLine.includes('executeLegacyLaneTask(')) continue;
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (/function\s+executeLegacyLaneTask\s*\(/.test(line)) continue;
    count += 1;
  }
  return count;
}

/** Count `legacyGatewayEntryExecutors[` indexing sites, excluding comment prose. */
export function countLegacyEntryExecutorIndexSites(source: string): number {
  let count = 0;
  for (const rawLine of source.split('\n')) {
    if (!rawLine.includes('legacyGatewayEntryExecutors[')) continue;
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    count += 1;
  }
  return count;
}

/**
 * The guard. Returns an EMPTY array when conformant; every finding is a string naming the
 * offending subject and, where it is a count, both the observed and permitted values.
 *
 * `files` is optional so the registry half can be asserted without reading the tree; when the
 * gateway source is supplied, the source-surface ratchet is checked too.
 */
export function scanGatewayLaneKernelConformance(
  registry: GatewayLaneRegistry,
  files: readonly LaneKernelConformanceSourceFile[] = [],
  options: ScanGatewayLaneKernelConformanceOptions = {},
): string[] {
  const allowlist = options.allowlist ?? LANES_ADMITTED_VIA_LEGACY_BRIDGE;
  const baseline = options.baseline ?? LEGACY_STRANGLER_SURFACE_BASELINE;
  const findings: string[] = [];

  const allowed = new Set<string>(allowlist);
  const lanes = Object.values(registry) as GatewayLaneDescriptor[];

  // 1. REGROWTH: a registered lane taking the legacy bridge without being on the allowlist.
  //    `legacyEntryExecutor` is the declaration that it crosses admission via the bridge, so
  //    a lane that still carries one and is not allowlisted is new duplication.
  const bridgeAdmitted = new Set<string>();
  for (const lane of lanes) {
    if (!lane.legacyEntryExecutor) continue;
    bridgeAdmitted.add(lane.id);
    if (!allowed.has(lane.id)) {
      findings.push(`lane-admitted-outside-kernel:${lane.id}:${lane.legacyEntryExecutor}`);
    }
  }

  // 2. STALENESS: an allowlist entry whose lane has been re-homed (or removed) must be
  //    deleted, or the ratchet silently stops shrinking and the end state is never reached.
  for (const laneId of allowlist) {
    if (!bridgeAdmitted.has(laneId)) {
      findings.push(`allowlist-entry-retired:${laneId}`);
    }
  }

  // 3. SOURCE SURFACE: the bridge's call-site count may fall, never rise.
  for (const file of files) {
    if (file.path !== GATEWAY_STRANGLER_SURFACE_FILE) continue;
    const callSites = countExecuteLegacyLaneTaskCallSites(file.source);
    if (callSites > baseline.executeLegacyLaneTaskCallSites) {
      findings.push(
        `strangler-surface-grew:executeLegacyLaneTaskCallSites:${callSites}:${baseline.executeLegacyLaneTaskCallSites}`,
      );
    }
    const indexSites = countLegacyEntryExecutorIndexSites(file.source);
    if (indexSites > baseline.legacyEntryExecutorIndexSites) {
      findings.push(
        `strangler-surface-grew:legacyEntryExecutorIndexSites:${indexSites}:${baseline.legacyEntryExecutorIndexSites}`,
      );
    }
  }

  return findings;
}

/**
 * True once every lane has been re-homed onto the kernel's own admission controller — the
 * point at which the strangler scaffolding becomes mechanically deletable (D-021).
 */
export function gatewayStranglerScaffoldingIsDeletable(registry: GatewayLaneRegistry): boolean {
  return (Object.values(registry) as GatewayLaneDescriptor[]).every((lane) => !lane.legacyEntryExecutor);
}
