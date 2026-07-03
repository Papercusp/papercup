/**
 * capture-coerce.ts — WI-1974: be liberal about improvements:capture's top-level `kind`.
 *
 * improvements:capture is the self-improvement loop's OWN intake tool, yet it failed
 * ~17% of calls (27/160 in 24h), 29 of them on the top-level `kind` enum — and every
 * rejected call is a captured insight LOST (the exact rot the loop exists to prevent).
 * Live 48h breakdown of the failing `kind` values:
 *   observation 18 · null 11 · process 3 · friction 2 · tooling 2 · improvement 2
 *   · gap 1 · reliability 1 · issue 1 · tool-friction 1
 * Agents conflate `kind` with (a) the observation LANE, (b) the observation SUB-kind,
 * or (c) a free-form label — none of which should hard-reject. Coerce to intent:
 *   - kind null / '' / whitespace   → omit (schema `.optional()`, handler defaults 'change')
 *   - kind 'observation'            → lane:'observation' (kind is ignored in that lane)
 *   - kind ∈ observation sub-kinds  → lane:'observation' + observation.kind = that value
 *   - any other non-enum label      → 'change' (the documented default for a desired improvement)
 *   - a valid {bug,change,feature}  → untouched (case-normalised if it differed)
 *
 * This normalises ONLY the top-level `kind`. It deliberately does NOT touch the
 * `.strict()` observation sub-object (its unknown-key rejection is intentional —
 * added to stop silent data loss — and must keep failing loud).
 */

const VALID_KIND = new Set(['bug', 'change', 'feature']);
const OBSERVATION_SUBKINDS = new Set(['friction', 'workaround', 'gap', 'surprise', 'reinforce']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function coerceCaptureKind(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;

  // explicit null (11×): z.enum().optional() rejects null (only undefined) — drop it
  // so the schema default ('change') applies. undefined already parses fine.
  if (raw.kind === undefined) return raw;
  if (raw.kind === null) {
    const out = { ...raw };
    delete out.kind;
    return out;
  }
  if (typeof raw.kind !== 'string') return raw; // non-string, non-null → let validation speak

  const k = raw.kind.trim().toLowerCase();
  if (VALID_KIND.has(k)) return raw.kind === k ? raw : { ...raw, kind: k };

  const out: Record<string, unknown> = { ...raw };
  if (k === '') {
    delete out.kind;
    return out;
  }
  if (k === 'observation') {
    delete out.kind;
    out.lane = out.lane ?? 'observation';
    return out;
  }
  if (OBSERVATION_SUBKINDS.has(k)) {
    delete out.kind;
    out.lane = out.lane ?? 'observation';
    const obs = isPlainObject(out.observation) ? { ...out.observation } : {};
    if (obs.kind === undefined) obs.kind = k;
    out.observation = obs;
    return out;
  }
  // any other free-form label ('process','tooling','improvement','reliability','issue',
  // 'tool-friction', …) → the documented default kind for a desired improvement.
  out.kind = 'change';
  return out;
}
