/**
 * gen-tool-routing.ts — project the audited bash→tool substitution pairs into the
 * CLAUDE.md routing table (plan `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 * WHY THIS EXISTS. The plan's central evidence is a routing effect, not a
 * capability effect: `dev:pg_query` is the only tool with a CLAUDE.md routing row
 * and the only tool with real adoption (~85%, against ~1% for tools that have no
 * row). Tools nobody is routed to go unused however good they are. So the table
 * is the lever — and a hand-maintained table drifts from the gate that enforces
 * it, which is worse than no table: it teaches a routing the hook does not apply,
 * or applies one the table never mentions.
 *
 * So the table is GENERATED and the build FAILS when it drifts:
 *
 *   npm run gen:tool-routing          # rewrite the block in CLAUDE.md
 *   npm run gen:tool-routing:check    # fail (exit 1) if the block is stale
 *
 * SOURCE OF TRUTH, and why this does not contradict D-002. D-002 makes
 * `harness_shared.bash_tool_substitutions` the runtime source both PreToolUse
 * hooks read. But nothing hand-authors those rows: `seed.ts` DERIVES every one
 * from `ALL_PAIRS` plus the committed corpus fixtures, and refuses a row whose
 * recorded verdict it cannot re-derive. The pairs are therefore UPSTREAM of the
 * table, and generating from them means the prose, the seeded rows, and the
 * enforcement all descend from the same artifact.
 *
 * Reading the pairs rather than the database also makes this a HARD build gate
 * instead of an advisory one: no Postgres, no network, deterministic in CI. (The
 * PG-sourced projectors like `gen-doc-plans-index` must degrade to advisory
 * precisely because they cannot run without a DB.)
 *
 * WHAT IS DELIBERATELY NOT SHOWN. `tier` is promotion state (observe → advise →
 * deny) earned by P-020's observation window, and it lives only in the database —
 * `seed.ts` will not overwrite it. It is intentionally absent from the table: the
 * table states what the right tool IS, which is stable guidance; how hard the
 * gate currently enforces it is a separate, changing concern, and a doc that
 * churned on every promotion would just be noise in every agent's prompt.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_PAIRS } from '../packages/operator-core/lib/bash-substitution/pairs';
import type { SubstitutionPair } from '../packages/operator-core/lib/bash-substitution/types';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const CHECK = process.argv.includes('--check');

export const BEGIN_MARKER = '<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->';
export const END_MARKER = '<!-- END GENERATED gen:tool-routing -->';

/**
 * A table-cell-safe rendering. Escapes ONLY the pipe — deliberately NOT the
 * backslash, unlike `scripts/lib/doc-projection.ts`'s `cell()`.
 *
 * That difference is load-bearing, not an oversight. These cells are mostly code
 * spans, and markdown does not process backslash escapes inside a code span: an
 * escaped `\\d` renders literally as `\\d`, so `psql -c "\d table"` would come
 * out wrong. A pipe still must be escaped, and GFM honours `\|` in a table cell
 * even inside a code span, because cell splitting happens before inline parsing.
 */
export function routingCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render the generated block: the marker pair, a "generated" warning, and one row
 * per audited pair, in registry order (`ALL_PAIRS`) so the output is a pure
 * function of the pairs and cannot reorder between runs.
 *
 * Only `equivalent` pairs are emitted. A `needs-widening` or `not-a-substitute`
 * verdict must NEVER appear as routing advice — D-001's whole point is that a
 * pattern whose replacement is unproven is not enforced, and advertising it in
 * every agent's prompt would be the same mistake one layer up: it would send
 * agents to a tool that cannot do the job.
 */
export function renderRoutingBlock(pairs: SubstitutionPair[]): string {
  const rows = pairs
    .filter((p) => p.expectedVerdict === 'equivalent')
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
    "> Every row below is backed by an `equivalent` verdict computed from a frozen",
    '> sample of real commands (`packages/operator-core/lib/bash-substitution/`), and',
    '> the PreToolUse gate enforces the SAME registry. Do not hand-edit: the source is',
    '> `pairs/*.ts`, and `npm run gen:tool-routing:check` fails the build on drift.',
    '',
    '| you want | use | not |',
    '|---|---|---|',
    ...rows,
    '',
    END_MARKER,
  ].join('\n');
}

/** Splice the rendered block between the markers in `content`. */
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

function main(): void {
  const current = readFileSync(CLAUDE_MD, 'utf8');
  const next = spliceRoutingBlock(current, renderRoutingBlock(ALL_PAIRS));

  if (current === next) {
    process.stdout.write('✓ CLAUDE.md routing table is up to date\n');
    return;
  }
  if (CHECK) {
    process.stderr.write(
      '✗ CLAUDE.md routing table is stale — run `npm run gen:tool-routing`\n' +
        '  (the audited pairs changed; the table every agent reads must follow them)\n',
    );
    process.exit(1);
  }
  writeFileSync(CLAUDE_MD, next);
  process.stdout.write('✓ wrote the CLAUDE.md routing table\n');
}

// Only run when executed directly, so the unit test can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
