/**
 * OKF (Open Knowledge Frontmatter) v0.2 — trust + staleness evaluation.
 *
 * The READ-TIME half of `okf-frontmatter-adoption-2026-08-08`. P-001..P-004
 * put `type` / `generated` / `verified` / `stale_after` ON the corpus; this
 * module is what makes them mean something at the moment an agent reads a
 * doc, rather than only when someone runs a separate audit.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. **It never fabricates a verdict.** `verified` and `stale_after` are
 *    absent on 659/659 insights and 70/70 pack docs today, ON PURPOSE (plan
 *    D-002: a fabricated verification is strictly worse than none). So
 *    `evaluateOkfTrust` on the whole live corpus returns `unverified` +
 *    `stale: false` for every doc, and that is the CORRECT answer, not a
 *    bug to "fix" by backfilling values. The behaviour exists for the first
 *    author who writes a real `stale_after`; the tests prove it with a
 *    synthetic past date, never a corpus value.
 * 2. **An unparseable `stale_after` is not treated as stale.** It reports
 *    `staleAfterUnparseable` and leaves `stale` false — an unreadable field
 *    is a conformance defect for P-006's lint to catch, not licence to
 *    declare a doc rotten.
 *
 * Spec: `GoogleCloudPlatform/knowledge-catalog/okf/SPEC.md` (v0.2).
 */

import yaml from 'js-yaml';

export const OKF_VERSION = '0.2';

/**
 * The spec's trust ladder. `unverified` is the floor and the honest default —
 * a doc nobody has checked MUST read as unchecked.
 */
export type OkfTrustTier = 'unverified' | 'machine-verified' | 'human-verified';

export interface OkfVerifiedEvent {
  by: string;
  at?: string;
}

/** The four OKF fields, normalised (see `parseOkfFrontmatter`). */
export interface OkfFrontmatter {
  /** OKF's only mandatory field. Free-form by spec — consumers MUST tolerate unknown types. */
  type?: string;
  generated?: { by: string; at?: string };
  /**
   * ALWAYS a list here, even when the file authored a bare mapping — the spec
   * says consumers MUST treat a bare `verified` mapping as a single-element list,
   * so the union is collapsed once at parse time and every consumer sees one shape.
   */
  verified?: OkfVerifiedEvent[];
  /** Absolute date, as authored (a YAML date is normalised to `YYYY-MM-DD`). */
  staleAfter?: string;
}

export interface OkfTrust {
  tier: OkfTrustTier;
  /** `today >= stale_after`. False when the field is absent OR unparseable. */
  stale: boolean;
  staleAfter?: string;
  /** The `stale_after` value did not parse as a date — a conformance defect, NOT staleness. */
  staleAfterUnparseable?: true;
  /** Raw verifier of the MOST RECENT verification, so the tier is always auditable. */
  verifiedBy?: string;
  verifiedAt?: string;
  generatedBy?: string;
  type?: string;
}

/**
 * Does this trust verdict carry any signal worth spending payload on?
 *
 * The live corpus is 100% `unverified` + not-stale, so emitting a trust object
 * on every hit of every search would add bytes to every result and information
 * to none. Absence of `trust` in a docs:get / docs:search result therefore
 * MEANS `unverified` and not stale — stated in both tools' guidance.
 */
export function okfTrustIsNotable(t: OkfTrust): boolean {
  return t.tier !== 'unverified' || t.stale || t.staleAfterUnparseable === true;
}

/**
 * Machine-vs-human verifier classification.
 *
 * PROVISIONAL AND DELIBERATELY NARROW (plan D-004). No doc in either corpus
 * carries a `verified` entry yet, so there is no real population to calibrate
 * against — any rule picked today is untested by construction. The rule is
 * therefore a small, documented prefix list of this system's OWN machine actor
 * shapes, and `evaluateOkfTrust` ALWAYS returns the raw `verifiedBy` beside the
 * tier so a reader can check the classification instead of trusting it.
 * Revisit when real verifiers exist; widening it is a one-line change here.
 */
const MACHINE_VERIFIER_RE = /^(agent|bot|ci|system|su-|cup-|mug|blender|scout|kettle)\b|[-_]agent$|^claude|^gpt/i;

export function isMachineVerifier(by: string): boolean {
  return MACHINE_VERIFIER_RE.test(by.trim());
}

/**
 * Normalise an OKF date to a string.
 *
 * js-yaml resolves an UNQUOTED `stale_after: 2026-08-08` to a **Date instance**
 * while a quoted one stays a string — the same both-shapes reality that forced
 * plan D-002's `z.union([z.string(), z.date()])` in the Astro schema. Both are
 * legal YAML for the same authored line, so both are accepted and collapsed to
 * the `YYYY-MM-DD` text form here.
 */
export function normalizeOkfDate(v: unknown): string | undefined {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return undefined;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  if (typeof v === 'number') return String(v);
  return undefined;
}

function asVerifiedEvent(v: unknown): OkfVerifiedEvent | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const by = typeof rec.by === 'string' ? rec.by.trim() : '';
  if (!by) return null;
  const at = normalizeOkfDate(rec.at);
  return at ? { by, at } : { by };
}

/**
 * Pull the OKF fields out of a raw doc's `---` frontmatter block.
 *
 * Returns `undefined` when there is no frontmatter, when it does not parse as
 * YAML, or when none of the four fields is present — a doc with no OKF metadata
 * is indistinguishable from one whose frontmatter we could not read, and BOTH
 * are correctly "we know nothing", never "verified" or "fresh".
 *
 * Only the frontmatter BLOCK is handed to the YAML parser (never the body), so
 * this stays cheap enough to run once per page at adapter-build time.
 */
export function parseOkfFrontmatter(source: string): OkfFrontmatter | undefined {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return undefined;
  let doc: unknown;
  try {
    doc = yaml.load(m[1]);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  return okfFromObject(doc as Record<string, unknown>);
}

/** The same normalisation, for a caller that already has parsed frontmatter. */
export function okfFromObject(meta: Record<string, unknown>): OkfFrontmatter | undefined {
  const out: OkfFrontmatter = {};

  if (typeof meta.type === 'string' && meta.type.trim()) out.type = meta.type.trim();

  const gen = meta.generated;
  if (gen && typeof gen === 'object' && !Array.isArray(gen)) {
    const rec = gen as Record<string, unknown>;
    const by = typeof rec.by === 'string' ? rec.by.trim() : '';
    if (by) {
      const at = normalizeOkfDate(rec.at);
      out.generated = at ? { by, at } : { by };
    }
  }

  // Spec: a bare mapping MUST be treated as a single-element list.
  const rawVerified = meta.verified;
  if (rawVerified !== undefined && rawVerified !== null) {
    const list = (Array.isArray(rawVerified) ? rawVerified : [rawVerified])
      .map(asVerifiedEvent)
      .filter((e): e is OkfVerifiedEvent => e !== null);
    if (list.length > 0) out.verified = list;
  }

  const staleAfter = normalizeOkfDate(meta.stale_after);
  if (staleAfter) out.staleAfter = staleAfter;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** UTC midnight for a date-only or full-timestamp string; NaN when unparseable. */
function dayStartMs(value: string): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  return ms;
}

/**
 * The read-time verdict: which rung of the trust ladder, and is it past its date?
 *
 * Staleness is DATE-granular by spec (`today >= stale_after`), so both sides are
 * floored to UTC midnight — a doc whose `stale_after` is today reads stale from
 * the first second of that day, not from an arbitrary time-of-day boundary that
 * would make the answer depend on which timezone the reader happens to run in.
 */
export function evaluateOkfTrust(fm: OkfFrontmatter | undefined, now: Date = new Date()): OkfTrust {
  const out: OkfTrust = { tier: 'unverified', stale: false };
  if (!fm) return out;

  if (fm.type) out.type = fm.type;
  if (fm.generated) out.generatedBy = fm.generated.by;

  const events = fm.verified ?? [];
  if (events.length > 0) {
    // A HUMAN verification anywhere in the list outranks machine ones — the ladder
    // records the STRONGEST check the doc has ever received, not the most recent.
    const human = events.filter((e) => !isMachineVerifier(e.by));
    out.tier = human.length > 0 ? 'human-verified' : 'machine-verified';
    // Representative event = the most recent one AT THAT TIER (undated entries sort
    // oldest, so a dated verification is preferred as the thing we quote back).
    const pool = human.length > 0 ? human : events;
    const latest = [...pool].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))[pool.length - 1];
    out.verifiedBy = latest.by;
    if (latest.at) out.verifiedAt = latest.at;
  }

  if (fm.staleAfter) {
    out.staleAfter = fm.staleAfter;
    const staleMs = dayStartMs(fm.staleAfter);
    if (!Number.isFinite(staleMs)) {
      out.staleAfterUnparseable = true;
    } else {
      const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      out.stale = todayMs >= staleMs;
    }
  }

  return out;
}

/**
 * A ONE-LINE banner prepended to a stale doc's body at read time.
 *
 * The structured `trust` field is the machine-readable answer, but an agent
 * reads the CONTENT — a field it may not look at cannot deliver "this is
 * stale" at read time, which is the whole point of P-005. Returns null when
 * there is nothing to warn about (the entire corpus, today).
 */
export function okfStaleBanner(trust: OkfTrust): string | null {
  if (trust.stale) {
    const verified = trust.verifiedAt
      ? ` Last verified ${trust.verifiedAt}${trust.verifiedBy ? ` by ${trust.verifiedBy}` : ''}.`
      : ' It has never been verified.';
    return `> ⚠ **STALE — this doc passed its \`stale_after\` date (${trust.staleAfter}).** Treat its claims as UNVERIFIED until re-checked against the code.${verified}\n\n`;
  }
  if (trust.staleAfterUnparseable) {
    return `> ⚠ **This doc's \`stale_after\` (\`${trust.staleAfter}\`) is not a parseable date** — its expiry could NOT be evaluated, so "not stale" is unknown here, not verified.\n\n`;
  }
  return null;
}
