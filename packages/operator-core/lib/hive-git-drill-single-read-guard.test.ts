/**
 * PDS P-004 (R-6/R-7) guard: drill code must never read remote state ONCE after an async
 * action, and every wait goes through the ONE shared convergence helper.
 *
 * P-505 took 32 runs. Several were lost to one defect class: a phase fired an async action
 * (git-sync:run, a signed event) and then read the other host once, 7-23 s later, before
 * it converged. Each phase that hit this then grew its own deadline+sleep loop. This guard
 * makes both mistakes visible at test time instead of on the rig:
 *
 * 1. TS drill modules (pot-git/physical-drill-*.ts): a loop that awaits a sleep is a
 *    hand-rolled poll. Use waitForConvergence / requireConvergence from
 *    @papercusp/verification-harness instead, or mark a loop that is not a remote
 *    observation `// converge-exempt: <reason>`.
 * 2. The physical scenario (hive-git-physical-scenario.sh): every call to a producer
 *    OBSERVATION mode must converge. Allowed forms are: through vh_converge, with an
 *    in-producer wait budget (a *_WAIT_SEC argument), inside a retry loop, inside a function
 *    whose every caller qualifies, or annotated `# single-read: <reason>` on the lines just
 *    above (a baseline read taken BEFORE the action is legitimately single).
 *
 * The observation-mode list is DERIVED from the producer source, so a new mode is covered
 * without editing this file. Existing hand-rolled loops are pinned as a SHRINK-ONLY
 * baseline: removing one requires deleting its entry, and adding one fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const POT_GIT = path.join(REPO, 'packages/operator-core/lib/sync/pot-git');
const PRODUCER = path.join(POT_GIT, 'physical-drill-producer.ts');
const SCENARIO = path.join(REPO, 'papercusp-desktop/bin/vm-rig/hive-git-physical-scenario.sh');

// ─── 1. TS: hand-rolled poll loops ──────────────────────────────────────────

const SLEEPISH = /\b(sleep|delay|setTimeout)\b/;

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) {
      return n.parent.name.getText();
    }
  }
  return '<module>';
}

function hasExemption(loop: ts.Node, source: string): boolean {
  const ranges = ts.getLeadingCommentRanges(source, loop.getFullStart()) ?? [];
  return ranges.some((r) => /converge-exempt:\s*\S/.test(source.slice(r.pos, r.end)));
}

/** `<fn>` for every loop whose body awaits a sleep-like call and is not exempt. */
export function findHandRolledPollLoops(source: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIterationStatement(node, false)) {
      let polls = false;
      const scan = (n: ts.Node): void => {
        if (polls || ts.isFunctionLike(n)) return; // a nested callback is not this loop's wait
        if (ts.isAwaitExpression(n) && SLEEPISH.test(n.expression.getText())) polls = true;
        else ts.forEachChild(n, scan);
      };
      scan(node.statement);
      if (polls && !hasExemption(node, source)) found.push(enclosingFunctionName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function drillModules(): string[] {
  return readdirSync(POT_GIT)
    .filter((f) => /^physical-drill-.*\.ts$/.test(f) && !/\.(test|fixture)\.ts$/.test(f))
    .sort();
}

/**
 * SHRINK-ONLY: hand-rolled poll loops that predate the shared helper. P-004 moves each
 * onto waitForConvergence and deletes its entry here. Never add one.
 */
const LEGACY_HAND_ROLLED_LOOPS = new Set<string>([
  'physical-drill-phase-d.ts:capturePhysicalPhaseDEvent',
  'physical-drill-phase-e.ts:awaitPhysicalPhaseEStageMode',
  'physical-drill-phase-e.ts:awaitFinishedFireSince',
  'physical-drill-phase-i.ts:killOwnerProcess',
]);

// ─── 2. Shell: single reads of observation modes ────────────────────────────

/** Producer modes that READ remote/cross-host state, derived from the producer source. */
export function observationModes(producerSource: string): string[] {
  const modes = [...producerSource.matchAll(/mode === '([a-z0-9-]+)'/g)].map((m) => m[1]!);
  return [...new Set(modes.filter((m) => /-observe$|^phase-d-event$|-await-mode$/.test(m)))].sort();
}

interface ShellCommand {
  line: number; // 1-based first physical line
  text: string; // backslash continuations joined
  fn: string | null;
  loopDepth: number;
  commentAbove: string;
}

/** Split a bash script into logical commands with their enclosing function and loop depth. */
export function shellCommands(source: string): ShellCommand[] {
  const lines = source.split('\n');
  const out: ShellCommand[] = [];
  let fn: string | null = null;
  let fnDepth = 0;
  let loopDepth = 0;
  let heredoc: string | null = null;
  let comments: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (heredoc) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) {
      comments.push(trimmed);
      continue;
    }
    if (trimmed === '') {
      comments = [];
      continue;
    }
    const start = i;
    let text = raw;
    while (text.endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      text = `${text.slice(0, -1)} ${lines[i]!.trim()}`;
    }
    const fnMatch = /^([a-z_][a-z0-9_]*)\(\)\s*\{/.exec(trimmed);
    if (fnMatch && fn === null) {
      fn = fnMatch[1]!;
      fnDepth = 0;
    }
    if (/^(while|until|for)\b/.test(trimmed) && /\bdo\s*$|;\s*do\b/.test(text)) loopDepth += 1;
    out.push({ line: start + 1, text, fn, loopDepth, commentAbove: comments.join('\n') });
    comments = [];
    const hd = /<<-?\s*'?"?([A-Z_]+)'?"?/.exec(text);
    if (hd) heredoc = hd[1]!;
    if (/^done\b/.test(trimmed) || /;\s*done\b/.test(text)) loopDepth = Math.max(0, loopDepth - 1);
    if (fn !== null) {
      fnDepth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
      if (fnDepth <= 0) fn = null; // also closes a one-line `f() { ...; }`
    }
  }
  return out;
}

type Verdict = 'vh_converge' | 'wait-budget' | 'loop' | 'annotated' | 'wrapper' | 'single-read';

function directVerdict(c: ShellCommand): Verdict {
  if (/\bvh_converge\b/.test(c.text)) return 'vh_converge';
  if (/\$\{?[A-Z_]*_WAIT_SEC\b/.test(c.text)) return 'wait-budget';
  if (c.loopDepth > 0) return 'loop';
  if (/#\s*single-read:\s*\S/.test(c.commentAbove)) return 'annotated';
  return 'single-read';
}

/** `<fn>:<mode>` for every observation call that neither converges nor says why it is single. */
export function findSingleReads(scenario: string, modes: readonly string[]): string[] {
  const cmds = shellCommands(scenario);
  const modeRe = new RegExp(`PRODUCER['"]?\\s+(${modes.map((m) => m.replace(/-/g, '\\-')).join('|')})\\b`);
  const callsOf = (fn: string) =>
    cmds.filter((c) => c.fn !== fn && new RegExp(`(^|[\\s;|&(!])${fn}(\\s|$)`).test(c.text.trim()));
  const qualifies = (c: ShellCommand, seen: Set<string>): boolean => {
    if (directVerdict(c) !== 'single-read') return true;
    if (!c.fn || seen.has(c.fn)) return false;
    const callers = callsOf(c.fn);
    const next = new Set(seen).add(c.fn);
    return callers.length > 0 && callers.every((caller) => qualifies(caller, next));
  };
  const out: string[] = [];
  for (const c of cmds) {
    const m = modeRe.exec(c.text);
    if (m && !qualifies(c, new Set())) out.push(`${c.fn ?? '<top>'}:${m[1]}`);
  }
  return out;
}

/**
 * SHRINK-ONLY: observation calls in the scenario that read once without saying why. P-004
 * annotates the pre-action baselines (`# single-read: <reason>`) or moves the call onto
 * vh_converge, and deletes the entry. Never add one.
 */
const LEGACY_SINGLE_READS: readonly string[] = [
  'phase_a_storage_join:phase-a-observe',
  'phase_a_storage_join:phase-a-quarantine-observe',
  'phase_b_ref_announce:phase-b-observe',
  'phase_b_ref_announce:phase-b-observe',
  'phase_b_ref_announce:phase-b-observe',
  'phase_b_ref_announce:phase-b-observe',
  'phase_d_worktree_materialization:phase-d-observe',
  'phase_e_github_bridge:phase-e-observe',
  'phase_h_observe_vm:phase-h-observe',
  'phase_h_observe_tower:phase-h-observe',
  'phase_j_apply_outage_replay:phase-j-observe',
  'phase_j_apply_outage_replay:phase-j-observe',
];

// ─── tests ──────────────────────────────────────────────────────────────────

describe('P-004 single-read guard: detectors (positive controls)', () => {
  it('flags a deadline+sleep poll loop and names its function', () => {
    const src = `async function waitIt(read, sleep) {
      let v = await read();
      while (!v.ok) { await sleep(1000); v = await read(); }
      return v;
    }`;
    expect(findHandRolledPollLoops(src)).toEqual(['waitIt']);
  });

  it('flags an inline setTimeout promise poll, and a for(;;) poll in an arrow function', () => {
    const src = `const a = async () => { for (;;) { if (await ok()) break; await new Promise((r) => setTimeout(r, 50)); } };`;
    expect(findHandRolledPollLoops(src)).toEqual(['a']);
  });

  it('does not flag a loop that goes through the shared helper, or an exempt local loop', () => {
    const src = `import { waitForConvergence } from '@papercusp/verification-harness';
    async function viaHelper() { return waitForConvergence({ what: 'x', observe, lagging, budgetMs: 1, pollMs: 1 }); }
    async function local(pid) {
      // converge-exempt: waits for a local child pid to exit, not a remote observation
      for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(50);
    }
    async function noWait(items) { for (const i of items) await process(i); }`;
    expect(findHandRolledPollLoops(src)).toEqual([]);
  });

  it('flags a bare single read of an observation mode and accepts each converging form', () => {
    const modes = ['phase-x-observe', 'phase-d-event'];
    const script = [
      'bad() {',
      '  "$TSX" "$PRODUCER" phase-x-observe tower after >"$out"',
      '}',
      'budgeted() {',
      '  "$TSX" "$PRODUCER" phase-d-event tower 0 "$k" "$sha" "$PHASE_D_TOWER_EVENT_WAIT_SEC" >"$o"',
      '}',
      'looped() {',
      '  while :; do',
      '    ssh "$VM" "\'$VM_PRODUCER\' phase-x-observe vm after" >"$o" && break',
      '  done',
      '}',
      'converged() {',
      '  vh_converge --budget 60 --poll 5 --what x --out "$o" -- \\',
      '    "$TSX" "$PRODUCER" phase-x-observe tower after',
      '}',
      'baseline() {',
      '  # single-read: taken BEFORE the publish, nothing is in flight yet',
      '  "$TSX" "$PRODUCER" phase-x-observe tower before >"$o"',
      '}',
      'wrap_obs() { "$TSX" "$PRODUCER" phase-x-observe tower "$1" >"$2"; }',
      'drive() {',
      '  until wrap_obs step "$o"; do sleep 5; done',
      '}',
    ].join('\n');
    expect(findSingleReads(script, modes)).toEqual(['bad:phase-x-observe']);
  });

  it('a wrapper with even one non-converging caller is a single read', () => {
    const script = [
      'wrap_obs() { "$TSX" "$PRODUCER" phase-x-observe tower "$1" >"$2"; }',
      'drive() {',
      '  until wrap_obs step "$o"; do sleep 5; done',
      '  wrap_obs final "$o"',
      '}',
    ].join('\n');
    expect(findSingleReads(script, ['phase-x-observe'])).toEqual(['wrap_obs:phase-x-observe']);
  });

  it('derives the observation modes from the producer, and the list is non-trivial', () => {
    const modes = observationModes(readFileSync(PRODUCER, 'utf8'));
    expect(modes).toEqual(expect.arrayContaining(['phase-d-event', 'phase-d-observe', 'phase-e-observe']));
    expect(modes.length).toBeGreaterThanOrEqual(8);
    expect(modes).not.toContain('phase-d-commit');
  });
});

describe('P-004 single-read guard: the real drill code', () => {
  it('has no hand-rolled poll loop in the physical-drill modules beyond the shrink-only baseline', () => {
    const modules = drillModules();
    expect(modules.length).toBeGreaterThanOrEqual(10); // the scan actually saw the drill
    const found = modules.flatMap((f) =>
      findHandRolledPollLoops(readFileSync(path.join(POT_GIT, f), 'utf8'), f).map((fn) => `${f}:${fn}`),
    );
    const added = found.filter((k) => !LEGACY_HAND_ROLLED_LOOPS.has(k));
    const removed = [...LEGACY_HAND_ROLLED_LOOPS].filter((k) => !found.includes(k));
    expect(added, 'new hand-rolled poll loop: use waitForConvergence from @papercusp/verification-harness').toEqual([]);
    expect(removed, 'a legacy loop is gone: delete its LEGACY_HAND_ROLLED_LOOPS entry (shrink-only)').toEqual([]);
  });

  it('reads no observation mode once in the physical scenario without converging or saying why', () => {
    const scenario = readFileSync(SCENARIO, 'utf8');
    const modes = observationModes(readFileSync(PRODUCER, 'utf8'));
    const cmds = shellCommands(scenario);
    expect(cmds.filter((c) => c.fn !== null).length).toBeGreaterThan(100); // the parser saw real functions
    const found = findSingleReads(scenario, modes);
    const added = found.filter((k) => !LEGACY_SINGLE_READS.includes(k));
    const removed = LEGACY_SINGLE_READS.filter((k) => !found.includes(k));
    expect(added, 'observation read once after an action: use vh_converge / a *_WAIT_SEC budget, or annotate `# single-read: <why>`').toEqual([]);
    expect(removed, 'a legacy single read is gone: delete its LEGACY_SINGLE_READS entry (shrink-only)').toEqual([]);
  });
});
