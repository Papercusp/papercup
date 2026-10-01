/**
 * EI-18803497769946984 — the recurrence guard for the "ambient workspace transaction
 * held across slow non-DB work" class.
 *
 * ## The class
 *
 * `dispatchWithSynthesizedTx` now retains a `withWorkspace` transaction only for a
 * projected tool that declares `needsWorkspaceTx:true`. A child-process handler that
 * does not query `ctx.tx` must stay on the transaction-free default; opting it in would
 * re-arm the old idle-transaction failure. Once idle time passes Postgres's
 * `idle_in_transaction_session_timeout` the backend is killed and the caller receives
 *
 *     write CONNECTION_CLOSED 127.0.0.1:6432
 *
 * — an error naming neither the tool nor the cause. It was diagnosed as a pooler
 * problem three separate times while running ~31 kills/day. EI-18808330244321407
 * removed that dangerous default; this guard prevents accidental re-opt-in.
 *
 * ## Why a test rather than another code comment
 *
 * The class had already been root-caused TWICE (EI-18666279107998059 for
 * capability:bash, EI-18733783500981433 for release:deploy) and documented at length in
 * the dispatcher — and it still recurred while tx retention was the default. Prose in a
 * header cannot fail a build. This can.
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
 * Tools that spawn a child process yet legitimately need the workspace tx.
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
/*
 * EI-21107910194803524: the verb half MUST allow `-`. It originally read
 * `[a-z0-9_]+`, which silently excluded every hyphenated tool name in the tree —
 * `templates:new-app`, `templates:get-guide`, `plans:set-plan-status`,
 * `coord:declare-intent`, and 129 others (133 files measured on 2026-08-21).
 * Because `violatesIdleTxInvariant` requires DEFINES_TOOL to match BEFORE it can
 * flag anything, those files could import child_process, skip the opt-out, and
 * still be reported clean. The guard's "0 offenders" was therefore partly a
 * measurement artifact, not purely a safety property — the exact failure this
 * suite exists to prevent, one level up.
 *
 * Widening it was verified non-breaking: of the 133 newly-visible files, zero
 * import child_process and accidentally opt into needsWorkspaceTx, so this
 * fixes the detector without changing the current tree's verdict.
 */
const DEFINES_TOOL = /name:\s*'[a-z][a-z0-9_]*:[a-z0-9_-]+'/;
/** A file whose handler shells out — the proxy for "blocks on non-DB work". */
const SPAWNS_CHILD = /from\s+['"]node:child_process['"]|require\(['"](?:node:)?child_process['"]\)/;
const OPTS_IN = /needsWorkspaceTx:\s*true/;

/** Exposed so the guard's own teeth are testable without mutating the shared tree. */
export function violatesIdleTxInvariant(src: string): boolean {
  return DEFINES_TOOL.test(src) && SPAWNS_CHILD.test(src) && OPTS_IN.test(src);
}

/*
 * EI-20261626591106746 — the INDIRECT half of the class, and why this guard does NOT
 * try to detect it by following imports.
 *
 * `dev:pipeline_position` hung past 55s in production with exactly this defect, yet the
 * file-local predicate above cleared it: the tool file never mentions child_process. It
 * imports `gitPipelinePosition` from ../../git-pipeline-position, and THAT file imports
 * `execFile` (line 23). One hop, and the regex is blind.
 *
 * The obvious generalisation — follow relative imports and flag any tool that REACHES
 * child_process — was implemented and MEASURED against this tree before being rejected:
 *
 *     depth 0 (this guard):   0 offenders
 *     depth 1:               29 offenders
 *     depth 2:               92 offenders
 *
 * Transitive import reachability is not a sound proxy for "this handler blocks on
 * subprocess work": importing a module that happens to contain an execFile somewhere
 * does not mean the handler ever awaits it. Shipping the depth-1 form would have failed
 * the build for 29 tools, none of them verified violations — turning a guard into an
 * outage for a fleet whose release gate was already red. A guard that cries wolf gets
 * an ALLOW entry per tool and dies of exemptions.
 *
 * So the indirect case is pinned EXPLICITLY below instead. That is narrower and needs a
 * human to add each entry, which is the correct trade when the alternative is a
 * detector with a 29:1 false-positive rate.
 */
const INDIRECT_SHELL_OUT: ReadonlyMap<string, string> = new Map([
  [
    'goals/start.ts',
    'Calls spawnConsole/spawnHeadless through ../../console-spawn. Goal setup uses getOrgPg().sql ' +
      'autocommit statements so a caller timeout cannot roll the committed goal row back after ' +
      'the holder process has launched (EI-24555745085688381).',
  ],
  [
    'dev/pipeline_position.ts',
    'Imports gitPipelinePosition (../../git-pipeline-position), which shells out to git ' +
      'via execFile for status/rev-list/ls-remote plus the release + systemd probes. Never ' +
      'reads ctx.tx. Hung >55s in production 2026-08-12 (EI-20261626591106746), taking all ' +
      'five registered cells it resolves to status:unknown with it.',
  ],
  [
    'pot/create.ts',
    'Provisioning shells out (repo init, registry/schema setup, routine seeding) behind ' +
      'the harness-provision primitives rather than a local child_process import, so the ' +
      'depth-0 predicate is blind to it. Measured at 111s under load — nearly 2x the 60s ' +
      'idle_in_transaction_session_timeout. Never reads ctx.tx (EI-21107910194803524).',
  ],
  [
    'templates/new-app.ts',
    'Reaches pot:create via inProcessCall, inheriting its multi-minute subprocess work ' +
      'with no local child_process import. Failed 2/2 on 2026-08-21 with the signature ' +
      'bare `write CONNECTION_CLOSED 127.0.0.1:6432` of this class, each failure stranding a ' +
      'half-born pot (listed in pot:list, schema present, checkout with zero commits). ' +
      'Note its timeoutSec: 300 does NOT protect it — a dispatch budget cannot outrun a ' +
      'server-side tx kill, which is why raising that budget did not stop the failures. ' +
      'Never reads ctx.tx (EI-21107910194803524).',
  ],
  [
    'coordination/tools/thread.ts',
    'Reconstructs a thread through the coordination-log read seam, which owns its own ' +
      'storage handle and never reads ctx.tx. A long thread/read under fleet load must ' +
      'not keep the dispatcher transaction idle (EI-21201603407107997).',
  ],
  [
    'plans/add-item.ts',
    'Runs each append through withPlanLock, which opens its own short advisory-lock ' +
      'transaction; revision and federation hooks run after commit. The handler never ' +
      'reads ctx.tx, and bulk additions can span multiple locked writes (EI-21201603407107997).',
  ],
]);

describe('idle-tx recurrence guard — the predicate has teeth', () => {
  // A guard nobody has watched FAIL is decoration. These run the detection against
  // synthetic sources, so we prove it catches a real violation without briefly
  // committing one to a tree the whole fleet shares.
  const spawning = `
    import { execFile } from 'node:child_process';
    export const tool = defineTool({ name: 'demo:slow', agentRoles: [] });
  `;

  it('keeps a default transaction-free child-process tool clear', () => {
    expect(violatesIdleTxInvariant(spawning)).toBe(false);
  });

  it('flags the same tool if it opts into retaining a workspace tx', () => {
    expect(violatesIdleTxInvariant(spawning.replace('name:', 'needsWorkspaceTx: true,\n name:'))).toBe(
      true,
    );
  });

  it('ignores a tool that never shells out', () => {
    expect(
      violatesIdleTxInvariant(`export const tool = defineTool({ name: 'demo:fast', agentRoles: [] });`),
    ).toBe(false);
  });

  it('ignores a non-tool helper that shells out', () => {
    expect(violatesIdleTxInvariant(`import { spawn } from 'node:child_process';`)).toBe(false);
  });

  // EI-21107910194803524 — the calibration that was missing. Every teeth-test above
  // used an underscore-free, hyphen-free verb ('demo:slow'), so all of them passed
  // against a DEFINES_TOOL that could not match a HYPHENATED name — and 133 real tool
  // files went unguarded behind that gap. A detector is only as good as the names it
  // can see, so pin the shape of the name itself, not just the opt-out logic.
  it('flags a HYPHENATED-verb tool that shells out (the 133-file blind spot)', () => {
    const hyphenated = `
      import { execFile } from 'node:child_process';
      export const tool = defineTool({ name: 'templates:new-app', agentRoles: [] });
    `;
    expect(violatesIdleTxInvariant(hyphenated)).toBe(false);
    expect(
      violatesIdleTxInvariant(hyphenated.replace('name:', 'needsWorkspaceTx: true,\n name:')),
    ).toBe(true);
  });

  it('still recognises an underscore-group tool name', () => {
    const underscored = `
      import { execFile } from 'node:child_process';
      export const tool = defineTool({ name: 'agent_chats:send_message', agentRoles: [] });
    `;
    expect(
      violatesIdleTxInvariant(underscored.replace('name:', 'needsWorkspaceTx: true,\n name:')),
    ).toBe(true);
  });
});

describe('indirect idle-tx pins (EI-20261626591106746)', () => {
  // These tools do their blocking subprocess work behind an IMPORT, so the file-local
  // predicate above cannot see them and never will. Each entry is a hand-verified claim;
  // the assertion exists so the declaration cannot be dropped in a refactor — which is
  // exactly how dev:pipeline_position reached production without one.
  it.each([...INDIRECT_SHELL_OUT.entries()])('%s stays transaction-free', (rel, reason) => {
    const src = readFileSync(join(agentToolsDir, rel), 'utf8');
    expect(OPTS_IN.test(src), `${rel} must not declare needsWorkspaceTx: true.\n${reason}`).toBe(false);
  });

  it('every pinned file still exists and defines a tool', () => {
    // Calibration: a pin left pointing at a moved/renamed file would quietly stop
    // guarding anything, which is the failure mode of every hand-maintained list.
    for (const rel of INDIRECT_SHELL_OUT.keys()) {
      const src = readFileSync(join(agentToolsDir, rel), 'utf8');
      expect(DEFINES_TOOL.test(src), `${rel} no longer defines a tool — re-home this pin`).toBe(
        true,
      );
    }
  });
});

describe('idle-tx recurrence guard (EI-18803497769946984)', () => {
  it('every tool that shells out stays transaction-free unless explicitly allowed', () => {
    const offenders: string[] = [];

    for (const file of walk(agentToolsDir)) {
      const src = readFileSync(file, 'utf8');
      if (!violatesIdleTxInvariant(src)) continue;

      const rel = relative(agentToolsDir, file);
      if (ALLOW.has(rel)) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
        `These tools spawn a child process and opted into the dispatcher's ambient workspace ` +
        `transaction. If the handler blocks past idle_in_transaction_session_timeout (60s) ` +
        `the backend is killed and the caller sees a bare ` +
        `"write CONNECTION_CLOSED 127.0.0.1:6432" that names neither the tool nor the cause.\n\n` +
        `Fix: remove \`needsWorkspaceTx: true\` when the handler never reads ctx.tx.\n` +
        `If it genuinely needs the tx, add it to ALLOW in this file with the reason and ` +
        `prefer splitting the DB phase from the slow child-process phase.\n\n` +
        `Offenders:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    ).toEqual([]);
  });

  it('tools:invoke stays on the transaction-free default — its target owns any opt-in', () => {
    // The subtle half of the class, and the reason it survived two prior root-causes.
    // tools:invoke spawns no child process of its own, so the invariant above cannot see
    // it — but it awaits ctx.dispatchTool(...) for the full duration of an ARBITRARY
    // target. Transaction-free-by-default makes the delegator safe structurally; only
    // the target may opt in when it actually consumes ctx.tx.
    const src = readFileSync(join(agentToolsDir, 'tools', 'invoke.ts'), 'utf8');
    expect(OPTS_IN.test(src)).toBe(false);
  });
});
