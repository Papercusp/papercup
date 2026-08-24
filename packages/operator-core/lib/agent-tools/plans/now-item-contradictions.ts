import type { ParsedPlan } from './parser';

export interface NowItemContradiction {
  id: string;
  status: 'done' | 'dropped';
  mention: string;
}

type TerminalStatus = NowItemContradiction['status'];

const PLAN_ITEM_REF_RE = /\bP-\d{3,}\b/g;
const NOW_CLOSED_RE =
  /\b(?:done|complete(?:d)?|closed|shipped|dropped|finished|terminal|accepted)\b|\bno\s+longer\s+(?:active|open|pending|in\s+progress)\b/i;
const NOW_NEGATED_OR_FUTURE_RE =
  /\b(?:not|never|still|yet|will|would|should|must|need(?:s)?(?:\s+to)?|to)\b/i;
const NOW_HISTORICAL_RE =
  /\b(?:histor(?:y|ical)|prior|previous(?:ly)?|earlier|former(?:ly)?|legacy|archived?|record(?:ed)?)\b/i;
const NOW_ACTION_RE =
  /\b(?:address|audit|claim|close|complete|continue|finish|fix|handle|implement|investigate|pick(?:\s+up)?|reopen|repair|revisit|review|resume|retry|run|start|validate|verify|work)\b/i;

/**
 * PURE: find terminal plan items that the cold-resume Now block still presents
 * as current/future work. Explicit completion prose ("P-001 is done") is
 * allowed, while an action-oriented mention ("finish P-001", "claim P-001")
 * is contradictory. The check is occurrence-based so a Now block may both
 * record an item's completion and accidentally direct a second pass over it.
 */
export function detectNowItemContradictions(parsed: Pick<ParsedPlan, 'now' | 'items'>): NowItemContradiction[] {
  if (!parsed.now) return [];

  const nowText = `${parsed.now.state}\n${parsed.now.next}`;
  const terminalItems = new Map<string, TerminalStatus>();
  for (const item of parsed.items) {
    if (item.storedStatus === 'done' || item.storedStatus === 'dropped') {
      terminalItems.set(item.id, item.storedStatus);
    }
  }
  if (terminalItems.size === 0) return [];

  const contradictions: NowItemContradiction[] = [];
  for (const match of nowText.matchAll(PLAN_ITEM_REF_RE)) {
    const id = match[0];
    const status = terminalItems.get(id);
    if (!status) continue;

    const start = match.index ?? 0;
    const end = start + id.length;
    // Keep the window local to a sentence/clause. This makes a completion note
    // for one item unable to excuse a later action over another item.
    const leftBoundary = Math.max(
      nowText.lastIndexOf('\n', start - 1),
      nowText.lastIndexOf('.', start - 1),
      nowText.lastIndexOf('!', start - 1),
      nowText.lastIndexOf('?', start - 1),
      nowText.lastIndexOf(';', start - 1),
      nowText.lastIndexOf(':', start - 1),
    );
    const rightBoundaries = [
      nowText.indexOf('\n', end),
      nowText.indexOf('.', end),
      nowText.indexOf('!', end),
      nowText.indexOf('?', end),
      nowText.indexOf(';', end),
      nowText.indexOf(':', end),
    ].filter((position) => position !== -1);
    const rightBoundary = rightBoundaries.length > 0 ? Math.min(...rightBoundaries) : nowText.length;
    const clauseStart = leftBoundary + 1;
    const clause = nowText.slice(clauseStart, rightBoundary);
    const refOffset = start - clauseStart;
    const before = clause.slice(0, refOffset);
    const after = clause.slice(refOffset + id.length);
    const closeAfter = NOW_CLOSED_RE.test(after) && !NOW_NEGATED_OR_FUTURE_RE.test(after);
    const closeBefore = NOW_CLOSED_RE.test(before) && !NOW_NEGATED_OR_FUTURE_RE.test(before.slice(-120));
    // A terminal ID may also appear in a compact historical ledger reference,
    // e.g. `Historical promotion record: P-047–P-052/WI-41306–WI-41311`.
    // That is completion context, not a direction to revisit the item. Keep
    // action-oriented historical prose guarded: `Historical note: revisit
    // P-047` must still be rejected as a current-work contradiction.
    const historicalContext = `${nowText.slice(Math.max(0, clauseStart - 120), clauseStart)}${before}`;
    const historicalReference =
      NOW_HISTORICAL_RE.test(historicalContext) &&
      !NOW_ACTION_RE.test(before.slice(-120)) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after);
    if (closeAfter || closeBefore || historicalReference) continue;

    contradictions.push({
      id,
      status,
      mention: clause.trim().slice(0, 180),
    });
  }
  return contradictions.filter((entry, index) => contradictions.findIndex((candidate) => candidate.id === entry.id) === index);
}
