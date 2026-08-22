/**
 * carry-note-probe-scope.ts — surface the SCOPE a carried check's probe actually
 * observed, next to the claim it is badging (EI-18741016606334594).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * A `checks` row is `{ claim, recheck, verified }`. Presence of `verified`
 * renders `✓`, and that badge is a licence to skip re-checking — the entire
 * point of the field. But nothing relates the SCOPE of `claim` to the scope of
 * what `verified` actually establishes, so a probe that observed a 60-minute
 * window can badge a claim quantified over a whole day, and the badge is what a
 * cold successor reads.
 *
 * Root incident (the item this module was filed from):
 *
 *     ✓ The live-federation gate is STILL SKIPPING. … No gate run produced a
 *       verdict today.
 *       — re-check: journalctl … --since '60 min ago' … | grep -E 'GATE:'
 *
 * Sentence one is supported. Sentence two is a claim about 16 windows backed by
 * a probe that can see one — and it was FALSE; the gate produced nine verdicts
 * that day. Two questions were then carried for hours as "blocked until the gate
 * runs" when the answers had been on disk the whole time.
 *
 * Each cold wake re-renders the row verbatim, so the overreach does not decay —
 * it hardens. The `✓ / ?` distinction is verified-vs-PREDICTED, not
 * scope-matched-vs-overreaching, so both markers pass it cleanly.
 *
 * ── WHY RENDERING IS THE PRIMARY FIX ────────────────────────────────────────
 *
 * The recheck string ALREADY contains the bound (`--since '60 min ago'`,
 * `tail -3`, `limit 10`). Surfacing it inline costs the writer nothing, invents
 * no judgement, and cannot be wrong about intent — it only repeats what the
 * probe says about itself. It puts the mismatch where the badge is read, which
 * is the only place a reader ever reconsiders one. {@link describeProbeScope} is
 * that half, and it is why this module is worth having even if the advisory lint
 * below never fires.
 *
 * ── MEASURED, NOT ASSUMED ───────────────────────────────────────────────────
 *
 * D-001 of agent-epistemics-2026-08-02 retired a drafted detector that fired
 * ZERO times in 14 days, and recorded the rule: a detector is measured against
 * the real corpus BEFORE it is wired in. Measured here against
 * `harness_shared.carry_notes` on 2026-08-13 — 618 notes carrying a `## Checks`
 * section, 4,074 parsed rows, 69.9% of them `✓`:
 *
 *   - {@link describeProbeScope} finds a declared bound on 107 rows (2.6%).
 *     Most rechecks are legitimately unbounded (a test run, a `git rev-parse`,
 *     a tool call) and correctly get no marker — only a probe that NAMES its own
 *     limit can be outrun.
 *   - {@link detectScopeOverreach} flags 31 rows — 0.8% of all rows, 1.1% of
 *     `✓` rows. Same order as the sibling absence detector's 4.6%: a real
 *     signal, not noise.
 *
 * The corpus is live and grows, so those are counts at a date, not invariants.
 * The findings that shaped the RULES are what matter, and they are frozen as
 * cases in `carry-note-probe-scope.test.ts`:
 *
 *   - The dominant FALSE POSITIVE is the PRESCRIPTIVE row. This fleet writes
 *     standing discipline as checks ("⛔ Do NOT pass --mobile-root", "NEVER
 *     trust a background task-completion notification's exit code", "For ANY
 *     red-test item: re-run at HEAD FIRST"). These carry universal quantifiers
 *     by construction and describe no bounded observation at all, so a
 *     quantifier-plus-bound rule fires hardest on exactly the rows where it has
 *     nothing to say. {@link isPrescriptiveClaim} exists because of that
 *     measurement, and runs first.
 *   - The discriminator that survived the corpus: this fleet writes discipline
 *     in ALL-CAPS (`NEVER`, `DO NOT`, `ALWAYS`) or behind a ⛔/⚠ marker, and
 *     writes observation in ordinary prose. That signal belongs to
 *     {@link isPrescriptiveClaim} ALONE. An earlier draft also case-restricted
 *     the quantifier match, which conflated emphasis with ordinary sentence
 *     case and made the detector miss the root incident's own leading "No" —
 *     the discrimination is one rule, applied in one place.
 *   - Only `✓` rows can exhibit the defect. A `?` row already tells the reader
 *     to re-check before relying on it, so there is no badge to inherit and
 *     flagging one would be pure noise.
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────
 *
 * Every function here is PURE, total, and FAILS OPEN: an unparseable recheck
 * yields null (no marker, no flag), never a throw and never a blocked write.
 * This is decoration on a claim — it must never become a new way for a
 * checkpoint to fail, because the checkpoint is the successor's only memory.
 */

/** A bound a probe declares about ITSELF, extracted from its own command text. */
export interface ProbeScope {
  /** Short label rendered inline next to the badge, e.g. `last 60 min`. Never
   *  contains `]`, so it can never break the rendered row's round-trip. */
  label: string;
  /** What kind of bound it is — a time window, a line cut, or a row cap. */
  kind: 'time' | 'lines' | 'rows';
}

/**
 * The rendered inline marker, and the ONE regex that strips it back off.
 *
 * Render and parse derive from this single source deliberately. A marker built
 * in one place and matched by a separately-written pattern in another is the
 * silent-drift shape: the two agree until an edit moves one of them, and then
 * the marker is absorbed into the claim text, which GROWS the claim by one
 * marker on every wake. Keeping the pair here makes that unrepresentable.
 */
export const PROBE_SCOPE_MARKER_RE = /\[scope:[^\]]*\]/;

/** Render a scope as its inline marker. `]` is stripped from the label so the
 *  marker cannot be terminated early by its own contents. */
export function renderProbeScopeMarker(scope: ProbeScope): string {
  return `[scope: ${scope.label.replace(/]/g, '').trim()}]`;
}

/** Strip a leading inline scope marker (and its trailing space) from a rendered
 *  row fragment. Idempotent: a fragment without one is returned unchanged. The
 *  marker is DERIVED from `recheck` at render time and never stored, so parsing
 *  discards it and the next render re-derives it from the current recheck. */
export function stripProbeScopeMarker(text: string): string {
  return text.replace(new RegExp(`^\\s*${PROBE_SCOPE_MARKER_RE.source}\\s*`), '');
}

/** Singular/plural without dragging in a formatter. `min` is left unpluralized —
 *  it is an abbreviation, and "10 mins" reads as sloppy in a marker whose entire
 *  job is to be taken literally. */
function plural(n: string, unit: string): string {
  if (unit === 'min') return `${n} min`;
  return `${n} ${unit}${n === '1' ? '' : 's'}`;
}

/**
 * Time-window bounds, most specific first. `--since today` is deliberately
 * included: it IS an explicit bound (and the root incident's claim leaned on
 * exactly that word), even though it names a boundary rather than a duration.
 */
const TIME_PATTERNS: ReadonlyArray<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  // --since '60 min ago' / --since "24 hours ago" / --since=2 days ago
  {
    re: /--since[=\s]+['"]?(\d+)\s*(min(?:ute)?|hour|hr|day|week)s?\s*ago['"]?/i,
    label: (m) => `last ${plural(m[1], m[2].toLowerCase().replace(/^hr$/, 'hour').replace(/^min$/, 'min'))}`,
  },
  // --since '-30min' / --since=-2h  (the rolling-window form)
  {
    re: /--since[=\s]+['"]?-(\d+)\s*(min|m|h|hour|d|day)['"]?/i,
    label: (m) => `last ${plural(m[1], /^m/i.test(m[2]) ? 'min' : /^h/i.test(m[2]) ? 'hour' : 'day')}`,
  },
  // --since today / --since yesterday
  { re: /--since[=\s]+['"]?(today|yesterday)['"]?/i, label: (m) => `since ${m[1].toLowerCase()}` },
  // --since '2026-08-02 20:00' / --since 2026-08-02
  { re: /--since[=\s]+['"]?(\d{4}-\d{2}-\d{2})/i, label: (m) => `since ${m[1]}` },
  // sinceHours: 24 / sinceDays:7 / sinceMinutes: 30
  {
    re: /\bsince(Hours|Days|Minutes|Min)\b\s*[:=]\s*(\d+)/i,
    label: (m) => `last ${plural(m[2], m[1].toLowerCase().replace(/^min$/, 'minute').replace(/s$/, ''))}`,
  },
];

/** Line-cut bounds: `head -20`, `tail -n 5`, a bare `| head`, `tail: 40`. */
const LINE_PATTERNS: ReadonlyArray<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  { re: /\b(head|tail)\s+-n\s*(\d+)/i, label: (m) => `${/^h/i.test(m[1]) ? 'first' : 'last'} ${plural(m[2], 'line')}` },
  { re: /\b(head|tail)\s+-(\d+)/i, label: (m) => `${/^h/i.test(m[1]) ? 'first' : 'last'} ${plural(m[2], 'line')}` },
  { re: /\b(head|tail)\b\s*[:=]\s*(\d+)/i, label: (m) => `${/^h/i.test(m[1]) ? 'first' : 'last'} ${plural(m[2], 'line')}` },
  // A bare `| head` / `| tail` still bounds the read, just at the tool default.
  { re: /\|\s*(head|tail)\b(?!\s*-)/i, label: (m) => `${/^h/i.test(m[1]) ? 'first' : 'last'} few lines` },
];

/**
 * Explicit `limit` caps: SQL `LIMIT 10`, `--limit=20`, `capability:read { limit: 86 }`.
 *
 * The label deliberately ECHOES the probe's own word rather than naming a unit.
 * Measured on the corpus: the same `limit` spans SQL rows and `capability:read`
 * LINES, and nothing in the string distinguishes them — an early draft labelled
 * a file read as "86 rows max", which is a confident wrong unit in a marker
 * whose only job is to be read literally. Repeating the probe's own token cannot
 * be wrong about what it meant.
 */
const ROW_PATTERNS: ReadonlyArray<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  { re: /\blimit\b\s*[:=]?\s*(\d+)/i, label: (m) => `limit ${m[1]}` },
];

/**
 * Extract the bound a probe declares about itself, or null when it declares
 * none (an unbounded read, or a prose re-check like "re-read the file").
 *
 * Null is the common, correct answer — most rechecks are unbounded, and an
 * unbounded probe is not a defect. Only a probe that NAMES its own limit can
 * contradict a claim that outruns it.
 */
export function describeProbeScope(recheck: string | null | undefined): ProbeScope | null {
  const text = (recheck ?? '').trim();
  if (!text) return null;
  for (const [kind, patterns] of [
    ['time', TIME_PATTERNS],
    ['lines', LINE_PATTERNS],
    ['rows', ROW_PATTERNS],
  ] as const) {
    for (const { re, label } of patterns) {
      const m = re.exec(text);
      if (m) {
        const rendered = label(m).replace(/]/g, '').trim();
        if (rendered) return { label: rendered, kind };
      }
    }
  }
  return null;
}

/**
 * Universal / temporal quantifiers that make a claim outrun a bounded probe.
 *
 * Case-INSENSITIVE, deliberately. An earlier draft matched lower-case only, on
 * the theory that this fleet capitalizes discipline and lowercases observation —
 * but that conflates two different reasons a word is capitalized. Ordinary
 * sentence case capitalizes the first word, so the root incident's own claim
 * ("No gate run produced a verdict today") matched on `today` and MISSED its
 * actual quantifier. ALL-CAPS emphasis is the real discipline signal, and
 * {@link isPrescriptiveClaim} is the dedicated mechanism for it — which runs
 * first, making any case rule here redundant as well as wrong.
 */
const QUANTIFIER_RE =
  /\b(no|none|nothing|never|every|all|any|always|zero|entire|whole|today|mostly|at all|so far|ever)\b/i;

/**
 * Quantifier-shaped words that are explicitly LIMITING the writer's claim,
 * rather than asserting breadth. These phrases are the language the scope lint
 * tells a writer to add when splitting a verified observation from a peer's or
 * an unobserved one. Mask the whole phrase before looking for a claim
 * quantifier, so a real broad assertion elsewhere in the same claim still
 * remains visible to the lint.
 */
const SCOPE_DISCLAIMER_RE =
  /\b(?:never|not)\s+(?:[a-z][a-z'-]*\s+){0,3}by\s+me\b|\b(?:the\s+)?(?:whole|entire)\s+of\s+what\s+my\s+probe(?:'s)?\s+(?:saw|observed|checked|measured)\b/gi;

function findClaimQuantifier(claim: string): RegExpExecArray | null {
  // Preserve offsets and the original match text while hiding only
  // quantifiers that occur inside an explicit scope disclaimer.
  const claimWithoutDisclaimers = claim.replace(SCOPE_DISCLAIMER_RE, (match) => ' '.repeat(match.length));
  return QUANTIFIER_RE.exec(claimWithoutDisclaimers);
}

/**
 * ALL-CAPS imperatives and the ⛔/⚠/🚨 markers this fleet writes standing
 * discipline with. A prescriptive row is advice, not a bounded observation, so
 * it has no scope to mismatch and must never be flagged.
 *
 * This is the module's single most important rule by measured volume: without
 * it the detector fires hardest on rows where it has nothing to say.
 */
const PRESCRIPTIVE_RE =
  /(^\s*[⛔⚠🚨])|\b(NEVER|ALWAYS|DO NOT|DON'T|MUST NOT|STOP|RETRACTED|For ANY\b)/;

/** True when a claim reads as standing discipline rather than an observation. */
export function isPrescriptiveClaim(claim: string): boolean {
  return PRESCRIPTIVE_RE.test(claim ?? '');
}

/** One flagged row: a ✓ claim quantified over more than its own probe observes. */
export interface ScopeOverreach {
  /** The claim, clipped for a bounded tool result. */
  claim: string;
  /** The quantifier that outruns the probe. */
  quantifier: string;
  /** The bound the probe declares about itself. */
  probeScope: string;
}

/** Rows carry an optional `id`; only these three fields matter to the lint. */
interface ScopeLintRow {
  claim?: string;
  recheck?: string;
  verified?: string;
}

/**
 * Advisory lint: find `✓ VERIFIED` rows whose claim is quantified over more
 * than the recheck can observe. Advisory ONLY — never blocks a write.
 *
 * Deliberately narrow, in this order:
 *   1. `✓` rows only — a `?` row has no badge to inherit.
 *   2. Not prescriptive — the measured false-positive class.
 *   3. The claim carries a lower-case universal/temporal quantifier.
 *   4. The recheck declares an explicit bound.
 *
 * Returns at most `max` rows (default 3), matching the sibling lints' bound.
 */
export function detectScopeOverreach(
  rows: ReadonlyArray<ScopeLintRow> | null | undefined,
  max = 3,
): ScopeOverreach[] {
  const out: ScopeOverreach[] = [];
  for (const row of rows ?? []) {
    const claim = (row?.claim ?? '').trim();
    if (!claim) continue;
    if (!(row?.verified ?? '').trim()) continue;
    if (isPrescriptiveClaim(claim)) continue;
    const q = findClaimQuantifier(claim);
    if (!q) continue;
    const scope = describeProbeScope(row?.recheck);
    if (!scope) continue;
    out.push({
      claim: claim.length > 160 ? `${claim.slice(0, 157)}…` : claim,
      quantifier: q[1],
      probeScope: scope.label,
    });
    if (out.length >= max) break;
  }
  return out;
}
