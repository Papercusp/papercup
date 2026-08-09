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
 */
const HISTORICAL_MARKER = 'cap-drift-ok';

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

/** The predicate under test, isolated so the falsifiability control below can
 *  drive it with the real pre-fix strings instead of a synthetic mock. */
function hardcodedCapsIn(text: string): { line: number; literal: string; stated: string }[] {
  const hits: { line: number; literal: string; stated: string }[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(HISTORICAL_MARKER)) return;
    for (const re of CAP_PROSE_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        hits.push({ line: i + 1, literal: m[0], stated: m[1] });
        break;
      }
    }
  });
  return hits;
}

describe('facts per-scope cap — agent-facing prose must derive the number, not type it', () => {
  it('no source file in the facts subsystem states the cap as a literal', () => {
    const violations: string[] = [];
    for (const { path, text } of sourceFiles()) {
      for (const hit of hardcodedCapsIn(text)) {
        violations.push(
          `${path}:${hit.line} says "${hit.literal}" (states ${hit.stated}; ` +
            `the enforced cap is ${FACTS_PER_SCOPE_CAP}). Interpolate ` +
            `\${FACTS_PER_SCOPE_CAP} instead, or mark the line ${HISTORICAL_MARKER} ` +
            `if it is deliberately describing a superseded cap.`,
        );
      }
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
});
