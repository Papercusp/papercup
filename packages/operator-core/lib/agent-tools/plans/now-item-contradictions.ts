import type { ParsedPlan } from './parser';

export interface NowItemContradiction {
  id: string;
  status: 'done' | 'dropped';
  mention: string;
}

type TerminalStatus = NowItemContradiction['status'];

const PLAN_ITEM_REF_RE = /\bP-\d{3,}\b/g;
// EI-21900747713795768: a plan slug immediately preceding a P-NNN mention
// scopes that id to a DIFFERENTLY-NAMED plan explicitly — e.g. "Audited
// under pui-tui-ship-drive-2026-08-30 P-001" is a citation of THAT plan's
// P-001, never this one's, however this plan's own item numbering happens
// to line up (nearly always, since every plan starts at P-001). Every plan
// slug in this system carries a trailing -YYYY-MM-DD suffix (plans:new
// auto-appends the creation date), which makes this a reliable,
// low-false-positive signal — ordinary prose essentially never produces a
// multi-segment kebab-case token ending in a full date immediately before
// a plan-item id.
const PLAN_SLUG_PREFIX_RE = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2})\s+$/i;
const NOW_CLOSED_RE =
  /\b(?:done|complete(?:d)?|closed|shipped|dropped|finished|terminal|accepted)\b|\bno\s+longer\s+(?:active|open|pending|in\s+progress)\b/i;
const NOW_NEGATED_OR_FUTURE_RE =
  /\b(?:not|never|still|yet|will|would|should|must|need(?:s)?(?:\s+to)?|to)\b/i;
const NOW_HISTORICAL_RE =
  /\b(?:histor(?:y|ical)|prior|previous(?:ly)?|earlier|former(?:ly)?|legacy|archived?|record(?:ed)?)\b/i;
const NOW_ACTION_RE =
  /\b(?:address|audit|claim|close|complete|continue|finish|fix|handle|implement|investigate|pick(?:\s+up)?|reopen|repair|revisit|review|resume|retry|run|start|validate|verify|work)\b/i;
const NOW_ACTIVE_RE = /\b(?:active|assigned|in\s+progress|ongoing|open|pending|underway)\b/i;
const NOW_CROSS_LEDGER_REF_BEFORE_RE = /\bWI-\d+\s*\/\s*$/i;
const NOW_CROSS_LEDGER_REF_AFTER_RE = /^\s*\/\s*WI-\d+\b/i;

/**
 * PURE: find terminal plan items that the cold-resume Now block still presents
 * as current/future work. Explicit completion prose ("P-001 is done") is
 * allowed, while an action-oriented mention ("finish P-001", "claim P-001")
 * is contradictory. The check is occurrence-based so a Now block may both
 * record an item's completion and accidentally direct a second pass over it.
 */
export function detectNowItemContradictions(
  parsed: Pick<ParsedPlan, 'now' | 'items' | 'slug'>,
): NowItemContradiction[] {
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
    // Cross-ledger pairs such as `WI-41755/P-006 under D-081` identify the
    // implementation lineage. A neutral mapping remains useful after the plan
    // item closes while verification of the wider affected radius continues;
    // it is not itself an instruction to redo P-006. Keep this exemption
    // evidence-based and narrow: explicit action/future/active wording still
    // means the terminal item is being presented as current work.
    const crossLedgerReference =
      (NOW_CROSS_LEDGER_REF_BEFORE_RE.test(before) || NOW_CROSS_LEDGER_REF_AFTER_RE.test(after)) &&
      !NOW_ACTION_RE.test(historicalContext.slice(-120)) &&
      !NOW_ACTION_RE.test(after) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(historicalContext.slice(-120)) &&
      !NOW_NEGATED_OR_FUTURE_RE.test(after) &&
      !NOW_ACTIVE_RE.test(historicalContext.slice(-120)) &&
      !NOW_ACTIVE_RE.test(after);
    // An explicit "<other-plan-slug> P-NNN" citation scopes the id to that
    // OTHER plan, never this one — see PLAN_SLUG_PREFIX_RE above. Tense/action
    // wording after the id is irrelevant here: the id itself does not name an
    // item of THIS plan, so there is nothing for this plan's terminal-status
    // map to contradict.
    const precedingSlugMatch = PLAN_SLUG_PREFIX_RE.exec(before);
    const explicitForeignPlanReference =
      precedingSlugMatch !== null && precedingSlugMatch[1].toLowerCase() !== parsed.slug.toLowerCase();
    if (closeAfter || closeBefore || historicalReference || crossLedgerReference || explicitForeignPlanReference)
      continue;

    contradictions.push({
      id,
      status,
      mention: clause.trim().slice(0, 180),
    });
  }
  return contradictions.filter((entry, index) => contradictions.findIndex((candidate) => candidate.id === entry.id) === index);
}
