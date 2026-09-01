/**
 * knowledge-at-symptom-time-2026-08-09 P-003 — the per-scope cap number must
 * never be hardcoded in agent-facing prose.
 *
 * BACKGROUND. EI-19931982603802383 raised FACTS_PER_SCOPE_CAP 50 -> 200 after
 * measuring the two busiest scopes on this box pinned at EXACTLY 50/50 (i.e.
 * permanently at cap, so every assert by any of ~20 live agents evicted the
 * worst-ranked incumbent). That raise was correct and is verified live: at
 * 2026-08-09T07:00Z the ranked populations were harness:papercusp = 59 and
 * workspace = 52 — both ABOVE the old pin, which is only reachable if the
 * writer enforces a cap > 50 — and cap evictions stopped after 03:00Z (they
 * had been running 12/hr, 9/hr in the hours before).
 *
 * WHAT IT MISSED, and why this guard exists. The raise moved the CONSTANT but
 * not the four agent-facing strings that had the number typed into them as a
 * literal. So the tool description every agent reads still said "per-scope cap
 * 50" while the enforced cap was 200 — a 4x understatement delivered at
 * exactly the moment an agent decides whether it can afford to assert. That is
 * this plan's own failure class (knowledge that misdescribes behaviour at
 * symptom-time), and it recurs on EVERY future re-tune unless the number is
 * derived rather than typed. Interpolating the constant fixed the four; this
 * guard is what stops the fifth.
 *
 * The check is deliberately SOURCE-level: a template literal `${FACTS_PER_SCOPE_CAP}`
 * carries no digit, so a correct string cannot match, while a hand-typed digit
 * always does — regardless of whether that string happens to agree with the
 * constant today. Agreeing-by-luck is not the property we want; deriving is.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACTS_PER_SCOPE_CAP } from './store';
import { orderAsSweepWould } from './sweep-ranking';
import assertTool from '../agent-tools/facts/assert';

/**
 * Prose shapes that state the per-scope cap as a literal number. Each
 * alternative captures the digits so a violation can be reported with the
 * number the reader would have believed.
 */
const CAP_PROSE_PATTERNS: readonly RegExp[] = [
  /(\d+)[-\s]per-scope cap/i,
  /per-scope cap (?:of )?(\d+)/i,
  /(\d+)-fact cap/i,
  /cap of (\d+) facts?/i,
];

/**
 * Genuine historical prose ("raised from the old 50-per-scope cap") is allowed
 * to name a superseded number, but must SAY so on the same line. Without this
 * escape the guard would be unfalsifiable-by-annoyance: the next author would
 * delete the guard rather than the sentence.
 *
 * EI-20802334255504868: "the same line" means the same PHYSICAL line, and that
 * is ambiguous exactly where this guard fires most — inside a wrapped doc
 * comment, where one prose SENTENCE spans several lines. An author who put the
 * marker on the line the explanation read best on, rather than the line
 * carrying the digits, got back the identical "you did not add the marker"
 * text — so the obvious next move was to re-read the marker SPELLING, not to
 * re-count physical lines. The scope stays per-line (that is what makes it
 * cheap and unambiguous to evaluate); what changed is that a misplaced marker
 * is now DETECTED and reported as misplaced. An escape that appears not to
 * work is the same unfalsifiable-by-annoyance hazard, one step later.
 */
const HISTORICAL_MARKER = 'cap-drift-ok';

/**
 * How far from an offending line to look for a marker the author plainly meant
 * for it. Two lines covers the wrapped-sentence case that motivated this
 * without reaching a marker that belongs to a neighbouring statement — the
 * message claims the author meant THAT marker for THIS line, so the radius is
 * the bound on that claim.
 */
const MARKER_NEAR_MISS_RADIUS = 2;

const FACTS_DIRS = [
  join(__dirname),
  join(__dirname, '..', 'agent-tools', 'facts'),
];

function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const dir of FACTS_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const path = join(dir, name);
      out.push({ path, text: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

interface CapHit {
  line: number;
  literal: string;
  stated: string;
  /** 1-based line of a marker that is CLOSE BY but not on `line` — see MARKER_NEAR_MISS_RADIUS. */
  misplacedMarkerLine?: number;
}

/** The nearest marker within the near-miss radius, preferring the closer line
 *  and, at equal distance, the one above. Returns a 1-based line, or null. */
function misplacedMarkerNear(lines: readonly string[], index: number): number | null {
  for (let distance = 1; distance <= MARKER_NEAR_MISS_RADIUS; distance += 1) {
    for (const candidate of [index - distance, index + distance]) {
      if (candidate < 0 || candidate >= lines.length) continue;
      if (lines[candidate].includes(HISTORICAL_MARKER)) return candidate + 1;
    }
  }
  return null;
}

/** The predicate under test, isolated so the falsifiability control below can
 *  drive it with the real pre-fix strings instead of a synthetic mock. */
function hardcodedCapsIn(text: string): CapHit[] {
  const lines = text.split('\n');
  const hits: CapHit[] = [];
  lines.forEach((line, i) => {
    if (line.includes(HISTORICAL_MARKER)) return;
    for (const re of CAP_PROSE_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        const misplaced = misplacedMarkerNear(lines, i);
        hits.push({
          line: i + 1,
          literal: m[0],
          stated: m[1],
          ...(misplaced === null ? {} : { misplacedMarkerLine: misplaced }),
        });
        break;
      }
    }
  });
  return hits;
}

/**
 * The violation text, extracted from the assertion so the regression below can
 * assert on the MESSAGE. The defect being fixed was entirely in this string:
 * it could not distinguish "no marker anywhere" from "marker present, wrong
 * line", and reported both as though the author had never added one.
 */
function capViolationMessage(path: string, hit: CapHit): string {
  const head =
    `${path}:${hit.line} says "${hit.literal}" (states ${hit.stated}; ` +
    `the enforced cap is ${FACTS_PER_SCOPE_CAP}).`;
  if (hit.misplacedMarkerLine !== undefined) {
    return (
      `${head} A ${HISTORICAL_MARKER} marker IS present on line ` +
      `${hit.misplacedMarkerLine}, but this guard matches PER PHYSICAL LINE and ` +
      `a wrapped comment sentence spans several. Move the marker onto line ` +
      `${hit.line} itself — the line carrying the digits.`
    );
  }
  return (
    `${head} Interpolate \${FACTS_PER_SCOPE_CAP} instead, or put ` +
    `${HISTORICAL_MARKER} on line ${hit.line} itself (this guard matches per ` +
    `physical line, not per sentence) if it is deliberately describing a ` +
    `superseded cap.`
  );
}

describe('facts per-scope cap — agent-facing prose must derive the number, not type it', () => {
  it('no source file in the facts subsystem states the cap as a literal', () => {
    const violations: string[] = [];
    for (const { path, text } of sourceFiles()) {
      for (const hit of hardcodedCapsIn(text)) violations.push(capViolationMessage(path, hit));
    }
    expect(violations).toEqual([]);
  });

  it('the live facts:assert description states the CURRENT cap', () => {
    // The behavioural leg. The source scan above proves nothing is hand-typed;
    // this proves what an agent actually reads resolves to today's number.
    const notWhen = assertTool.guidance?.notWhen ?? '';
    expect(notWhen).toContain(`per-scope cap ${FACTS_PER_SCOPE_CAP}`);
    expect(notWhen).not.toMatch(/per-scope cap 50\b/);
  });

  /**
   * FALSIFIABILITY CONTROL (permanent). These are the four real strings as they
   * stood at 2026-08-09T07:00Z, copied verbatim from the pre-fix source. If the
   * guard above ever stops catching them it has been weakened into a no-op, and
   * that must fail loudly rather than pass quietly — a guard that has never
   * failed is a guard nobody has tested.
   */
  it('CONTROL: the four real pre-fix strings are caught', () => {
    const preFix = [
      'long-form knowledge (agent-insights doc), fuzzy background worth semantic recall (memory:remember). Not a dumping ground — 1200-char cap, per-scope cap 50, TTL mandatory.',
      '${evicted} CAP-EVICTED (dropped by the 50-per-scope cap, NOT withdrawn — no one judged it wrong, it simply aged out of the scope)',
      'facts decay by four paths (expiry, retraction, supersession and a 50-per-scope cap eviction with no time guarantee).',
      '  // keys × the 50-per-scope cap) and a dynamic tuple-IN buys nothing here.',
    ];
    for (const s of preFix) {
      const hits = hardcodedCapsIn(s);
      expect(hits.length, `guard went blind to: ${s.slice(0, 60)}…`).toBeGreaterThan(0);
      expect(hits[0].stated).toBe('50');
    }
  });

  it('CONTROL: an interpolated string and a marked historical note are NOT flagged', () => {
    // Calibration — without this, the control above would also pass if the
    // predicate simply flagged every line it ever saw.
    expect(hardcodedCapsIn('per-scope cap ${FACTS_PER_SCOPE_CAP}, TTL mandatory.')).toEqual([]);
    expect(
      hardcodedCapsIn(`* EI-19931982603802383: raised from the 50-per-scope cap. ${HISTORICAL_MARKER}`),
    ).toEqual([]);
  });

  /**
   * EI-20802334255504868 regression. A marker one or two lines off is the case
   * the guard used to report as "you did not add the marker" — which sends the
   * author to re-read the marker's SPELLING rather than re-count physical
   * lines, and the guard re-fails identically on the next run.
   */
  it('a marker on a NEARBY line is reported as misplaced, naming both lines', () => {
    const wrapped = [
      '/**',
      ' * EI-19931982603802383 measured both busy scopes pinned at the old',
      ' * per-scope cap of 50 before the raise landed.',
      ` * (quoted verbatim from the filing — ${HISTORICAL_MARKER})`,
      ' */',
    ].join('\n');

    const hits = hardcodedCapsIn(wrapped);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].misplacedMarkerLine).toBe(4);

    const message = capViolationMessage('store.ts', hits[0]);
    expect(message).toContain('store.ts:3');
    expect(message).toContain('marker IS present on line 4');
    expect(message).toContain('Move the marker onto line 3');
    // It must NOT read as "add a marker" — that instruction is precisely what
    // sent the author to re-check spelling instead of position.
    expect(message).not.toContain('Interpolate');
  });

  it('CONTROL: with NO marker anywhere the message still says to interpolate or mark that line', () => {
    // Calibration for the leg above — without it, a predicate that labelled
    // every violation "misplaced" would pass that test too.
    const hits = hardcodedCapsIn(' * measured at the per-scope cap of 50 before the raise.');
    expect(hits).toHaveLength(1);
    expect(hits[0].misplacedMarkerLine).toBeUndefined();

    const message = capViolationMessage('store.ts', hits[0]);
    expect(message).toContain('Interpolate');
    expect(message).toContain('per physical line');
    expect(message).not.toContain('IS present on line');
  });

  it('CONTROL: a marker BEYOND the near-miss radius is not claimed as misplaced', () => {
    // Bounds the claim the message makes. Saying "move THAT marker onto THIS
    // line" about a marker belonging to an unrelated statement would be a
    // confidently wrong instruction — worse than the vague message it replaces.
    const distant = [
      ' * per-scope cap of 50 stated here.',
      ' * filler',
      ' * filler',
      ` * an unrelated historical note. ${HISTORICAL_MARKER}`,
    ].join('\n');

    const hits = hardcodedCapsIn(distant);
    expect(hits).toHaveLength(1);
    expect(hits[0].misplacedMarkerLine).toBeUndefined();
  });
});

/**
 * EI-21393210182770949: the SECOND drift axis on the same prose.
 *
 * The guard above pins the cap NUMBER. Nothing pinned the cap's RANKING
 * EXPLANATION, and it drifted: EI-19483432832662150 changed victim key 2 from
 * an absolute TTL to the remaining FRACTION of the declared TTL, but the
 * eviction receipt kept telling writers that "a SHORT TTL is what makes a fact
 * cheap for the cap to choose, so an urgent short-lived fact is the most likely
 * victim". Under a scale-invariant fraction that is not merely stale, it is
 * BACKWARDS — a short-TTL fact that was just written ranks among the SAFEST.
 *
 * The cost was not theoretical. That sentence is quoted verbatim in the filing
 * of EI-21393210182770949, whose central complaint ("the victim ranking prefers
 * short-TTL facts, so active-incident records are the most likely victims") is
 * true of the RECEIPT and false of the ORDER BY. Measured on
 * workspace/papercusp-workspace at 2026-08-26T10:56Z: the 20 safest live facts
 * included the shortest declared TTL in the comparison (48h) while all 20
 * next-victims had TTLs of at least 168h — the discriminator was remaining
 * fraction (0.984 vs 0.733), not TTL length.
 *
 * Prose that describes ranking behaviour is CODE-DESCRIBING METADATA, so it
 * gets pinned to the ranking rather than hand-maintained beside it.
 */
const TTL_LENGTH_RISK_PATTERNS: readonly RegExp[] = [
  /short[-\s]?(?:ttl|lived)[^.]{0,140}?(?:most likely victim|likel(?:y|ier) victim|cheap(?:er)? for the cap|evicted first|first to (?:go|be evicted))/i,
  /(?:most likely victim|evicted first|first to be evicted)[^.]{0,140}?short[-\s]?(?:ttl|lived)/i,
];

/** Isolated so the falsifiability control can drive it with the real pre-fix string. */
function ttlLengthRiskClaimsIn(text: string): { line: number; claim: string }[] {
  const hits: { line: number; claim: string }[] = [];
  text.split('\n').forEach((line, i) => {
    for (const re of TTL_LENGTH_RISK_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        hits.push({ line: i + 1, claim: m[0] });
        break;
      }
    }
  });
  return hits;
}

describe('fact-cap victim ranking — prose must not claim TTL LENGTH drives eviction risk', () => {
  it('the ranking itself is scale-invariant: a short-TTL fact just written outranks a long-TTL fact near expiry', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    const hour = 3_600_000;
    // The exact pairing the drifted prose got backwards.
    const shortJustWritten = {
      id: 'short-1h-fresh',
      confidence: null,
      created_at: new Date(now - 1 * 60_000).toISOString(),
      expires_at: new Date(now + 59 * 60_000).toISOString(),
      updated_at: new Date(now - 1 * 60_000).toISOString(),
    };
    const longNearlyExpired = {
      id: 'long-7d-stale',
      confidence: null,
      created_at: new Date(now - 166 * hour).toISOString(),
      expires_at: new Date(now + 2 * hour).toISOString(),
      updated_at: new Date(now - 166 * hour).toISOString(),
    };
    const ordered = orderAsSweepWould([longNearlyExpired, shortJustWritten], now);
    expect(
      ordered.map((r) => r.id),
      'the 1h-TTL fact written a minute ago must rank SAFER than the 7d-TTL fact hours from expiry',
    ).toEqual(['short-1h-fresh', 'long-7d-stale']);
  });

  it('TTL length is not a ranking input at all: at equal remaining fraction, order follows updated_at either way', () => {
    // Calibration for the leg above — proves the ordering keyed on the FRACTION
    // rather than merely happening to favour whichever row was newer.
    const now = Date.parse('2026-08-26T12:00:00Z');
    const hour = 3_600_000;
    const halfSpent = (ttlHours: number, id: string, updatedAt: number) => ({
      id,
      confidence: null,
      created_at: new Date(now - (ttlHours / 2) * hour).toISOString(),
      expires_at: new Date(now + (ttlHours / 2) * hour).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
    });
    // Both at fraction 0.5; TTL lengths differ by 168×.
    const shortNewer = halfSpent(1, 'short', now - 1_000);
    const longOlder = halfSpent(168, 'long', now - 2_000);
    expect(orderAsSweepWould([longOlder, shortNewer], now).map((r) => r.id)).toEqual(['short', 'long']);

    // Flip ONLY updated_at: the long-TTL row now wins. TTL length changed nothing.
    const shortOlder = halfSpent(1, 'short', now - 2_000);
    const longNewer = halfSpent(168, 'long', now - 1_000);
    expect(orderAsSweepWould([shortOlder, longNewer], now).map((r) => r.id)).toEqual(['long', 'short']);
  });

  it('no facts-subsystem prose tells a writer that a short TTL makes their fact a likelier victim', () => {
    // POSITIVE CONTROL for the scan itself: a `sourceFiles()` that reached zero
    // files (a moved directory, a renamed suffix) would make this leg — and the
    // cap-literal leg above, which shares the helper — pass vacuously while
    // measuring nothing. Assert the scan actually reaches the file that carries
    // the receipt this guard exists for.
    const scanned = sourceFiles();
    expect(scanned.length, 'sourceFiles() scanned nothing — the guard is measuring no source').toBeGreaterThan(0);
    const receipt = scanned.find((f) => f.path.endsWith(join('agent-tools', 'facts', 'assert.ts')));
    expect(receipt, 'the eviction receipt source was not scanned').toBeDefined();
    expect(receipt!.text, 'assert.ts no longer contains the eviction receipt this guard pins').toContain(
      'Seating this write EVICTED the fact(s) above',
    );

    const violations: string[] = [];
    for (const { path, text } of sourceFiles()) {
      for (const hit of ttlLengthRiskClaimsIn(text)) {
        violations.push(
          `${path}:${hit.line} claims "${hit.claim}". Victim key 2 is the REMAINING ` +
            `FRACTION of the declared TTL (see sweepRemainingFraction), which is ` +
            `scale-invariant — TTL length is not a risk factor, and a short-TTL fact ` +
            `just written is among the SAFEST. Describe the fraction, not the length.`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * FALSIFIABILITY CONTROL (permanent). The real receipt sentence as it stood at
   * 2026-08-26T10:52Z, copied verbatim from the pre-fix source.
   */
  it('CONTROL: the real pre-fix receipt sentence is caught', () => {
    const preFix =
      'matters, re-assert it; note that a SHORT TTL is what makes a fact cheap ' +
      'for the cap to choose, so an urgent short-lived fact is the most likely victim.';
    expect(ttlLengthRiskClaimsIn(preFix).length, 'guard went blind to the pre-fix sentence').toBeGreaterThan(0);
  });

  it('CONTROL: the corrected sentence, which NEGATES the claim, is NOT flagged', () => {
    // Without this the control above would also pass if the predicate simply
    // flagged every line containing the words "short" and "TTL".
    const corrected =
      'Ranking: victims are chosen by confidence tier first (\'verified\' safest), then by the ' +
      'REMAINING FRACTION of the author\'s declared TTL. That fraction is scale-invariant, so ' +
      'TTL LENGTH is not what puts a fact at risk: a short-TTL fact just written ranks among ' +
      'the SAFEST and only yields as it approaches its own expiry.';
    expect(ttlLengthRiskClaimsIn(corrected)).toEqual([]);
  });
});
