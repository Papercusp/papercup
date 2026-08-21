/**
 * D-001's code-intelligence routing table names ONE authority per question
 * class. This judge pins the half of that contract which drifts silently: the
 * guidance surfaces must never put a known-bad RAW backend in a RECOMMENDATION
 * position (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-017).
 *
 * WHY THIS GUARD EXISTS AT ALL. Both banned routes below were live in shipped
 * guidance when P-017 opened, and neither looked wrong while you read it:
 *
 *   - CLAUDE.md routed "code graph / call sites" to `gitnexus.query`. That
 *     intent returns UNRANKED NOISE rather than an empty set — a nonsense
 *     symbol yields ~20 confident-looking rows, and a wrong ARG NAME yields
 *     byte-identical output, proving the search term is never applied
 *     (measured, D-021). Its failure mode is indistinguishable from success,
 *     which is exactly why prose review never catches it.
 *   - Both su playbooks advertised raw `repomix.pack`, which skips the pinned
 *     version and the secret-scanning rails `code:pack` enforces (D-040/D-041).
 *
 * ⚠ THE TRAP THIS JUDGE HAD TO AVOID. A banned tool name legitimately appears
 * in CORRECT guidance — in the "not" column of a routing row, and in the ⚠
 * paragraph that warns against it. A naive `source.includes('gitnexus.query')`
 * would therefore flag the very text that fixes the problem, and the obvious
 * repair (delete the warning) makes the docs WORSE. So position is judged, not
 * presence: only the authority/"use" cell of a table row, and a bolded
 * tool-name bullet, count as recommendations.
 */

/** A raw backend that must never appear in a recommendation position. */
interface BannedRoute {
  readonly tool: string;
  readonly instead: string;
  readonly reason: string;
}

export const BANNED_ROUTES: readonly BannedRoute[] = Object.freeze([
  Object.freeze({
    tool: 'gitnexus.query',
    instead: 'gitnexus.context / gitnexus.impact',
    reason:
      'returns UNRANKED NOISE rather than an empty set, so a wrong answer is indistinguishable from a confident one (D-021)',
  }),
  Object.freeze({
    tool: 'repomix.pack',
    instead: 'code:pack',
    reason:
      'the raw packer skips the pinned version and the secret-scanning rails code:pack enforces (D-040/D-041)',
  }),
]);

export interface RoutingViolation {
  readonly line: number;
  readonly tool: string;
  readonly position: 'authority-cell' | 'recommendation-bullet';
  readonly instead: string;
  readonly reason: string;
  readonly text: string;
}

export interface RoutingVerdict {
  readonly ok: boolean;
  readonly violations: readonly RoutingViolation[];
  /**
   * How many recommendation positions were actually INSPECTED. A verdict with
   * zero of these is vacuous, not clean — the sibling doc-claims guards all
   * carry the same floor, because a parser that silently matched nothing
   * reports `ok: true` and is indistinguishable from a genuinely clean file.
   */
  readonly positionsChecked: number;
}

/**
 * Split a markdown table row into cells on UNESCAPED pipes only.
 *
 * Load-bearing: this repo's tables contain `\|` inside cell text (the
 * `plans:list` row spells an enum as `'updated'\|'created'\|'slug'`). Splitting
 * on a bare `/\|/` shifts every later cell left, so the "use" column being
 * judged silently becomes some other column — a guard that still returns
 * `ok: true` while inspecting the wrong text.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim());
}

const SEPARATOR_ROW = /^\|?\s*:?-{2,}/;

/** A bolded tool-name bullet — `- **\`repomix.pack\`** — pack a repo…` — reads as an endorsement. */
const BOLD_TOOL_BULLET = /^\s*[-*]\s+\*\*`?([A-Za-z_][\w.]*(?:\.[\w]+|:[\w]+))`?\*\*/;

/**
 * Judge one guidance source for banned raw-backend recommendations.
 *
 * Only two positions count as a recommendation:
 *   1. the AUTHORITY cell (index 1) of a markdown routing row — `| question |
 *      use | not |` and the su playbooks' `| the question | the authority |`
 *      both put it there;
 *   2. a bolded tool-name bullet, which is how the su playbooks advertise a
 *      "high-value system".
 * A banned name anywhere else — the "not" column, a ⚠ warning, this docblock —
 * is CORRECT guidance and must not be flagged.
 */
export function judgeCodeIntelRouting(source: string): RoutingVerdict {
  const violations: RoutingViolation[] = [];
  let positionsChecked = 0;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const bullet = BOLD_TOOL_BULLET.exec(line);
    if (bullet) {
      positionsChecked += 1;
      const named = bullet[1]!;
      for (const banned of BANNED_ROUTES) {
        if (named === banned.tool) {
          violations.push({
            line: lineNo,
            tool: banned.tool,
            position: 'recommendation-bullet',
            instead: banned.instead,
            reason: banned.reason,
            text: line.trim(),
          });
        }
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || SEPARATOR_ROW.test(trimmed)) continue;

    // Skip the HEADER row — the one directly above the `|---|` separator. Its
    // authority cell holds a column label, never a tool, so counting it would
    // inflate `positionsChecked` with a row that cannot carry a violation and
    // weaken the vacuity floor that reads it.
    if (SEPARATOR_ROW.test((lines[i + 1] ?? '').trim())) continue;

    const cells = splitRow(line);
    // A routing row needs at least a question and an authority.
    if (cells.length < 2) continue;
    const authority = cells[1]!;
    positionsChecked += 1;

    for (const banned of BANNED_ROUTES) {
      if (authority.includes(banned.tool)) {
        violations.push({
          line: lineNo,
          tool: banned.tool,
          position: 'authority-cell',
          instead: banned.instead,
          reason: banned.reason,
          text: trimmed,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, positionsChecked };
}

/** Render violations for an assertion message that says what to do, not just what failed. */
export function formatRoutingViolations(
  file: string,
  violations: readonly RoutingViolation[],
): string {
  return violations
    .map(
      (v) =>
        `${file}:${v.line} routes to \`${v.tool}\` in a ${v.position} — ${v.reason}. Route to ${v.instead} instead.\n    ${v.text}`,
    )
    .join('\n');
}
