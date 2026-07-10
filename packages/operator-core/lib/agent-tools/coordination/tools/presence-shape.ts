/**
 * coord:presence payload-tier shapers (context-trimming-tiers-2026-07-01 P-022).
 *
 * The roster row carries three full lanes (identity + state + liveness —
 * presence-payload.ts): host/pid/devicePubkey/awaiting-keys are per-row env
 * detail an LLM coordinator never reads. 7d MCP telemetry: avg 38KB, max
 * 185KB/call. A trimmed/standard session projects each row to the dispatch
 * decision core (who / state / wakeable / intent / lane) and caps rows.
 *
 * Contract (D-004): uniform keys per tier (TOON tabular), a visible
 * `(truncated)` notice row on a cut, `summary` kept verbatim (it is the
 * counts contract readers are told to trust — and the result-aware seeAlso
 * reads summary.byState.ended).
 */

export const PRESENCE_TIER_CAPS = {
  trimmed: { rows: 40, intent: 80 },
  standard: { rows: 80, intent: 160, note: 60 },
} as const;

type PresenceTier = keyof typeof PRESENCE_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeCoordPresence(data: unknown, tier: PresenceTier): unknown {
  const d = data as
    | ({ active?: unknown[] } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.active)) return data;
  const c = PRESENCE_TIER_CAPS[tier];

  const project = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const claimed = Array.isArray(r.claimedItems) ? r.claimedItems : [];
    const base = {
      ownerId: r.ownerId ?? null,
      label: r.ownerLabel ?? null,
      role: r.agentRole ?? null,
      state: r.sessionState ?? null,
      wakeable: r.wakeable ?? null,
      intent: clip(r.intent, c.intent),
      plan: r.currentPlanSlug ?? null,
      claims: claimed.length,
      lastActiveSecAgo: r.lastActiveSecAgo ?? null,
      intentStale: r.intentStale ?? null,
      // EI-8988: fresh activity + old intent text — the "busy but drifted" signal,
      // cheap enough (one bool) to keep even in the trimmed tier.
      intentDivergent: r.intentDivergent ?? null,
      fleet: r.fleetSlug ?? null,
      isSelf: r.isSelf === true,
    };
    if (tier === "trimmed") return base;
    return {
      ...base,
      harness: r.harnessSlug ?? null,
      model: r.model ?? null,
      onDesktop: r.onDesktop ?? null,
      viewerAttached: r.viewerAttached ?? null,
      wakeMode: r.wakeMode ?? null,
      awaitingNote: clip(r.awaitingNote, (c as { note?: number }).note ?? 60),
      files: Array.isArray(r.currentFiles) ? r.currentFiles.length : 0,
      claimRefs: claimed.every((x) => typeof x === "string")
        ? claimed.slice(0, 8).map(String).join(",") || null
        : null,
    };
  };

  const rows = d.active.slice(0, c.rows).map(project);
  if (d.active.length > c.rows) {
    rows.push({
      ...project({}),
      ownerId: "(truncated)",
      intent: `showing ${c.rows} of ${d.active.length} — narrow with owner/hive/scope, or payloadTier:"full"`,
    });
  }
  // Keep the small top-level fields (as_of/scope/summary/self) verbatim.
  return { ...d, active: rows };
}
