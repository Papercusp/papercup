/**
 * item-parse-feedback — shared item-parse feedback for the plan-BODY writers
 * (plans:new, plans:set-content, plans:set-content-chunk).
 *
 * A plan body is written verbatim; its items are only parsed on READ. So a
 * body whose "items" don't match the strict item-line grammar
 * (`- **P-001** `todo` text`) is accepted with ZERO items and no signal — the
 * caller only discovers it on a later plans:get and burns extra tool calls.
 * These helpers let a body-writer return the parse result IN THE SAME CALL:
 * how many items parsed, the parsed items echoed (so no follow-up plans:get is
 * needed), and — when list-like lines look like items but did not parse — a
 * hint naming the exact grammar and the real tools to fix it (plans:set-content
 * / plans:add-item).
 *
 * Extracted from plans/new.ts (WI-3362 → WI-3363) so all three body-writers
 * share one implementation. Pure — no I/O; calls only @papercusp/plan-parser.
 */

import { ITEM_STATUSES, parsePlan, maskFences } from './parser';

/** A parsed item, echoed back so the caller never needs a follow-up plans:get
 *  just to confirm the items registered. */
export interface EchoedItem {
  id: string;
  status: string;
  phase?: string;
  text: string;
}

/** A body line that LOOKS like an attempted plan item but did not parse. */
export interface UnparsedItemLine {
  /** 1-indexed line number within the scanned body. */
  line: number;
  text: string;
}

/** The parse-feedback block a body-writer folds into its success payload. */
export interface ItemParseSummary {
  itemsParsed: number;
  items: EchoedItem[];
  unparsedItemLines?: number;
  unparsedSamples?: UnparsedItemLine[];
  hint?: string;
}

export interface SummarizeOptions {
  /** Whether the caller supplied a body at all. plans:new uses this to tell an
   *  intentional empty starter template (no body) from a body that yielded 0
   *  items. set-content/-chunk always supply a body, so they pass true. */
  bodyProvided: boolean;
  /**
   * Emit a hint merely because a provided body parsed to 0 items. plans:new
   * wants this (a fresh plan whose body yielded no items is almost always a
   * formatting miss). set-content / set-content-chunk do NOT — a prose-only
   * rewrite legitimately has 0 items, and telling a set-content caller to "use
   * set-content" is circular; for them only genuinely-unparsed lines warrant a
   * hint. Default false.
   */
  hintOnZeroItems?: boolean;
}

const ITEM_ECHO_CAP = 50;
const UNPARSED_SAMPLE_CAP = 5;

/** The canonical item-line grammar, phrased for a hint / error message. */
const ITEM_GRAMMAR =
  '`- **P-001** `todo` your text` (a bullet, the id in **bold**, a status token in `backticks` from ' +
  ITEM_STATUSES.join('|') +
  ', then the text)';

/**
 * Detect list-like lines in a plan body that LOOK like attempted plan items
 * but did NOT parse — the silent-drop trap this module exists to close. Before
 * it, a body-writer accepted a body like `- [ ] do X` (or `- P-001 do X`) and
 * wrote a plan with ZERO items and no signal; the caller only discovered it on
 * a later plans:get.
 *
 * HIGH-PRECISION by design — a plain prose bullet in ## Background is NEVER
 * flagged. A list-like line counts as an "attempted item" only when it is a
 * `[ ]` checkbox, OR carries a `P-NNN` token, OR sits under a `## Phase`
 * heading (where content is items by convention). Lines inside fenced code
 * blocks and inside the ## Now / ## Decisions sections are ignored, matching
 * the parser. `parsedItemRawLines` is the set of lines the parser DID accept,
 * so a correctly-formatted item is never re-flagged.
 */
export function detectUnparsedItemLines(
  writtenBody: string,
  parsedItemRawLines: ReadonlySet<string>,
): UnparsedItemLine[] {
  // maskFences blanks fenced regions to spaces (line count + length preserved),
  // so a `- **P-001**` inside a worked-example fence is never mis-flagged —
  // exactly how the parser treats fences.
  const maskedLines = maskFences(writtenBody).split('\n');
  const realLines = writtenBody.split('\n');
  const out: UnparsedItemLine[] = [];
  let skipSection = false; // inside ## Now or ## Decisions
  let underPhase = false; // inside a ## Phase… section

  for (let i = 0; i < maskedLines.length; i++) {
    const masked = maskedLines[i] ?? '';
    const real = realLines[i] ?? '';

    const heading = /^(#{1,2})\s+(.*)$/.exec(masked);
    if (heading) {
      const norm = (heading[2] ?? '').replace(/^\d+(?:\.\d+)?\.\s+/, '').trim();
      skipSection = /^(Now|Decisions)$/i.test(norm);
      underPhase = /^Phase\b/i.test(norm);
      continue;
    }
    if (skipSection) continue;
    // A line the parser DID accept as an item — never re-flag it.
    if (parsedItemRawLines.has(real)) continue;

    const isBullet = /^\s*[-*+]\s+/.test(masked);
    const isOrdered = /^\s*\d+\.\s+/.test(masked);
    if (!isBullet && !isOrdered) continue;

    const isCheckbox = /^\s*[-*+]\s+\[[ xX]\]/.test(masked);
    const hasPNN = /\bP-\d{3,}\b/.test(masked);
    if (!(isCheckbox || hasPNN || underPhase)) continue;

    out.push({ line: i + 1, text: real.trim().slice(0, 160) });
  }
  return out;
}

/**
 * Parse a just-written plan body and produce the parse-feedback block:
 * itemsParsed + the parsed items echoed back + (when list-like lines look like
 * items but did not parse, OR — with hintOnZeroItems — a provided body yielded
 * zero items) a hint naming the exact grammar AND the real tools to fix it
 * (plans:set-content / plans:add-item).
 *
 * Pure (no I/O).
 */
/**
 * Parse `body` and return the item with `itemId` in its ECHOED form
 * ({ id, status, phase?, text }), or null if that id is not present as a
 * parsed item. Used by the structured item-appenders (plans:add-item) to
 * confirm the line they just built round-trips to the item they intended —
 * catching the edge where multi-line / grammar-breaking text silently
 * corrupts the written line. Pure.
 */
export function echoParsedItem(body: string, itemId: string): EchoedItem | null {
  const it = parsePlan(body).items.find((i) => i.id === itemId);
  if (!it) return null;
  return {
    id: it.id,
    status: it.storedStatus,
    ...(it.phase ? { phase: it.phase } : {}),
    text: it.text.length > 200 ? it.text.slice(0, 200) + '…' : it.text,
  };
}

export function summarizeItemParse(
  writtenBody: string,
  opts: SummarizeOptions,
): ItemParseSummary {
  const parsed = parsePlan(writtenBody);
  const parsedRawLines = new Set(parsed.items.map((it) => it.rawLine));
  const unparsed = detectUnparsedItemLines(writtenBody, parsedRawLines);

  const items: EchoedItem[] = parsed.items.slice(0, ITEM_ECHO_CAP).map((it) => ({
    id: it.id,
    status: it.storedStatus,
    ...(it.phase ? { phase: it.phase } : {}),
    text: it.text.length > 200 ? it.text.slice(0, 200) + '…' : it.text,
  }));

  const summary: ItemParseSummary = { itemsParsed: parsed.items.length, items };

  if (unparsed.length > 0) {
    summary.unparsedItemLines = unparsed.length;
    summary.unparsedSamples = unparsed.slice(0, UNPARSED_SAMPLE_CAP);
    summary.hint =
      unparsed.length +
      ' line(s) look like plan items but did NOT parse — an item MUST be ' +
      ITEM_GRAMMAR +
      '. Plain `- ` or `- [ ] ` bullets are ignored. Fix the item lines and rewrite the body with plans:set-content, or append items one at a time with plans:add-item.';
  } else if (opts.hintOnZeroItems && opts.bodyProvided && parsed.items.length === 0) {
    summary.hint =
      'The body parsed to 0 items. If you intended items, each MUST be ' +
      ITEM_GRAMMAR +
      '. Rewrite the body with plans:set-content, or append one with plans:add-item.';
  }

  return summary;
}
