/**
 * Detect measurement-shaped prose in a durable fact.
 *
 * A fact is folded verbatim into future briefs and orients. A number that was
 * true when asserted can therefore become a confident stale claim while the
 * fact still looks authoritative. This is deliberately an advisory detector,
 * not a gate: historical measurements and deliberately pinned values are
 * legitimate, and refusing a fact would turn a warning into a write outage.
 *
 * Precision matters here. A bare number is not enough — release ids, migration
 * numbers, and fixed limits are common in durable conclusions. A numeric value
 * must be close to language that makes it look like a live observation or
 * changing status before we warn.
 */

export const MEASUREMENT_CONTEXT_WINDOW = 80;

// Exclude colon-adjacent digits so a measurement timestamp (20:50Z) or port
// (:3070) does not crowd the advisory ahead of the count/status it describes.
const NUMBER = /(?<![A-Za-z0-9_:#-])(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?%?|\+\d+(?:\s*\/\s*-\d+)?)(?![A-Za-z0-9_:#-])/g;

/** Words that make a nearby number look like a moving observation. */
const MOVING_CONTEXT =
  /\b(?:measur(?:e|ed|ement|ing)|as\s+of|currently|right\s+now|today|latest|so\s+far|observ(?:e|ed|ation)|count(?:s|ed|ing)?|current|remaining|unchecked|adjudicated|candidate[s]?|status|open|closed|pending|supported|not[-\s]checked|working\s+tree|uncommitted)\b/i;

export interface FactMeasurementSignal {
  /** The numeric value or delta that triggered the advisory. */
  value: string;
  /** The moving-state phrase found near the value. */
  context: string;
}

function signalKey(signal: FactMeasurementSignal): string {
  return `${signal.value.toLowerCase()}::${signal.context.toLowerCase()}`;
}

/**
 * PURE. Find numeric values stated alongside measurement-like language.
 *
 * The scan is bounded and fail-soft because facts:assert is a write path. A
 * detector failure must never turn an advisory into a failed fact write.
 */
export function detectFactMeasurements(text: unknown): FactMeasurementSignal[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const haystack = text.length > 20_000 ? text.slice(0, 20_000) : text;
  const out: FactMeasurementSignal[] = [];
  const seen = new Set<string>();
  const numbers = new RegExp(NUMBER.source, NUMBER.flags);
  let match: RegExpExecArray | null;

  while ((match = numbers.exec(haystack)) !== null) {
    if (match[0].length === 0) {
      numbers.lastIndex += 1;
      continue;
    }
    const start = Math.max(0, match.index - MEASUREMENT_CONTEXT_WINDOW);
    const end = Math.min(haystack.length, match.index + match[0].length + MEASUREMENT_CONTEXT_WINDOW);
    const window = haystack.slice(start, end);
    const contextMatch = MOVING_CONTEXT.exec(window);
    if (!contextMatch) continue;

    const signal: FactMeasurementSignal = {
      value: match[0],
      context: contextMatch[0].toLowerCase(),
    };
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

/** Render the write-side advisory, or null when the body is clean. */
export function formatFactMeasurementHint(signals: FactMeasurementSignal[]): string | null {
  if (signals.length === 0) return null;
  const listed = signals
    .slice(0, 3)
    .map((signal) => `"${signal.value}" near "${signal.context}"`)
    .join('; ');
  const more = signals.length > 3 ? ` …and ${signals.length - 3} more` : '';
  return (
    `⚠ this fact body contains ${signals.length} measurement-like value(s): ${listed}${more}. ` +
    'Durable facts are folded VERBATIM into future orients, so a count or status that changes after this write ' +
    'becomes a confident stale claim. Prefer an invariant conclusion plus a pointer to the live source/tool and ' +
    'how to remeasure at use time; if this is intentionally historical, label it historical. Advisory only — the ' +
    'write succeeded and nothing was blocked.'
  );
}

/** Convenience: detect + format in one call. */
export function factMeasurementHint(text: unknown): string | null {
  return formatFactMeasurementHint(detectFactMeasurements(text));
}
