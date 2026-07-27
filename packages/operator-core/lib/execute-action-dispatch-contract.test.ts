/**
 * Dispatch-contract lint (agent-trap-guards-2026-07-26 P-002): every string
 * op-code a caller sends toward execute-action's dispatcher must resolve to a
 * LIVE branch in dispatchAction()'s switch. This is the guard that would have
 * caught P-001 (EI-18740258166031188) at commit time: `OperatorPanel.tsx`
 * kept posting `op:'send_message'` across an HTTP boundary for as long as it
 * took to notice in production, because the coupling is a bare string, not an
 * import — invisible to `lint:no-retired` (imports only) and to `tsc` (which
 * only type-checks a caller that constructs the typed `ExecuteAction` union
 * in-process; `tasks/create.ts` and `spawn-child.ts` already get that for
 * free). This test is the static, cheap substitute for the runtime probe: a
 * registry (parsed straight out of the real switch, so it cannot drift from
 * it) + an assertion, per P-002's own instruction.
 *
 * Pure-static — no operator process, no network, no PG:
 *   - LIVE_OPS = the `case '<op>':` labels inside dispatchAction()'s own
 *     switch, parsed directly from execute-action.ts's source text. There is
 *     deliberately no second hand-maintained list to fall out of sync with
 *     the real dispatch table.
 *   - EMITTED_OPS = every `op: '<literal>'` found in a source file that also
 *     references the dispatch surface (`/api/agent-mcp/operator-dispatch`,
 *     `executeAction(`, or `dispatchAction(`), scanned across the app +
 *     server trees (excluding execute-action.ts + its test, which DEFINE the
 *     surface rather than call it). Comments are stripped before matching —
 *     the plan's own P-005 lesson (substring/mention false positives) applies
 *     here too: `lib/dbos/notify-parent-done.ts` documents the RETIRED
 *     `dispatchAction({op:'send_message'})` path in a comment, which must
 *     never be counted as a live emission.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../');

// ─── LIVE_OPS: parsed straight from dispatchAction()'s own switch ───────────

const EXECUTE_ACTION_PATH = join(__dirname, 'execute-action.ts');
const EXECUTE_ACTION_SRC = readFileSync(EXECUTE_ACTION_PATH, 'utf8');

function extractDispatchBody(src: string): string {
  const start = src.indexOf('export async function dispatchAction');
  if (start < 0) {
    throw new Error('dispatchAction() not found in execute-action.ts — has it been renamed/moved?');
  }
  const end = src.indexOf('export async function executeAction', start);
  if (end < 0) {
    throw new Error('executeAction() not found after dispatchAction() in execute-action.ts — scan bound is stale');
  }
  return src.slice(start, end);
}

const LIVE_OPS = new Set<string>();
for (const m of extractDispatchBody(EXECUTE_ACTION_SRC).matchAll(/case\s+'([a-zA-Z0-9_]+)':/g)) {
  LIVE_OPS.add(m[1]);
}

// ─── EMITTED_OPS: every op:'literal' in a file referencing the dispatch surface ──

const TRIGGER_SUBSTRINGS = ['/api/agent-mcp/operator-dispatch', 'executeAction(', 'dispatchAction('];
// Every tree that can hold a CALLER. `apps/operator-vite/src` carries no
// dispatch caller today, but it is the live desktop UI tree — leaving it
// unscanned would let a future panel there re-open exactly the P-001 hole
// (a string op-code drifting from its handler) with the guard still green.
const SCAN_DIRS = [
  'apps/operator/app',
  'apps/operator-vite/src',
  'packages/operator-core/lib',
  'packages/agent-mcp/src',
];
// The dispatcher's own definition + its test DEFINE the contract; scanning
// them as a "caller" would just rediscover LIVE_OPS as EMITTED_OPS, which is
// not what P-002 guards against (a caller drifting from the handler).
const SELF_FILES = new Set(['execute-action.ts', 'execute-action.test.ts']);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Strip `// …` line comments, but never a `://` inside a URL literal.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

interface Emission {
  file: string;
  op: string;
}

const EMITTED: Emission[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walkSourceFiles(join(REPO, dir))) {
    const base = file.split('/').pop()!;
    if (SELF_FILES.has(base)) continue;
    const raw = readFileSync(file, 'utf8');
    if (!TRIGGER_SUBSTRINGS.some((s) => raw.includes(s))) continue;
    const src = stripComments(raw);
    for (const m of src.matchAll(/\bop:\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      EMITTED.push({ file: file.slice(REPO.length), op: m[1] });
    }
  }
}

describe('dispatch-contract lint — every emitted op-code resolves to a live dispatchAction() branch', () => {
  it('static scan sanity — found the real dispatch table + real callers', () => {
    // Today: create_feature, spinup_project, scaffold_harness, pause_project,
    // resume_project, add_directive_summary, send_directive.
    expect(LIVE_OPS.size).toBeGreaterThanOrEqual(7);
    // OperatorPanel.tsx (send_directive), tasks/create.ts (create_feature),
    // spawn-child.ts (scaffold_harness) — at least 3 real emitters today.
    expect(EMITTED.length).toBeGreaterThanOrEqual(3);
  });

  it('every emitted op-code has a live dispatchAction() branch', () => {
    const dead = EMITTED.filter((e) => !LIVE_OPS.has(e.op));
    expect(
      dead,
      `${dead.length} caller(s) emit an op-code with no live dispatchAction() handler — ` +
        'this is exactly the class of break from EI-18740258166031188 (P-001): a handler ' +
        'was removed while a caller kept posting the retired op.\n' +
        dead.map((d) => `  ${d.file}: op:'${d.op}'`).join('\n') +
        `\nLive ops: ${[...LIVE_OPS].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('a retired-op MENTION in a comment does not false-positive (P-005 surface-precision)', () => {
    // lib/dbos/notify-parent-done.ts documents the RETIRED `dispatchAction({op:
    // 'send_message'})` path in a comment. Regression pin: comment-stripping
    // must keep that file's actual emissions empty, never surface the dead
    // literal as a live caller emission — the same false-positive class P-005
    // names for substring greps, here for a static op-code scan instead.
    const notifyParentDone = EMITTED.filter((e) => e.file.includes('notify-parent-done.ts'));
    expect(notifyParentDone).toEqual([]);
  });

  it('the guard itself actually fires on the P-001 shape (synthetic proof the assertion is live, not vacuous)', () => {
    // Prove the comparison catches exactly the class of break this lint
    // exists for: a caller still emitting an op whose handler was removed.
    // Uses the REAL LIVE_OPS (so this pins against today's real dispatch
    // table) against a SYNTHETIC emission — never mutates real source — to
    // demonstrate the assertion is not silently vacuous (e.g. via an empty
    // LIVE_OPS/EMITTED that would make the real test above pass for free).
    const syntheticEmissions: Emission[] = [
      { file: 'apps/operator/app/_components/OperatorPanel.tsx', op: 'send_message' }, // retired in WI-6097 — the actual P-001 op
      { file: 'apps/operator/app/_components/OperatorPanel.tsx', op: 'send_directive' }, // live — must NOT be flagged
    ];
    const dead = syntheticEmissions.filter((e) => !LIVE_OPS.has(e.op));
    expect(dead.map((d) => d.op)).toEqual(['send_message']);
  });
});
