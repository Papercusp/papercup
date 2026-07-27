/**
 * EI-18803497769946984 — the recurrence guard for the "ambient workspace transaction
 * held across slow non-DB work" class.
 *
 * ## The class
 *
 * `dispatchWithSynthesizedTx` (endpoint-route/routes/transport/_mcp-handler.ts) holds a
 * `withWorkspace` transaction open for a projected tool's ENTIRE handler. That is fine
 * for the overwhelming majority of tools (fast, and many read/write via `ctx.tx`), but a
 * handler that BLOCKS a long time doing no `ctx.tx` queries of its own leaves that
 * transaction sitting IDLE. Once idle time passes Postgres's
 * `idle_in_transaction_session_timeout` (60s on this deployment) the backend is killed,
 * PgBouncer reports `server conn crashed?`, and the CALLER receives a bare
 *
 *     write CONNECTION_CLOSED 127.0.0.1:6432
 *
 * — an error naming neither the tool nor the cause, which reads as a PgBouncer/infra
 * outage. It was diagnosed as a pooler problem three separate times while running ~31
 * kills/day. A tool opts out with `skipWorkspaceTx: true`.
 *
 * ## Why a test rather than another code comment
 *
 * The class had already been root-caused TWICE (EI-18666279107998059 for
 * capability:bash, EI-18733783500981433 for release:deploy) and documented at length in
 * the dispatcher — and it still recurred, because the fix was applied one tool at a time,
 * each only AFTER that tool had failed in production. Prose in a header cannot fail a
 * build. This can.
 *
 * The invariant below is deliberately mechanical: *shelling out to a child process* is a
 * strong, greppable proxy for "this handler blocks on something that is not the
 * database". It is not a complete characterisation of the class — a handler can block on
 * a slow HTTP call with no child process — but it is decidable from source, and every
 * confirmed instance of the class so far has matched it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentToolsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Tools that spawn a child process yet legitimately hold the workspace tx.
 *
 * Adding an entry is a real claim: the handler both shells out AND reads `ctx.tx`, so it
 * genuinely needs the ambient transaction. Pair it with the reason — and prefer
 * restructuring the handler (do the DB work in its own short transaction, then shell out)
 * over adding an exception, because an entry here re-arms the class for that tool.
 */
const ALLOW: ReadonlyMap<string, string> = new Map();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue;
      out.push(...walk(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.integration.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** A file that defines a projected tool, i.e. carries a `name: 'group:verb'` literal. */
const DEFINES_TOOL = /name:\s*'[a-z][a-z0-9_]*:[a-z0-9_]+'/;
/** A file whose handler shells out — the proxy for "blocks on non-DB work". */
const SPAWNS_CHILD = /from\s+['"]node:child_process['"]|require\(['"](?:node:)?child_process['"]\)/;
const OPTS_OUT = /skipWorkspaceTx:\s*true/;

describe('idle-tx recurrence guard (EI-18803497769946984)', () => {
  it('every tool that shells out to a child process declares skipWorkspaceTx', () => {
    const offenders: string[] = [];

    for (const file of walk(agentToolsDir)) {
      const src = readFileSync(file, 'utf8');
      if (!DEFINES_TOOL.test(src)) continue;
      if (!SPAWNS_CHILD.test(src)) continue;
      if (OPTS_OUT.test(src)) continue;

      const rel = relative(agentToolsDir, file);
      if (ALLOW.has(rel)) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
      `These tools spawn a child process while holding the dispatcher's ambient workspace ` +
        `transaction. If the handler blocks past idle_in_transaction_session_timeout (60s) ` +
        `the backend is killed and the caller sees a bare ` +
        `"write CONNECTION_CLOSED 127.0.0.1:6432" that names neither the tool nor the cause.\n\n` +
        `Fix: add \`skipWorkspaceTx: true\` to the tool definition (correct whenever the ` +
        `handler never reads ctx.tx — which is nearly always).\n` +
        `If it genuinely needs the tx, add it to ALLOW in this file with the reason.\n\n` +
        `Offenders:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    ).toEqual([]);
  });

  it('tools:invoke opts out — a delegator holds a tx for its TARGET\'s whole runtime', () => {
    // The subtle half of the class, and the reason it survived two prior root-causes.
    // tools:invoke spawns no child process of its own, so the invariant above cannot see
    // it — but it awaits ctx.dispatchTool(...) for the full duration of an ARBITRARY
    // target. That made fixing only the inner tool a no-op on this path: release:deploy
    // and capability:bash both carried skipWorkspaceTx and STILL failed at ~60s when
    // reached through tools:invoke, because the delegator held its own transaction. Each
    // incident killed a PAIR of backends from one process — outer delegator + inner tool.
    const src = readFileSync(join(agentToolsDir, 'tools', 'invoke.ts'), 'utf8');
    expect(OPTS_OUT.test(src)).toBe(true);
  });
});
