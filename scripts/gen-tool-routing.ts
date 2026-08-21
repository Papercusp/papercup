/**
 * gen-tool-routing.ts — project the audited bash→tool substitution pairs into the
 * CLAUDE.md routing table (plan `bash-to-tool-substitution-2026-07-26`, P-019).
 *
 *   npm run gen:tool-routing          # update the canonical part and project client files
 *   npm run gen:tool-routing:check    # fail (exit 1) if the canonical part is stale
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
 * The pairs remain the deterministic build input, but the generated block is a
 * part of the composed `claude-md` document. The write path therefore goes
 * through `set-doc-part.ts` (which validates and records the part row) and then
 * `project-doc-parts.mjs` (which is the only writer of `CLAUDE.md`/`AGENTS.md`).
 *
 * `--check` compares the rendered block with the canonical part row, so a
 * projected file cannot mask a database-side change. A row inserted DIRECTLY
 * into the runtime substitution table with a novel `intent_label` remains the
 * separate registry-drift concern documented by `registry-drift.ts`.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_PAIRS } from '../packages/operator-core/lib/bash-substitution/pairs';
import { renderRoutingBlock } from '../packages/operator-core/lib/bash-substitution/routing-table';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_ID = 'claude-md';
const ROUTING_PART_KEY = 'reaching-for-bash-these-read-begin-generated-gen';
const SET_DOC_PART = join(REPO_ROOT, 'scripts/set-doc-part.ts');
const PROJECT_DOC_PARTS = join(REPO_ROOT, 'scripts/project-doc-parts.mjs');
const CHECK = process.argv.includes('--check');

function nodeScript(script: string, args: string[], input?: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'],
  });
}

function readCanonicalRoutingPart(): string {
  const body = nodeScript(SET_DOC_PART, [
    '--doc-id',
    DOC_ID,
    '--part-key',
    ROUTING_PART_KEY,
    '--show',
  ]);

  // `set-doc-part --show` writes through writeStdoutSync, whose safety contract
  // appends one line terminator before the child exits. The generated block has
  // no trailing newline, so remove that transport terminator before comparing it
  // with renderRoutingBlock. Without this, --check reports false drift and the
  // guarded write then correctly refuses the identical body.
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

function writeCanonicalRoutingPart(body: string): void {
  nodeScript(
    SET_DOC_PART,
    ['--doc-id', DOC_ID, '--part-key', ROUTING_PART_KEY, '--body-stdin', '--write'],
    body,
  );
}

function projectCanonicalDocs(): void {
  nodeScript(PROJECT_DOC_PARTS, ['--write']);
}

function main(): void {
  const expected = renderRoutingBlock(ALL_PAIRS);
  const current = readCanonicalRoutingPart();

  if (current === expected) {
    process.stdout.write('✓ canonical CLAUDE.md routing part is up to date\n');
    if (!CHECK) projectCanonicalDocs();
    return;
  }
  if (CHECK) {
    process.stderr.write(
      '✗ canonical CLAUDE.md routing part is stale — run `npm run gen:tool-routing`\n' +
        '  (the audited pairs changed; the canonical part every projected client reads must follow them)\n',
    );
    process.exit(1);
  }
  writeCanonicalRoutingPart(expected);
  projectCanonicalDocs();
  process.stdout.write('✓ updated and projected the canonical CLAUDE.md routing part\n');
}

main();
