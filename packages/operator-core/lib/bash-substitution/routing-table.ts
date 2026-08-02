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
