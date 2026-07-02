/**
 * get-shape.ts — payload-tier shapers for plans:get
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * plans:get is the #3 tool-result payload fleet-wide, and the 2026-07-01 fleet
 * incident measured one mode:'full' read at ~15k tokens on a 200k-window member.
 * Shapers project each bulk result: prose capped with a heading-narrowing
 * pointer, per-item text capped, decisions capped to the NEWEST few, and
 * (trimmed) the UI decoration maps dropped with an explicit omission marker.
 *
 * Shape contract (D-004): nothing is silently dropped — every cut carries a
 * count + a fetch-pointer, and `payloadTier:'full'` restores today's body.
 */

const CAPS = {
  trimmed: {
    prose: 6_000,
    sectionBody: 6_000,
    itemText: 200,
    decisions: 8,
    decisionBody: 240,
  },
  standard: {
    prose: 20_000,
    sectionBody: 20_000,
    itemText: 400,
    decisions: 20,
    decisionBody: 600,
  },
} as const;

type TierName = keyof typeof CAPS;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Tier-project one bulk result ({ ok:true, slug, … }). Errors pass through. */
function shapeResult(res: unknown, tier: TierName): unknown {
  if (!res || typeof res !== "object") return res;
  const r = res as Record<string, unknown>;
  if (r.ok !== true) return res;
  const c = CAPS[tier];
  const out: Record<string, unknown> = { ...r };

  // mode:'full' prose blob — the single biggest sink. Cap + point at the
  // heading-narrowed read (sectionIndex already lists every heading + size).
  if (typeof r.prose === "string" && r.prose.length > c.prose) {
    out.prose = clip(r.prose, c.prose);
    out.prose_truncated = true;
    out.prose_full_chars = r.prose.length;
    out.prose_hint =
      'read one section via plans:get { heading } (sectionIndex lists headings), or payloadTier:"full"';
  }

  // heading-narrowed reads still carry one section body — bound it the same way.
  const section = r.section as { body?: unknown } | null | undefined;
  if (
    section &&
    typeof section === "object" &&
    typeof section.body === "string" &&
    section.body.length > c.sectionBody
  ) {
    out.section = {
      ...section,
      body: clip(section.body, c.sectionBody),
      body_truncated: true,
      body_full_chars: section.body.length,
    };
  }

  // Items: keep EVERY item (the plan's structure is the point of the read), but
  // cap each text and drop the full-mode rawLine duplicate.
  if (Array.isArray(r.items)) {
    out.items = r.items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const { rawLine: _rawLine, ...rest } = it as Record<string, unknown>;
      const text = rest.text;
      if (typeof text === "string" && text.length > c.itemText) {
        return { ...rest, text: clip(text, c.itemText), text_truncated: true };
      }
      return rest;
    });
  }

  // Decisions: newest-N (the tail is the live context; older decisions are
  // history), each body capped harder than the sections-mode bound.
  if (Array.isArray(r.decisions) && r.decisions.length > 0) {
    const total = r.decisions.length;
    out.decisions = r.decisions.slice(-c.decisions).map((d) => {
      if (!d || typeof d !== "object") return d;
      const rec = d as Record<string, unknown>;
      const body = rec.body;
      if (typeof body === "string" && body.length > c.decisionBody) {
        return {
          ...rec,
          body: clip(body, c.decisionBody),
          body_truncated: true,
          body_full_chars: (rec.body_full_chars as number | undefined) ?? body.length,
        };
      }
      return rec;
    });
    if (total > c.decisions) {
      out.decisionsTruncated = {
        total,
        shown: c.decisions,
        more: 'payloadTier:"full" (or mode:"full") for all decisions',
      };
    }
  }

  // trimmed only: the UI decoration maps (feature badges, test-coverage badges)
  // are per-item objects an agent placing work rarely needs — drop them LOUDLY.
  if (tier === "trimmed") {
    const omitted: string[] = [];
    for (const key of ["linkedFeatures", "planItemTests"] as const) {
      const v = r[key];
      if (v && typeof v === "object" && Object.keys(v as object).length > 0) {
        delete out[key];
        omitted.push(key);
      }
    }
    if (omitted.length > 0) {
      out.trimmedOmitted = {
        fields: omitted,
        more: 'payloadTier:"standard" (or "full") to include them',
      };
    }
  }

  return out;
}

/** Tier-project a plans:get bulk envelope ({ ok, results, counts }). */
export function shapePlansGet(data: unknown, tier: TierName): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.results)) return data;
  return {
    ...d,
    payloadTier: tier,
    results: d.results.map((res) => shapeResult(res, tier)),
  };
}
