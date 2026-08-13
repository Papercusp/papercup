/**
 * The CLAUDE.md routing-table projection — pure rendering, no I/O (plan
 * `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 * `scripts/gen-tool-routing.ts` is the thin CLI around this: it reads CLAUDE.md,
 * calls {@link spliceRoutingBlock} with {@link renderRoutingBlock}, and either
 * writes or fails. Everything decidable without touching the filesystem lives
 * HERE so it is unit-testable and so the dependency runs `scripts/ → packages/`,
 * never the reverse (a package must not import build tooling).
 *
 * WHY A GENERATED TABLE. The audit behind this plan found the bash→tool problem
 * is routing, not capability: `dev:pg_query` was the only shell-replacing tool
 * with a CLAUDE.md routing row, and the only one with real adoption (~85% against
 * ~1%). A hand-maintained table drifts from the gate that enforces it, which is
 * worse than no table — it teaches a routing the hook does not apply, to every
 * agent, since CLAUDE.md is spliced into every agent prompt. So the table is
 * generated and CI fails on drift.
 */
import type { SubstitutionPair } from './types';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->';
export const END_MARKER = '<!-- END GENERATED gen:tool-routing -->';

/**
 * A table-cell-safe rendering. Escapes ONLY the pipe — deliberately NOT the
 * backslash, unlike `scripts/lib/doc-projection.ts`'s `cell()`.
 *
 * That difference is load-bearing, not an oversight. These cells are mostly code
 * spans, and markdown does not process backslash escapes inside a code span: an
 * escaped `\\d` renders LITERALLY as `\\d`, so the psql-describe row would
 * advertise a command that does not exist. A pipe still must be escaped, and GFM
 * honours `\|` in a table cell even inside a code span, because cell splitting
 * happens before inline parsing.
 */
export function routingCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the generated block: the marker pair, a do-not-edit warning, and one row
 * per pair in the given order (`ALL_PAIRS` is registry order), so the output is a
 * pure function of the pairs and cannot reorder between runs.
 *
 * Only `equivalent` pairs are emitted. A `needs-widening` / `not-a-substitute` /
 * `unaudited` verdict must never appear as routing advice — D-001's point is that
 * a pattern whose replacement is unproven is not enforced, and advertising it in
 * every agent's prompt would be the same harm one layer up: it would send agents
 * to a tool that cannot do the job.
 *
 * ...with ONE exception, which is the mirror of that same principle: a pair
 * carrying a `policyTier` is ENFORCED, on authority granted elsewhere (D-003 —
 * a rule that already existed independently of this plan), not on a verdict
 * derived here. Filtering such a row out would leave agents blocked by a gate
 * with no documentation of what to do instead, which is a worse failure than the
 * one this filter prevents. The rule is real whether or not the corpus happens to
 * contain enough of it to audit.
 *
 * That case stopped being hypothetical at P-002: correcting the atomizer (D-047)
 * dropped `deps.unsafe-install`'s population from 28 atoms to 18 — below the
 * census floor — so its verdict became `unaudited` while its `deny` tier stood
 * untouched.
 *
 * `tier` is deliberately absent. It is promotion state (observe → advise → deny)
 * earned by P-020's observation window and lives only in the database. The table
 * states what the right tool IS — stable guidance; how hard the gate currently
 * enforces it is a separate, changing concern, and a doc that churned on every
 * promotion would be noise in every agent's prompt.
 */
export function renderRoutingBlock(pairs: SubstitutionPair[]): string {
  const rows = pairs
    .filter((p) => p.expectedVerdict === 'equivalent' || p.policyTier != null)
    .map(
      (p) =>
        `| ${routingCell(p.routing.want)} | ${routingCell(p.routing.use)} | ${routingCell(
          p.routing.insteadOf,
        )} |`,
    );

  return [
    BEGIN_MARKER,
    '',
    '> Generated from the audited substitution pairs — run `npm run gen:tool-routing`.',
    '> Every row below is backed by an `equivalent` verdict computed from a frozen',
    '> sample of real commands (`packages/operator-core/lib/bash-substitution/`), and',
    '> the PreToolUse gate enforces the SAME registry. Do not hand-edit: the source is',
    '> `pairs/*.ts`, and `npm run gen:tool-routing:check` fails the build on drift.',
    '> Adding a row, promoting one, or arguing with a gate that blocked you:',
    '> [bash vs tool routing](/internal/docs/agent-insights/bash-vs-tool-routing).',
    '>',
    '> ⚠ ToolSearch finding NOTHING for a `use` tool does not mean it is unavailable to you —',
    '> a trimmed surface (su) exposes only a seed of the ~550-tool catalog, so the exact',
    '> `select:` name and a keyword search can both come back empty for a tool that exists.',
    '> `tools:invoke { name: "<server:verb>", args: {…} }` dispatches ANY catalog tool',
    '> server-side, gated identically to a direct call. Verified end-to-end for `testing:run`',
    '> (EI-19463947683316510). Reach for that before falling back to the `not` column.',
    '',
    '| you want | use | not |',
    '|---|---|---|',
    ...rows,
    '',
    END_MARKER,
  ].join('\n');
}

/**
 * Splice the rendered block between the markers in `content`.
 *
 * Throws rather than no-oping when the markers are missing: a generator that
 * silently wrote nothing would report success while the table went stale forever,
 * which is precisely the drift this projection exists to prevent.
 */
export function spliceRoutingBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `gen-tool-routing: markers not found in CLAUDE.md. Expected:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  }
  if (end < start) {
    throw new Error('gen-tool-routing: END marker precedes BEGIN marker in CLAUDE.md');
  }
  return content.slice(0, start) + block + content.slice(end + END_MARKER.length);
}

/* ── The THIRD routing surface: CLAUDE.md's hand-written storage-policy table ──
 *
 * WI-38337 / D-010. An agent reads three surfaces that each name a verb for a
 * relation: the live in-query advisory (`TOOL_ROUTING_BY_TABLE`), the GENERATED
 * block above, and a HAND-WRITTEN table under "## Storage policy". Only the first
 * two were machine-checked against the audited pairs, so a hand-written row could
 * say "use `issues:list` for work_items" while an audited pair routes the same
 * relation to `work_items:list`, and the whole suite would stay green. The two
 * tables are read by the same agent minutes apart.
 *
 * WHY PARSE INSTEAD OF GENERATE (D-010). The hand-written table is INTENT-level
 * guidance and legitimately names verbs no audited pair claims (`plans:items`,
 * `search:semantic`, `gitnexus.query`); the generated one is COMMAND-level
 * substitution earned at 100% coverage. Folding either into the other would
 * delete honest guidance or manufacture pairs to justify prose. They may differ
 * in COVERAGE — they must never CONTRADICT, and only the second is checkable.
 *
 * WHY A HEADING ANCHOR AND NOT MARKERS. The obvious fix is to wrap the region in
 * BEGIN/END markers like the generated block. It is not available: CLAUDE.md is
 * itself PROJECTED from `harness_shared.harness_doc_parts`, so markers would have
 * to be added to the part in Postgres, and a hand-edit of the file is exactly what
 * that projection exists to refuse. Anchoring on the heading needs no write at
 * all — at the cost that a reworded heading silently un-anchors the parser, which
 * is why both failure modes below THROW rather than return an empty list.
 */

/** The heading the hand-written routing table lives under. */
export const STORAGE_POLICY_HEADING = '## Storage policy: Postgres by default';

/** One parsed row of the hand-written table. */
export interface HandWrittenRoutingRow {
  /** The intent cell — what the agent wants. */
  want: string;
  /** The recommendation cell. */
  use: string;
  /** The cell naming the shape being replaced. */
  not: string;
  /** `server:verb` tokens named in {@link use}. */
  verbs: string[];
  /** Known relation names appearing in {@link not}, word-boundary matched. */
  relations: string[];
}

/** Split one markdown table row into cells, honouring `\|` inside a cell. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Parse the hand-written storage-policy routing table.
 *
 * `knownRelations` is matched with a WORD BOUNDARY on purpose, and it is the one
 * subtlety here: the table's claimable row names the VIEW `work_items_claimable`,
 * and a substring match would read that as the `work_items` relation and then
 * report a contradiction because the row routes to `work_items:claimable` rather
 * than to a pair's verb. `\b` does not match between `work_items` and `_claimable`
 * (both sides are word characters), so the view stays a distinct relation.
 *
 * THROWS on a missing heading or a heading with no table rows. Returning `[]`
 * would make every downstream assertion pass vacuously — the failure mode this
 * whole guard exists to end, one level up.
 */
export function parseStoragePolicyRoutingTable(
  doc: string,
  knownRelations: readonly string[],
): HandWrittenRoutingRow[] {
  const start = doc.indexOf(STORAGE_POLICY_HEADING);
  if (start === -1) {
    throw new Error(
      `routing-table: "${STORAGE_POLICY_HEADING}" not found in CLAUDE.md — the hand-written ` +
        'routing table is anchored on that heading; if it was reworded, update STORAGE_POLICY_HEADING.',
    );
  }
  const rest = doc.slice(start + STORAGE_POLICY_HEADING.length);
  const nextHeading = rest.search(/\n##\s/);
  const region = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const rows: HandWrittenRoutingRow[] = [];
  for (const line of region.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = tableCells(trimmed);
    if (cells.length < 3) continue;
    // The header row and the `|---|` separator are structure, not data.
    if (/^-{2,}$/.test(cells[0]!.replace(/[:\s]/g, ''))) continue;
    if (cells[0]!.toLowerCase() === 'you want') continue;
    const [want, use, not] = cells as [string, string, string];
    rows.push({
      want,
      use,
      not,
      verbs: [...use.matchAll(/\b([a-z][\w-]*:[a-z][\w-]*)\b/g)].map((m) => m[1]!),
      relations: knownRelations.filter((r) =>
        new RegExp(String.raw`\b${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(not),
      ),
    });
  }

  if (rows.length === 0) {
    throw new Error(
      `routing-table: found "${STORAGE_POLICY_HEADING}" but no table rows under it — the parser ` +
        'is anchored but blind, which would make every routing-agreement assertion pass vacuously.',
    );
  }
  return rows;
}
