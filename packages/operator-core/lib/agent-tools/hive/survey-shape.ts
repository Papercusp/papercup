/**
 * pot:survey payload-tier shapers (context-trimming-tiers-2026-07-01 P-024).
 * 7d MCP telemetry: avg 19KB/call — the Queen's every-wake placement read.
 * Rows are already compact (id/title/score/why); the fat is the static
 * `ranker` spec re-sent every wake, the per-row `why` reason lists, and
 * (workspace scope) the perHive sections duplicating the crossHive rows.
 *
 * Trimmed = rows capped per view with why collapsed to the top reason and the
 * ranker spec replaced by a one-line note; standard keeps two reasons + wider
 * caps. Handles BOTH response scopes (single-hive and workspace/crossHive) by
 * shaping every {plans[], frontier[]} node it finds (D-004: loud drops only).
 */

export const SURVEY_TIER_CAPS = {
  trimmed: { rows: 12, title: 90, why: 1, whyChars: 60 },
  standard: { rows: 20, title: 140, why: 2, whyChars: 100 },
} as const;

type SurveyTier = keyof typeof SURVEY_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

function shapeRankedRows(
  rows: unknown[],
  c: (typeof SURVEY_TIER_CAPS)[SurveyTier],
): unknown[] {
  const out = rows.slice(0, c.rows).map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const why = Array.isArray(r.why)
      ? r.why.slice(0, c.why).map((w) => clip(w, c.whyChars)).filter((w) => w != null)
      : [];
    return {
      id: r.id ?? null,
      harness: r.harness ?? null,
      ...(r.hive !== undefined ? { hive: r.hive } : {}),
      title: clip(r.title, c.title),
      importance: r.importance ?? null,
      score: r.score ?? null,
      ...(why.length > 0 ? { why } : {}),
      ...(r.openItems !== undefined ? { openItems: r.openItems } : {}),
      ...(r.escalations !== undefined ? { escalations: r.escalations } : {}),
    };
  });
  if (rows.length > c.rows) {
    out.push({
      id: "(truncated)",
      harness: null,
      title: `showing top ${c.rows} of ${rows.length} — limit arg or payloadTier:"full" for the rest`,
      importance: null,
      score: null,
    });
  }
  return out;
}

/** Shape every {plans[], frontier[]} node in place (single-hive root, the
 *  workspace crossHive node, and each perHive section). */
function shapeSurveyNode(
  node: Record<string, unknown>,
  c: (typeof SURVEY_TIER_CAPS)[SurveyTier],
): Record<string, unknown> {
  const out = { ...node };
  if (Array.isArray(out.plans)) out.plans = shapeRankedRows(out.plans, c);
  if (Array.isArray(out.frontier)) out.frontier = shapeRankedRows(out.frontier, c);
  return out;
}

export function shapeHiveSurvey(data: unknown, tier: SurveyTier): unknown {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || d.ok !== true) return data; // error envelopes pass through
  const c = SURVEY_TIER_CAPS[tier];

  let out = shapeSurveyNode(d, c);
  if (out.crossHive && typeof out.crossHive === "object") {
    out.crossHive = shapeSurveyNode(out.crossHive as Record<string, unknown>, c);
  }
  if (Array.isArray(out.perHive)) {
    out.perHive = out.perHive.map((h) =>
      h && typeof h === "object" ? shapeSurveyNode(h as Record<string, unknown>, c) : h,
    );
  }
  if (tier === "trimmed" && out.ranker !== undefined) {
    // The ranker spec is static explanatory text — a one-line pointer replaces
    // it (payloadTier:"full" or a standard session gets it back).
    out = { ...out, ranker: undefined };
    delete out.ranker;
    out.ranker_note = 'ranker spec omitted at trimmed tier — payloadTier:"full" to inspect the scoring features';
  }
  return out;
}
