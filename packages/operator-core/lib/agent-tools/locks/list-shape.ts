/**
 * locks:list payload-tier shapers (context-trimming-tiers-2026-07-01 P-023).
 * 7d MCP telemetry: avg 89.5KB/call — long registry rule_text/description ×
 * every registered resource, plus holder reasons. A trimmed/standard session
 * gets clipped registry rows + lean holder rows, capped with visible notice
 * rows (D-004: uniform keys per tier, loud cuts, payloadTier:"full" escape).
 */

export const LOCKS_LIST_TIER_CAPS = {
  trimmed: { resources: 60, holders: 40, rule: 100, description: 0, reason: 0 },
  standard: { resources: 120, holders: 80, rule: 240, description: 160, reason: 120 },
} as const;

type LocksTier = keyof typeof LOCKS_LIST_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

export function shapeLocksList(data: unknown, tier: LocksTier): unknown {
  const d = data as
    | ({ resources?: unknown[]; holders?: unknown[] } & Record<string, unknown>)
    | null
    | undefined;
  if (!d || !Array.isArray(d.resources) || !Array.isArray(d.holders)) return data;
  const c = LOCKS_LIST_TIER_CAPS[tier];

  const projectResource = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      resource: r.resource ?? null,
      enforcement: r.enforcement ?? null,
      rule: clip(r.rule_text, c.rule),
      ...(c.description > 0 ? { description: clip(r.description, c.description) } : {}),
    };
  };
  const projectHolder = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      owner: r.owner ?? null,
      mode: r.mode ?? null,
      status: r.status ?? null,
      expires_ts: r.expires_ts ?? null,
      ...(c.reason > 0 ? { reason: clip(r.reason, c.reason) } : {}),
    };
  };

  const resources = d.resources.slice(0, c.resources).map(projectResource);
  if (d.resources.length > c.resources) {
    resources.push({
      ...projectResource({}),
      resource: "(truncated)",
      rule: `showing ${c.resources} of ${d.resources.length} — pass {resource} for one, or payloadTier:"full"`,
    });
  }
  const holders = d.holders.slice(0, c.holders).map(projectHolder);
  if (d.holders.length > c.holders) {
    holders.push({
      ...projectHolder({}),
      owner: "(truncated)",
      status: `showing ${c.holders} of ${d.holders.length}`,
    });
  }
  return { ...d, resources, holders };
}
