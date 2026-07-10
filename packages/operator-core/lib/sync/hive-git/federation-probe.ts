/**
 * federation-probe — self-verifying probe receipts (RC-1 style shape + pure
 * logic; fleet-reliability-verification-2026-07-10 P-010, WI-3812).
 *
 * Root lesson (2026-07-10 cause #10, `shared-pot-federation-diagnosis-toolkit`):
 * every prior ad-hoc "v2t" liveness probe (a hand-written marker value, e.g.
 * the `p059:v2t:wakeN-<agent>` convention) was UNSTAMPED — nothing forced it to
 * carry the keys required to prove it actually rode the real federation
 * pipeline, so "green" was unreachable by construction for ~6h and nothing said
 * so. This module makes a probe correct-by-construction: {@link stampProbe}
 * REFUSES loudly (a typed reason, never a silent no-op) unless the required
 * federation keys are present and the target harness is actually federated.
 *
 * THE SHAPE + PURE LOGIC ONLY — mirrors `results-receipt.ts`'s split
 * deliberately: persistence lives in `federation-probe-store.ts`, the agent
 * tools in `agent-tools/probe/*`. Keeping this module pure (no PG, no
 * ambient Date.now) means the stamping + refusal + verdict logic is fully
 * unit-testable without a database.
 *
 * The six named hops (capture -> drain -> replicate -> merge -> member_guard
 * -> project) mirror the real content pipeline documented in
 * `capture-coverage.ts` (capture/drain) and the admission model in
 * `shared-pot-federation-diagnosis-toolkit.mdx` (replicate/merge/member_guard/
 * project). `probe:emit` always stamps `captured` itself (a probe only ever
 * exists once captured); later hops are recorded via `probe:record-hop` as the
 * pipeline stages that observe the probe op report in — the EXTENSION SEAM for
 * P-012 (named-hop pipeline observability) to wire up per-stage, and for P-011
 * (gate canaries) to build on. {@link deriveProbeVerdict} is what lets a
 * consumer say a probe failure NAMES ITS HOP instead of just "still red".
 */

export const PROBE_HOPS = [
  'captured',
  'drained',
  'replicated',
  'merged',
  'memberGuard',
  'projected',
] as const;

export type ProbeHop = (typeof PROBE_HOPS)[number];

/** Column name each hop stamps in `harness_shared.federation_probes`. */
export const PROBE_HOP_COLUMN: Readonly<Record<ProbeHop, string>> = {
  captured: 'captured_at',
  drained: 'drained_at',
  replicated: 'replicated_at',
  merged: 'merged_at',
  memberGuard: 'member_guard_at',
  projected: 'projected_at',
};

/** Why `probe:emit` refused to stamp a probe — never a silent no-op (P-010). */
export type ProbeRefusalReason =
  | 'missing_workspace'
  | 'missing_harness_slug'
  | 'invalid_harness_slug'
  | 'harness_not_federated'
  | 'missing_emitted_by';

export const PROBE_REFUSAL_DETAIL: Readonly<Record<ProbeRefusalReason, string>> = {
  missing_workspace:
    'no resolvable workspaceId — a probe cannot be stamped without knowing which workspace it belongs to',
  missing_harness_slug: 'harnessSlug is required — an unstamped probe is exactly the cause-#10 defect',
  invalid_harness_slug: "harnessSlug must not be '*' or empty — that is a scope selector, not a concrete harness",
  harness_not_federated:
    'this harness has no federation/registry entry (isRegisteredHive=false) — a probe emitted against it can never leave this box, so it would silently prove nothing',
  missing_emitted_by: 'no resolvable agent identity (emittedBy) to attribute the probe to',
};

export interface ProbeStampInput {
  workspaceId: string | null | undefined;
  harnessSlug: string | null | undefined;
  emittedBy: string | null | undefined;
  /** Resolved by the caller (async registry check) — kept out of this pure module. */
  harnessIsFederated: boolean;
  nowMs: number;
  /** Injected randomness seam for deterministic tests. Default Math.random. */
  random?: () => number;
}

/** The stamped, federation-key-complete probe declaration `probe:emit` persists. */
export interface StampedProbe {
  workspaceId: string;
  harnessSlug: string;
  probeKey: string;
  emittedBy: string;
  emittedAtMs: number;
}

export type StampProbeResult =
  | { ok: true; stamped: StampedProbe }
  | { ok: false; reason: ProbeRefusalReason; detail: string };

/**
 * Build a direction-unique, stamped probe key. Generalizes the ad-hoc
 * `p059:v2t:wakeN-<agent>` convention (the runbook's own recommendation:
 * "use direction-unique probe keys per attempt, never reuse a name in both
 * directions") into a collision-resistant default so a caller never has to
 * hand-craft one.
 */
export function buildProbeKey(
  harnessSlug: string,
  emittedBy: string,
  nowMs: number,
  random: () => number = Math.random,
): string {
  const nonce = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  return `${harnessSlug}:v2t:${nowMs.toString(36)}-${emittedBy}-${nonce}`;
}

/**
 * Validate + stamp a probe. Pure — the caller resolves `harnessIsFederated`
 * (an async registry lookup) before calling this. Refuses loudly (typed
 * reason) rather than ever producing an unfederatable probe (cause #10).
 */
export function stampProbe(input: ProbeStampInput): StampProbeResult {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, reason: 'missing_workspace', detail: PROBE_REFUSAL_DETAIL.missing_workspace };
  }
  const harnessSlug = input.harnessSlug?.trim();
  if (!harnessSlug) {
    return { ok: false, reason: 'missing_harness_slug', detail: PROBE_REFUSAL_DETAIL.missing_harness_slug };
  }
  if (harnessSlug === '*') {
    return { ok: false, reason: 'invalid_harness_slug', detail: PROBE_REFUSAL_DETAIL.invalid_harness_slug };
  }
  const emittedBy = input.emittedBy?.trim();
  if (!emittedBy) {
    return { ok: false, reason: 'missing_emitted_by', detail: PROBE_REFUSAL_DETAIL.missing_emitted_by };
  }
  if (!input.harnessIsFederated) {
    return { ok: false, reason: 'harness_not_federated', detail: PROBE_REFUSAL_DETAIL.harness_not_federated };
  }
  const probeKey = buildProbeKey(harnessSlug, emittedBy, input.nowMs, input.random);
  return {
    ok: true,
    stamped: { workspaceId, harnessSlug, probeKey, emittedBy, emittedAtMs: input.nowMs },
  };
}

/** Read-time view of one probe's hop receipts (mirrors the PG row shape). */
export interface ProbeReceipt {
  probeKey: string;
  workspaceId: string;
  harnessSlug: string;
  emittedBy: string;
  emittedAtMs: number;
  status: 'pending' | 'acked' | 'refused' | 'timed_out';
  refusalReason?: ProbeRefusalReason | string;
  /** Hop -> epoch-ms, present only for hops that have landed. */
  hops: Partial<Record<ProbeHop, number>>;
}

export interface ProbeVerdict {
  /** 'refused' mirrors the receipt's own refused status; 'acked' = every hop
   *  in `expectedHops` landed; 'stalled' = a hop is missing past `staleAfterMs`;
   *  'pending' = still within grace, no verdict yet. */
  verdict: 'refused' | 'acked' | 'stalled' | 'pending';
  /** The LAST hop that actually landed (in pipeline order), or null if even
   *  capture never landed (should not happen for a non-refused receipt). */
  lastHopReached: ProbeHop | null;
  /** The hop the probe is STALLED at — i.e. the next hop after
   *  `lastHopReached` that never landed. Set only when verdict='stalled', so a
   *  probe failure NAMES its hop instead of just reading "still red" (P-010). */
  stalledAtHop: ProbeHop | null;
  detail: string;
}

export interface DeriveProbeVerdictOpts {
  /** Hops this probe is expected to traverse, in order. Default: all six —
   *  narrow this (e.g. to just ['captured','drained'] for a local-only probe
   *  with no live peer) so a probe that was never meant to replicate doesn't
   *  read as perpetually "stalled". */
  expectedHops?: readonly ProbeHop[];
  /** ms since `emittedAt` (or since the last-landed hop) after which a
   *  still-missing next hop reads as 'stalled' rather than 'pending'. */
  staleAfterMs?: number;
  nowMs: number;
}

const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000; // mirrors DEFAULT_LIVENESS_GRACE_MS's order of magnitude

/**
 * Derive a probe's verdict from its landed hops — the "so a probe failure
 * NAMES its hop" requirement (P-010). Pure: no clock reads, no PG.
 */
export function deriveProbeVerdict(receipt: ProbeReceipt, opts: DeriveProbeVerdictOpts): ProbeVerdict {
  if (receipt.status === 'refused') {
    return {
      verdict: 'refused',
      lastHopReached: null,
      stalledAtHop: null,
      detail: receipt.refusalReason ? `refused: ${receipt.refusalReason}` : 'refused',
    };
  }
  const expected = opts.expectedHops ?? PROBE_HOPS;
  let lastHopReached: ProbeHop | null = null;
  let lastHopAtMs = receipt.emittedAtMs;
  let nextHop: ProbeHop | null = null;
  for (const hop of expected) {
    const at = receipt.hops[hop];
    if (typeof at === 'number') {
      lastHopReached = hop;
      lastHopAtMs = at;
    } else {
      nextHop = hop;
      break;
    }
  }
  if (nextHop === null) {
    return {
      verdict: 'acked',
      lastHopReached,
      stalledAtHop: null,
      detail: `every expected hop landed (last: ${lastHopReached ?? 'none'})`,
    };
  }
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ageMs = opts.nowMs - lastHopAtMs;
  if (ageMs >= staleAfterMs) {
    return {
      verdict: 'stalled',
      lastHopReached,
      stalledAtHop: nextHop,
      detail:
        `stalled at '${nextHop}' — last landed hop was ${lastHopReached ?? 'emit (capture pending)'} ` +
        `${Math.round(ageMs / 1000)}s ago (>= ${Math.round(staleAfterMs / 1000)}s grace)`,
    };
  }
  return {
    verdict: 'pending',
    lastHopReached,
    stalledAtHop: null,
    detail: `waiting on '${nextHop}' (${Math.round(ageMs / 1000)}s since last hop, within grace)`,
  };
}

/** The canonical loud one-line rendering (logs / coord summaries / p2p:trace). */
export function formatProbeVerdict(receipt: ProbeReceipt, verdict: ProbeVerdict): string {
  return `probe ${receipt.probeKey} [${receipt.harnessSlug}] ${verdict.verdict}: ${verdict.detail}`;
}
