/**
 * gen-tool-routing.ts — project the audited bash→tool substitution pairs into the
 * CLAUDE.md routing table (plan `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 *   npm run gen:tool-routing          # rewrite the block in CLAUDE.md
 *   npm run gen:tool-routing:check    # fail (exit 1) if the block is stale
 *
 * This file is only the I/O shell. All the rendering — and every decision about
 * what may appear in the table — lives in
 * `packages/operator-core/lib/bash-substitution/routing-table.ts`, so it is unit
 * testable without touching the filesystem and so the dependency runs
 * `scripts/ → packages/` and never the reverse.
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
 * KNOWN LIMIT of reading the pairs: a row inserted DIRECTLY into the table with a
 * novel `intent_label` would be enforced by both hooks yet never appear here, and
 * this generator cannot see that drift direction. Nothing does that today (the
 * seeder is the only writer), so the trade for a DB-free hard gate is worth it —
 * an optional cross-check that skips when no PG is reachable would close it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_PAIRS } from '../packages/operator-core/lib/bash-substitution/pairs';
import {
  renderRoutingBlock,
  spliceRoutingBlock,
} from '../packages/operator-core/lib/bash-substitution/routing-table';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');
const CHECK = process.argv.includes('--check');

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

main();
