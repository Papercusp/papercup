/**
 * EI-20022235111425919 — a shared-lib change that alters how many times it calls an
 * INJECTED COLLABORATOR strands every downstream call-count assertion in every OTHER
 * workspace, and nothing existing can see it: `test:affected` maps changed paths to
 * workspaces (so it never selects them), `tsc` cannot see a stale `toHaveBeenCalledTimes(N)`
 * (it is perfectly well-typed), and `lint:required-field-strands` covers only the
 * type-shaped version of the class.
 *
 * The commissioning item specifies this file's contract exactly:
 *
 *   "A fixture pair: a shared-lib function that gains a second call to an injected
 *    collaborator, plus a downstream test in another workspace asserting
 *    toHaveBeenCalledTimes(1). The detector must name that downstream file. Anchor it to
 *    the PROPERTY (a call-count assertion on a seam whose call count changed), never to
 *    the spelling of the matcher — a form-blind detector is the documented failure mode
 *    of the last three guards added here."
 *
 * So the assertion-detection block below is deliberately a matrix of SPELLINGS of one
 * property, not a test of one matcher name.
 */
import { describe, expect, it } from 'vitest';
import {
  seamCallCounts,
  increasedSeams,
  changedSeamControlFlow,
  collectOutputPropertyValues,
  diffOutputValues,
  diffPackageScriptValues,
  hasValueAssertion,
  hasPackageScriptAssertion,
  hasCountOrOrderAssertion,
  mentionsSeamMember,
  seamMemberNames,
  reverseReachable,
  packageMapsByName,
  candidateSkipReason,
  exitForDeclaredRun,
  invokedInjectedMembers,
  partialInjectionFixtures,
  seamControlFlowRecords,
  equivalentMovedHelperImports,
  runCli,
  EXIT_NOT_CHECKED,
  // @ts-expect-error — .mjs guard script, no type declarations by design
} from '../../../../scripts/check-behavioural-strands.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DETECTOR_CLI = resolve(REPO_ROOT, 'scripts/check-behavioural-strands.mjs');

/** The measured instance, reduced to its essential shape: a two-stage cascade. */
const SHARED_LIB_BEFORE = `
  export async function lexicalWithCascade(source: SearchSource, params) {
    const stage1 = await source.lexical(params);
    return stage1;
  }
`;
const SHARED_LIB_AFTER = `
  export async function lexicalWithCascade(source: SearchSource, params) {
    const stage1 = await source.lexical(params);
    if (stage1.length >= params.limit) return stage1;
    // The added call — correct engine behaviour, and the whole trap.
    const graded = await source.lexical({ ...params, lexicalMode: 'coverage-graded' });
    return graded;
  }
`;

const CONTROL_FLOW_BEFORE = `
  export async function run(input, probe: Probe) {
    for (const spec of input.specs) {
      const evidence = await probe({ runner: input.runner, spec });
      if (evidence.ready) break;
    }
  }
`;
const CONTROL_FLOW_AFTER = `
  export async function run(input, probe: Probe) {
    for (const spec of input.specs) {
      const evidence = await probe({ runner: input.runner, spec });
      if (!spec.satisfiesReadiness) continue;
      if (evidence.ready) break;
    }
  }
`;

const WRITER_BEFORE = `
  export function writeGoalSpendSnapshot(rollup) {
    const patch = { spentCents: rollup.potCents };
    return patch;
  }
`;
const WRITER_AFTER = `
  export function writeGoalSpendSnapshot(rollup) {
    const patch = { spentCents: rollup.pot.samples > 0 ? rollup.potCents : null };
    return patch;
  }
`;
const INSERTED_OUTPUT_BEFORE = `
  export function classifyReservation(row) {
    if (row.kind === 'reserved') {
      return { status: 'already-reserved', code: 'inference_gateway_error', reason: 'keep reserved' };
    }
    if (row.kind === 'stalled') {
      return { status: 'not-pending', code: 'startup_connection_stalled', reason: 'keep stalled' };
    }
  }
`;
const INSERTED_OUTPUT_AFTER = `
  export function classifyReservation(row) {
    if (row.kind === 'quota') {
      return { status: 'quota-backoff', code: 'model_quota_exhausted', reason: 'new quota branch' };
    }
    if (row.kind === 'reserved') {
      return { status: 'already-reserved', code: 'inference_gateway_error', reason: 'keep reserved' };
    }
    if (row.kind === 'stalled') {
      return { status: 'not-pending', code: 'startup_connection_stalled', reason: 'keep stalled' };
    }
  }
`;

// EI-23776710603159495 — an inserted guarded return ABOVE an unconditional fallthrough return.
// Unlike INSERTED_OUTPUT above (whose callable has no fallthrough, so unmatched rows already
// returned undefined), the inputs this new predicate matches USED TO reach the fallthrough, so
// what they observe has changed. The two shapes are indistinguishable to the value diff.
const INTERCEPTING_OPAQUE_BEFORE = `
  export function evaluateIdentityCapability(request) {
    if (request.trusted) {
      return { decision: 'allow', code: 'trusted', applied: false };
    }
    return denial('stale-artifact', request);
  }
`;
const INTERCEPTING_OPAQUE_AFTER = `
  export function evaluateIdentityCapability(request) {
    if (request.trusted) {
      return { decision: 'allow', code: 'trusted', applied: false };
    }
    if (request.toolName === 'coord:orient') {
      return { decision: 'allow', code: 'identity-recovery', applied: false };
    }
    return denial('stale-artifact', request);
  }
`;
const INTERCEPTING_LITERAL_BEFORE = `
  export function evaluateCapability(request) {
    return { decision: 'deny', code: 'capability_unsatisfied', applied: true };
  }
`;
const INTERCEPTING_LITERAL_AFTER = `
  export function evaluateCapability(request) {
    if (request.toolName === 'coord:orient') {
      return { decision: 'allow', code: 'identity-recovery', applied: false };
    }
    return { decision: 'deny', code: 'capability_unsatisfied', applied: true };
  }
`;

describe('the trigger: a seam gained call sites', () => {
  it('counts calls rooted at a typed injected collaborator parameter', () => {
    const counts = seamCallCounts(SHARED_LIB_AFTER, 'hybrid.ts');
    expect(counts.get('source.lexical')).toBe(2);
  });

  it('counts calls through an imported binding that downstream tests can mock', () => {
    const src = `
      import { helper } from './helper';
      export function run(params) { helper(params); helper(params); }
    `;
    expect(seamCallCounts(src, 'x.ts').get('helper()')).toBe(2);
  });

  it('never counts pure builder imports (zod, typescript) as seams, while a local import still counts', () => {
    const src = [
      "import { z } from 'zod';",
      "import ts from 'typescript';",
      "import { helper } from './helper';",
      "export const schema = z.object({ a: z.string(), b: z.enum(['x']) });",
      'export function f(n) { ts.isIdentifier(n); return helper(); }',
    ].join('\n');
    const keys = [...seamCallCounts(src, 'builders.ts').keys()];
    expect(keys.some((k) => k.startsWith('z.') || k.startsWith('ts.'))).toBe(false);
    expect(keys).toContain('helper()');
  });

  it('FIXTURE PAIR: reports the seam whose call count went up', () => {
    const rows = increasedSeams(SHARED_LIB_BEFORE, SHARED_LIB_AFTER, 'hybrid.ts');
    expect(rows).toEqual([{ seam: 'source.lexical', before: 1, after: 2 }]);
  });

  it('stays silent when nothing changed — the negative control', () => {
    expect(increasedSeams(SHARED_LIB_AFTER, SHARED_LIB_AFTER, 'hybrid.ts')).toEqual([]);
  });

  it('stays silent when a call MOVES between functions rather than being added', () => {
    // Counting per-function would report this as an increase; it strands nobody.
    const before = `
      export function a(source) { source.lexical(1); }
      export function b(source) {}
    `;
    const after = `
      export function a(source) {}
      export function b(source) { source.lexical(1); }
    `;
    expect(increasedSeams(before, after, 'x.ts')).toEqual([]);
  });

  it('keeps the equivalent extractHeadings move silent and preserves callback eligibility', () => {
    const helperBody = [
      '  const out: Array<{ id: string; text: string; depth: number }> = [];',
      "  for (const line of content.split('\\n')) {",
      "    const match = /^(#{1,6})\\s+(.+?)\\s*$/.exec(line);",
      '    if (!match) continue;',
      '    const text = match[2].trim();',
      '    if (!text) continue;',
      "    const id = text.replace(/[^A-Za-z0-9]/g, '-');",
      '    out.push({ id, text, depth: match[1].length });',
      '    if (out.length >= 100) break;',
      '  }',
      '  return out;',
    ].join('\n');
    const genericBefore = 'function extractHeadings(content: string) {\n' + helperBody + '\n}';
    const genericAfter = 'export ' + genericBefore;
    const localHelper =
      'function extractHeadings(content: string) {\n' +
      '  // The duplicated local implementation differs only by this comment.\n' +
      helperBody +
      '\n}';
    const adapterBody = [
      'export function listPages(files, sections) {',
      '  const direct = files.map((file) => {',
      "    if (file) return path.join('root', file);",
      '    return null;',
      '  });',
      '  const nested = [];',
      '  for (const section of sections) {',
      '    nested.push(...files.map((file) => path.join(section, file)));',
      '    nested.push(extractHeadings(section));',
      '  }',
      '  return [direct, nested, extractHeadings(files[0])];',
      '}',
    ].join('\n');
    const harnessBefore = [
      "import * as path from 'node:path';",
      localHelper,
      adapterBody,
    ].join('\n');
    const harnessAfter = [
      "import * as path from 'node:path';",
      "import { extractHeadings } from './generic-fs';",
      adapterBody,
    ].join('\n');
    const genericFile = 'packages/docs-engine/src/adapters/generic-fs.ts';
    const harnessFile = 'packages/docs-engine/src/adapters/harness-fs.ts';
    const moved = equivalentMovedHelperImports([
      { file: genericFile, beforeText: genericBefore, afterText: genericAfter },
      { file: harnessFile, beforeText: harnessBefore, afterText: harnessAfter },
    ]);

    expect(moved.get(harnessFile)).toEqual(new Set(['extractHeadings']));
    expect(increasedSeams(harnessBefore, harnessAfter, harnessFile, moved.get(harnessFile))).toEqual([]);
    expect(changedSeamControlFlow(harnessBefore, harnessAfter, harnessFile)).toEqual([]);
  });

  it('counts a DESTRUCTURED seam, and a directly-called parameter', () => {
    const before = `export function run({ lexical }: SearchSource, embed: Embedder) { lexical(1); embed(2); }`;
    const after = `export function run({ lexical }: SearchSource, embed: Embedder) { lexical(1); lexical(2); embed(2); }`;
    expect(increasedSeams(before, after, 'x.ts')).toEqual([{ seam: 'lexical()', before: 1, after: 2 }]);
  });

  it('counts a seam called inside a nested closure — the parameter is still injected', () => {
    const src = `export function run(source: SearchSource, items) { items.map((i) => source.lexical(i)); }`;
    expect(seamCallCounts(src, 'x.ts').get('source.lexical')).toBe(1);
  });

  it('ignores callback parameters, local bindings, and methods on built-in value types', () => {
    const src = `
      export function inspect(buffer: Buffer, text: string, values: string[], run) {
        new Promise<void>((resolve) => { resolve(); });
        buffer.toString();
        text.slice(1);
        values.map((value) => value.toString());
        const invoke = () => 1;
        invoke();
        run();
      }
    `;
    expect(seamCallCounts(src, 'built-ins.ts').size).toBe(0);
  });

  it('does not treat a local shadow as its imported binding', () => {
    const src = `
      import { lookup } from './lookup';
      export function inspect(deps: LookupDeps) {
        const lookup = () => null;
        lookup();
        deps.load();
      }
    `;
    expect([...seamCallCounts(src, 'shadow.ts')]).toEqual([['deps.load', 1]]);
  });

  it('ignores calls inside comments — the AST is the instrument, not a grep', () => {
    const src = `
      export function run(source) {
        // source.lexical(params)
        /* source.lexical(params) */
        return 1;
      }
    `;
    expect(seamCallCounts(src, 'x.ts').size).toBe(0);
  });

  it('reports a dependency-bearing call whose control-flow eligibility changed without adding a call site', () => {
    const rows = changedSeamControlFlow(CONTROL_FLOW_BEFORE, CONTROL_FLOW_AFTER, 'probe.ts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      function: 'run',
      seam: 'probe()',
      reason: 'control-flow-changed',
    });
  });

  it('stays silent when control flow changes but the dependency call count also changes', () => {
    const after = CONTROL_FLOW_AFTER.replace(
      'const evidence = await probe({ runner: input.runner, spec });',
      'const evidence = await probe({ runner: input.runner, spec });\n      await probe({ runner: input.runner, spec });',
    );
    expect(changedSeamControlFlow(CONTROL_FLOW_BEFORE, after, 'probe.ts')).toEqual([]);
  });

  it('limits a control-flow finding to seams whose invocation context changed', () => {
    const before = `
      export function run(input, probe: Probe, runner: Runner, source: Source) {
        probe();
        if (input.enabled) runner();
        source();
      }
    `;
    const after = before.replace('if (input.enabled)', 'if (input.enabled && input.ready)');
    const rows = changedSeamControlFlow(before, after, 'branch-scope.ts');
    expect(rows.map(({ seam }: { seam: string }) => seam)).toEqual(['runner()']);
  });

  it('treats a const-hoisted alias in an equivalent guard as unchanged eligibility', () => {
    const before = `
      export function run(input, filter: Filter) {
        if (input.kind === 'ok' && input.principal) filter(input.principal);
      }
    `;
    const after = `
      export function run(input, filter: Filter) {
        const principal = input.kind === 'ok' ? input.principal : undefined;
        if (input.kind === 'ok' && principal) filter(principal);
      }
    `;
    expect(changedSeamControlFlow(before, after, 'const-hoist.ts')).toEqual([]);
  });

  it('still reports a changed early-return guard before a dependency call', () => {
    const before = `
      export function run(input, runner: Runner) {
        if (input.skip) return;
        return runner();
      }
    `;
    const after = before.replace('if (input.skip)', 'if (input.skip || input.cancelled)');
    expect(changedSeamControlFlow(before, after, 'early-return.ts')).toMatchObject([
      { function: 'run', seam: 'runner()', reason: 'control-flow-changed' },
    ]);
  });

  it('ignores a post-call continue that only skips local result accumulation', () => {
    // Reduced detectUnparsedItemLines: classification changes the returned rows,
    // while both imported VAL helpers still inspect exactly the same lines.
    const before = String.raw`
      import { isValAssertionFieldLine, isValAssertionHeaderLine } from './val-assertions';
      export function detectUnparsedItemLines(writtenBody: string) {
        const lines = writtenBody.split('\n');
        const out = [];
        let underPhase = false;
        for (let i = 0; i < lines.length; i++) {
          const real = lines[i] ?? '';
          if (isValAssertionHeaderLine(real)) {
            underPhase = true;
            continue;
          }
          if (underPhase && isValAssertionFieldLine(real)) continue;
          if (real.startsWith('P-')) continue;
          out.push({ line: i + 1, text: real.trim().slice(0, 160) });
        }
        return out;
      }
    `;
    const after = before.replace("real.startsWith('P-')", "real.startsWith('P-') && real.includes('todo')");
    expect(changedSeamControlFlow(before, after, 'item-parse-feedback.ts')).toEqual([]);

    // Measure the contract independently of the detector's AST summary: the
    // classification result changes, but the complete collaborator trace does not.
    const measure = (source: string) => {
      const calls: string[] = [];
      const callable = source.slice(source.indexOf('export function'))
        .replace('export function', 'function').replace('writtenBody: string', 'writtenBody');
      const run = new Function('isValAssertionFieldLine', 'isValAssertionHeaderLine', `return (${callable});`)(
        (line: string) => { calls.push(`field:${line}`); return line.startsWith('field:'); },
        (line: string) => { calls.push(`header:${line}`); return line === 'VAL'; },
      ) as (body: string) => { line: number; text: string }[];
      return { rows: run('VAL\nfield:one\nP-001 accepted\nP-002 todo\nother'), calls };
    };
    const prior = measure(before);
    const current = measure(after);
    expect(prior.calls).toEqual([
      'header:VAL', 'header:field:one', 'field:field:one',
      'header:P-001 accepted', 'field:P-001 accepted',
      'header:P-002 todo', 'field:P-002 todo', 'header:other', 'field:other',
    ]);
    expect(current.calls).toEqual(prior.calls);
    expect(prior.rows.map((row) => row.text)).toEqual(['other']);
    expect(current.rows.map((row) => row.text)).toEqual(['P-001 accepted', 'other']);
  });

  it('ignores a terminal post-call continue in a fixed traversal', () => {
    const before = `export function run(input, probe: Probe) {
      for (const value of input.values) { probe(value); }
    }`;
    const after = before.replace('probe(value);', 'probe(value); if (value.skip) continue;');
    expect(changedSeamControlFlow(before, after, 'terminal-continue.ts')).toEqual([]);
  });

  it('keeps VAL helper eligibility unchanged for the current plan-item classification guard', () => {
    const file = 'packages/operator-core/lib/agent-tools/plans/item-parse-feedback.ts';
    const after = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    const guard = 'misplacedSection ? !(hasItemRefPrefix && hasItemStatusPrefix)';
    expect(after).toContain(guard);
    const before = after.replace(guard, 'misplacedSection ? !hasItemRefPrefix');
    expect(changedSeamControlFlow(before, after, file)).toEqual([]);
  });

  it.each([
    ['before-call continue', 'if (value.skip) continue; probe(value);', 'if (value.skip || value.cancelled) continue; probe(value);'],
    ['after-call break', 'probe(value);', 'probe(value); if (value.skip) break;'],
    ['after-call return', 'probe(value);', 'probe(value); if (value.skip) return;'],
    ['after-call throw', 'probe(value);', 'probe(value); if (value.skip) throw Error();'],
    ['effectful continue condition', 'probe(value);', 'probe(value); if (advance()) continue;'],
    ['condition state update', 'probe(value);', 'probe(value); if (index++) continue;'],
    ['labelled continue', 'probe(value);', 'probe(value); if (value.skip) continue outer;'],
    ['skipped loop-state update', 'probe(value); ready = value.ready;', 'probe(value); if (value.skip) continue; ready = value.ready;'],
    ['skipped loop exit', 'probe(value); if (value.ready) break;', 'probe(value); if (value.skip) continue; if (value.ready) break;'],
    ['skipped unknown effect', 'probe(value); advance();', 'probe(value); if (value.skip) continue; advance();'],
    ['skipped argument mutation', 'probe(value); out.push(index++);', 'probe(value); if (value.skip) continue; out.push(index++);'],
    ['skipped argument call', 'probe(value); out.push(advance());', 'probe(value); if (value.skip) continue; out.push(advance());'],
    ['unproved string method', 'probe(value); out.push(value.trim());', 'probe(value); if (value.skip) continue; out.push(value.trim());'],
    ['accumulator read by loop', 'probe(value); out.push(value);', 'probe(value); if (value.skip) continue; out.push(value);'],
    ['escaped accumulator', 'probe(value); out.push(value);', 'probe(value); if (value.skip) continue; out.push(value);'],
    ['captured accumulator', 'probe(value); out.push(value);', 'probe(value); if (value.skip) continue; out.push(value);'],
  ])('retains the %s invocation warning', (kind, beforeBody, afterBody) => {
    const prefix = kind === 'escaped accumulator' ? 'publish(out);' : kind === 'captured accumulator' ? 'publish(() => out);' : '';
    const condition = kind === 'accumulator read by loop' ? 'if (out.length > 5) break;' : '';
    const before = `export function run(input, probe: Probe) {
      const out = []; let ready = true; let index = 0; ${prefix}
      outer: for (const value of input.values) { ${condition} ${beforeBody} }
      return out;
    }`;
    const after = before.replace(beforeBody, afterBody);
    expect(changedSeamControlFlow(before, after, 'continue-controls.ts')).toMatchObject([
      { function: 'run', seam: 'probe()', reason: 'control-flow-changed' },
    ]);
  });

  it('retains a continue that skips the condition update of a data-dependent loop', () => {
    const before = `export function run(input, probe: Probe) {
      let ready = true;
      while (ready) { probe(); ready = input.advance(); }
    }`;
    const after = before.replace('ready = input.advance();', 'if (input.skip) continue; ready = input.advance();');
    expect(changedSeamControlFlow(before, after, 'while-state.ts')).toMatchObject([
      { function: 'run', seam: 'probe()', reason: 'control-flow-changed' },
    ]);
  });

  it('ignores loop-body exits for a one-shot call in a for initializer', () => {
    const before = `
      export function run(source: Source) {
        for (const value = source(); value; value = false) {}
      }
    `;
    const after = before.replace(
      'for (const value = source(); value; value = false) {}',
      'for (const value = source(); value; value = false) { if (value) break; }',
    );
    expect(changedSeamControlFlow(before, after, 'for-initializer.ts')).toEqual([]);
  });

  it('does not compare same-named methods from different owners after an unrelated line insertion', () => {
    const before = `
      const firstSource = {
        lexical(input, probe: Probe) {
          if (input.ready) return probe();
          return undefined;
        },
      };
      const secondSource = {
        lexical(input, probe: Probe) { return probe(); },
      };
    `;
    const after = `// unrelated import inserted above\n${before}`;
    expect(changedSeamControlFlow(before, after, 'sources.ts')).toEqual([]);
  });

  it('ignores a Promise executor callback when its control flow changes', () => {
    const before = `export function finish(run) { return new Promise((resolve) => { resolve(); }); }`;
    const after = `export function finish(run) { return new Promise((resolve) => { if (run) resolve(); }); }`;
    expect(changedSeamControlFlow(before, after, 'promise-executor.ts')).toEqual([]);
  });
});

describe('the downstream assertion — anchored on the PROPERTY, not one spelling', () => {
  // Every row below is the SAME property (this assertion's truth depends on how many
  // times, or in what order, a collaborator was called) written a different way. A
  // detector that knew only the first row would be the form-blind guard the item warns
  // against, and would pass a test suite that only ever showed it the first row.
  it.each([
    ['vitest/jest toHaveBeenCalledTimes', 'expect(searchDocs).toHaveBeenCalledTimes(1);'],
    ['jest alias toBeCalledTimes', 'expect(searchDocs).toBeCalledTimes(1);'],
    ['toHaveBeenCalledOnce', 'expect(searchDocs).toHaveBeenCalledOnce();'],
    ['order-sensitive nth', 'expect(searchDocs).toHaveBeenNthCalledWith(2, { a: 1 });'],
    ['order-sensitive last', 'expect(searchDocs).toHaveBeenLastCalledWith({ a: 1 });'],
    ['hand-rolled call-log length', 'expect(searchDocs.mock.calls.length).toBe(1);'],
    ['hand-rolled call-log index', 'const [first] = searchDocs.mock.calls[0];'],
    ['hand-rolled lastCall', 'expect(searchDocs.mock.lastCall).toEqual([1]);'],
    ['invocation order', 'expect(a.mock.invocationCallOrder[0]).toBeLessThan(b.mock.invocationCallOrder[0]);'],
    ['sinon callCount', 'expect(searchDocs.callCount).toBe(1);'],
    ['negated — the count must stay 0', 'expect(searchDocs).not.toHaveBeenCalled();'],
    [
      'exact invocation sequence from a mapped call log',
      'expect(invocations.map((invocation) => invocation.command)).toEqual(["claude", "codex"]);',
    ],
  ])('detects the count/order property written as %s', (_label, line) => {
    expect(hasCountOrOrderAssertion(line)).toBe(true);
  });

  it('does NOT flag toHaveBeenCalledWith — an ADDED call cannot break it', () => {
    // This matcher passes if ANY call matched, so it survives an extra call. Flagging it
    // would inflate every blast radius with tests that cannot be stranded by this class.
    expect(hasCountOrOrderAssertion('expect(searchDocs).toHaveBeenCalledWith({ a: 1 });')).toBe(false);
  });

  it('does NOT flag an ordinary value assertion', () => {
    expect(hasCountOrOrderAssertion('expect(result.hits).toHaveLength(3);')).toBe(false);
  });

  it('does NOT flag an ordinary result sequence assertion as an invocation log', () => {
    expect(hasCountOrOrderAssertion('expect(results.map((result) => result.id)).toEqual(["a"]);')).toBe(false);
  });

  it('does NOT flag a count assertion that exists only in a COMMENT', () => {
    expect(hasCountOrOrderAssertion('// expect(searchDocs).toHaveBeenCalledTimes(1);')).toBe(false);
  });
});

describe('the second trigger: a writer output value changed', () => {
  it('collects and diffs a persisted property even when its expression is completely rewritten', () => {
    expect([...collectOutputPropertyValues(WRITER_BEFORE)]).toEqual([['spentCents', ['rollup.potCents']]]);
    expect(diffOutputValues(WRITER_BEFORE, WRITER_AFTER, 'spend-rollup.ts')).toEqual([
      {
        property: 'spentCents',
        before: 'rollup.potCents',
        after: 'rollup.pot.samples > 0 ? rollup.potCents : null',
        reason: 'value-changed',
      },
    ]);
  });

  it('aligns returned objects by structural branch identity, not property occurrence position', () => {
    expect(diffOutputValues(INSERTED_OUTPUT_BEFORE, INSERTED_OUTPUT_AFTER, 'reservation.ts')).toEqual([]);
    expect(
      diffOutputValues(
        INSERTED_OUTPUT_BEFORE,
        INSERTED_OUTPUT_BEFORE.replace("'keep reserved'", "'changed reserved'"),
        'reservation.ts',
      ),
    ).toEqual([
      {
        property: 'reason',
        before: '"keep reserved"',
        after: '"changed reserved"',
        reason: 'value-changed',
      },
    ]);
  });

  // EI-23776710603159495 — the detector returned EXIT=0 ("checked, no strands") on a change
  // that DID strand a sibling suite. The discriminator is the enclosing callable's fallthrough
  // return, because both the harmful and the harmless insertion present to the value diff
  // identically: an unpaired branch whose group grew by one.
  it('reports an inserted branch that INTERCEPTS traffic which used to reach the fallthrough return', () => {
    expect(diffOutputValues(INTERCEPTING_LITERAL_BEFORE, INTERCEPTING_LITERAL_AFTER, 'capability.ts')).toEqual([
      { property: 'applied', before: 'true', after: 'false', reason: 'branch-intercepts-fallthrough' },
      {
        property: 'code',
        before: '"capability_unsatisfied"',
        after: '"identity-recovery"',
        reason: 'branch-intercepts-fallthrough',
      },
      { property: 'decision', before: '"deny"', after: '"allow"', reason: 'branch-intercepts-fallthrough' },
    ]);
  });

  it('reports an interception even when the fallthrough is an opaque helper CALL, not an object literal', () => {
    // The before-side collects no properties at all here, so a value diff has nothing to pair.
    // The honest "before" is the whole fallthrough expression: that is what a reader used to get.
    expect(collectOutputPropertyValues(INTERCEPTING_OPAQUE_BEFORE, 'identity.ts').get('decision')).toEqual([
      '"allow"',
    ]);
    expect(diffOutputValues(INTERCEPTING_OPAQUE_BEFORE, INTERCEPTING_OPAQUE_AFTER, 'identity.ts')).toEqual([
      {
        property: 'applied',
        before: 'denial("stale-artifact", request)',
        after: 'false',
        reason: 'branch-intercepts-fallthrough',
      },
      {
        property: 'code',
        before: 'denial("stale-artifact", request)',
        after: '"identity-recovery"',
        reason: 'branch-intercepts-fallthrough',
      },
      {
        property: 'decision',
        before: 'denial("stale-artifact", request)',
        after: '"allow"',
        reason: 'branch-intercepts-fallthrough',
      },
    ]);
  });

  it('stays silent for an ADDITIVE branch: no fallthrough return means unmatched inputs already returned undefined', () => {
    // This is the false-positive class the structural-identity pairing was added to prevent,
    // re-asserted here against the interception rule specifically. `classifyReservation` ends
    // its guard chain with no unconditional return, so nothing was re-routed.
    expect(diffOutputValues(INSERTED_OUTPUT_BEFORE, INSERTED_OUTPUT_AFTER, 'reservation.ts')).toEqual([]);
  });

  it('stays silent for a branch inserted BELOW the fallthrough, which no input can reach', () => {
    const unreachable = INTERCEPTING_LITERAL_BEFORE.replace(
      "return { decision: 'deny', code: 'capability_unsatisfied', applied: true };",
      "return { decision: 'deny', code: 'capability_unsatisfied', applied: true };\n" +
        "    if (request.toolName === 'coord:orient') {\n" +
        "      return { decision: 'allow', code: 'identity-recovery', applied: false };\n" +
        '    }',
    );
    expect(diffOutputValues(INTERCEPTING_LITERAL_BEFORE, unreachable, 'capability.ts')).toEqual([]);
  });

  it('also recognizes an object passed directly to a writer call', () => {
    const before = `await db.update(goals).set({ spentCents: rollup.potCents });`;
    const after = `await db.update(goals).set({ spentCents: rollup.pot.samples > 0 ? rollup.potCents : null });`;
    expect(
      diffOutputValues(before, after, 'spend-rollup.ts').map(({ property }: { property: string }) => property),
    ).toEqual(['spentCents']);
  });

  it('stays silent on formatting/comments and on an unrelated local object', () => {
    const formatted = `export function writeGoalSpendSnapshot(rollup) {
      // same persisted value, only presentation changed
      const patch = {\n        spentCents: rollup.potCents,\n      };\n      return patch;
    }`;
    expect(diffOutputValues(WRITER_BEFORE, formatted, 'spend-rollup.ts')).toEqual([]);
    expect(diffOutputValues('const options = { limit: 1 };', 'const options = { limit: 2 };', 'options.ts')).toEqual([]);
  });

  it('stays silent when only equivalent string-literal spelling changes', () => {
    expect(
      diffOutputValues(
        `export function write() { return { status: 'ok' }; }`,
        `export function write() { return { status: "ok" }; }`,
        'status.ts',
      ),
    ).toEqual([]);
  });

  it.each([
    'expect(md?.spentCents).toBe(0);',
    "expect(md['spentCents']).toBe(0);",
    'expect(md).toMatchObject({ spentCents: null });',
    "expect(md).toHaveProperty('spentCents', null);",
    'assert.equal(md.spentCents, 0);',
  ])('detects a property assertion regardless of the assertion spelling: %s', (line) => {
    expect(hasValueAssertion(line, ['spentCents'])).toBe(true);
  });

  it('ignores setup-only property objects, comments, and unrelated call-count assertions', () => {
    expect(hasValueAssertion('const fixture = { spentCents: 0 };', ['spentCents'])).toBe(false);
    expect(hasValueAssertion('// expect(md?.spentCents).toBe(0);', ['spentCents'])).toBe(false);
    expect(hasValueAssertion('expect(searchDocs).toHaveBeenCalledTimes(1);', ['spentCents'])).toBe(false);
    expect(hasValueAssertion('expect(md).toEqual({ other: 0 });', ['spentCents'])).toBe(false);
  });
});

describe('seam-member narrowing', () => {
  it('derives the member name from a property seam and from a bare parameter seam', () => {
    expect(
      seamMemberNames([{ file: 'x.ts', seams: [{ seam: 'source.lexical' }, { seam: 'embedder()' }] }]).sort(),
    ).toEqual(['embedder', 'lexical']);
  });

  it('matches a seam member as a whole word only', () => {
    expect(mentionsSeamMember('const lexical = vi.fn();', ['lexical'])).toBe(true);
    expect(mentionsSeamMember('const lexicalModeThing = 1;', ['lexical'])).toBe(false);
  });

  it('never matches when there are no seam members — narrowing must not invent a hit', () => {
    expect(mentionsSeamMember('anything at all', [])).toBe(false);
  });
});

describe('the blast radius crosses workspaces, which is the entire point', () => {
  // A synthetic three-workspace tree with the shape of the measured instance:
  //   sharedLib   — the changed file, in a package whose ENTRY IS NESTED under src/
  //   consumer    — production code in ANOTHER workspace, importing that package by NAME
  //   consumerTest — the downstream test, which names NEITHER the package NOR the seam
  const files = [
    'libs/generic/search/package.json',
    'libs/generic/search/src/index.ts',
    'libs/generic/search/src/hybrid.ts',
    'packages/consumer/package.json',
    'packages/consumer/lib/search.ts',
    'packages/consumer/lib/__tests__/handlers.test.ts',
  ];
  const contents: Record<string, string> = {
    // The entry is ./src/index.ts — NOT <pkgdir>/index.ts. This detail is the regression
    // this fixture exists for: resolving a bare package name as `<pkgdir>/index` drops
    // every cross-package edge into a src/-rooted package, and the walk then reports no
    // downstream tests at all — a clean-looking green produced by a broken resolver.
    'libs/generic/search/package.json': JSON.stringify({
      name: '@papercusp/search',
      main: './src/index.ts',
      exports: { '.': { import: './src/index.ts' } },
    }),
    'libs/generic/search/src/index.ts': `export { lexicalWithCascade } from './hybrid';`,
    'libs/generic/search/src/hybrid.ts': SHARED_LIB_AFTER,
    'packages/consumer/package.json': JSON.stringify({ name: '@papercusp/consumer', main: './lib/index.ts' }),
    'packages/consumer/lib/search.ts': `import { lexicalWithCascade } from '@papercusp/search';\nexport const run = () => lexicalWithCascade;`,
    // Note what this file does NOT contain: the string '@papercusp/search'. In the real
    // instance the stranded test mocked a DIFFERENT package's function, which production
    // code bound into the seam. A grep for the changed package or the seam finds nothing
    // here; only the import graph does.
    'packages/consumer/lib/__tests__/handlers.test.ts': `
      import { run } from '../search';
      const searchDocs = vi.fn();
      it('calls the lexical source once', () => {
        run();
        expect(searchDocs).toHaveBeenCalledTimes(1);
      });
    `,
  };
  const readFile = (f: string) => contents[f] ?? '';

  it('resolves a bare import of a src/-rooted package via the entry-dir map', () => {
    const { byDir, byEntryDir } = packageMapsByName(files) as {
      byDir: Map<string, string>;
      byEntryDir: Map<string, string>;
    };
    expect(byDir.get('@papercusp/search')).toBe('libs/generic/search');
    expect(byEntryDir.get('@papercusp/search')).toBe('libs/generic/search/src');
  });

  it('NAMES THE DOWNSTREAM FILE — the contract this guard exists to satisfy', () => {
    const { byDir, byEntryDir } = packageMapsByName(files);
    const reached = reverseReachable({
      seeds: ['libs/generic/search/src/hybrid.ts'],
      files,
      readFile,
      byDir,
      byEntryDir,
    }) as Set<string>;

    expect(reached.has('packages/consumer/lib/__tests__/handlers.test.ts')).toBe(true);
    // …and the named file really does carry the stale assertion, so the pair is complete.
    expect(hasCountOrOrderAssertion(readFile('packages/consumer/lib/__tests__/handlers.test.ts'))).toBe(true);
  });

  it('does NOT reach an unrelated file — the negative control for the walk', () => {
    const { byDir, byEntryDir } = packageMapsByName(files);
    const reached = reverseReachable({
      seeds: ['packages/consumer/lib/search.ts'],
      files,
      readFile,
      byDir,
      byEntryDir,
    }) as Set<string>;
    // Reachability is REVERSE: the shared lib does not import its consumer.
    expect(reached.has('libs/generic/search/src/hybrid.ts')).toBe(false);
  });
});

/**
 * WI-10004906 — `SOURCE_RE` accepted only TS, so `--files=a.mjs,b.ts` dropped the .mjs
 * without a word and a clean verdict could cover a file that was never read. The scripts/
 * *.mjs layer holds injected-collaborator seams that TS tests in other workspaces assert
 * on, which is exactly this guard's trigger class.
 */
describe('the candidate set includes JavaScript, and declared files are never dropped silently', () => {
  it('admits JS sources exactly like TS sources', () => {
    for (const file of [
      'scripts/lib/test-pass-reuse.mjs',
      'scripts/legacy.cjs',
      'apps/operator/scripts/hooks/cc/some-hook.js',
      'apps/web/src/Widget.jsx',
      'libs/generic/search/src/hybrid.ts',
      'packages/x/lib/__tests__/helpers.ts',
    ]) {
      expect(candidateSkipReason(file), file).toBeNull();
    }
  });

  it('names WHY a declared file is out of scope', () => {
    expect(candidateSkipReason('README.md')).toBe('not-source');
    expect(candidateSkipReason('package.json')).toBeNull();
    expect(candidateSkipReason('packages/x/package.json')).toBeNull();
    expect(candidateSkipReason('scripts/lib/not-checked.d.mts')).toBe('declaration');
    expect(candidateSkipReason('packages/x/index.d.ts')).toBe('declaration');
    expect(candidateSkipReason('scripts/__tests__/a.test.mjs')).toBe('test-file');
    expect(candidateSkipReason('packages/x/lib/a.spec.cjs')).toBe('test-file');
    expect(candidateSkipReason('packages/x/dist/index.mjs')).toBe('excluded-path');
    expect(candidateSkipReason('node_modules/pkg/index.js')).toBe('excluded-path');
    expect(candidateSkipReason('node_modules/pkg/package.json')).toBe('excluded-path');
  });

  it('counts a seam in plain JS: an imported binding gains a call', () => {
    const before = `
      import { readProofs } from './proof-store.mjs';
      export async function reuse(opts) { return readProofs(opts); }
    `;
    const after = `
      import { readProofs } from './proof-store.mjs';
      export async function reuse(opts) {
        const first = await readProofs(opts);
        return first.length ? first : readProofs({ ...opts, wide: true });
      }
    `;
    expect(increasedSeams(before, after, 'scripts/lib/reuse.mjs')).toEqual([
      { seam: 'readProofs()', before: 1, after: 2 },
    ]);
  });

  it('a declared path that names nothing makes the run NOT CHECKED, even beside a real diff', () => {
    expect(
      exitForDeclaredRun({
        examinedFiles: ['a.ts'],
        identicalFiles: [],
        declared: true,
        skipped: [{ file: 'scripts/typo.mjs', reason: 'not-found' }],
      }),
    ).toBe(EXIT_NOT_CHECKED);
  });

  it('an out-of-domain declared file is disclosed but does not void a real comparison', () => {
    expect(
      exitForDeclaredRun({
        examinedFiles: ['a.mjs'],
        identicalFiles: [],
        declared: true,
        skipped: [
          { file: 'README.md', reason: 'not-source' },
          { file: 'a.test.ts', reason: 'test-file' },
          { file: 'new.mjs', reason: 'new-file' },
        ],
      }),
    ).toBe(0);
    // …and a set where NOTHING was examined still proves nothing.
    expect(
      exitForDeclaredRun({ examinedFiles: [], declared: true, skipped: [{ file: 'README.md', reason: 'not-source' }] }),
    ).toBe(EXIT_NOT_CHECKED);
  });

  it(
    'END TO END: a declared .mjs is EXAMINED, and an unresolvable declared path is named with exit 2',
    () => {
      const realMjs = 'scripts/lib/not-checked.mjs';
      const missing = 'scripts/__wi10004906_no_such_file__.mjs';
      expect(existsSync(resolve(REPO_ROOT, realMjs))).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, missing))).toBe(false);

      const proc = spawnSync(
        process.execPath,
        [DETECTOR_CLI, '--base', 'HEAD', `--files=${realMjs},${missing},README.md`, '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
      );
      expect(proc.error).toBeUndefined();
      const report = JSON.parse(proc.stdout) as {
        examined: string[];
        skipped: Array<{ file: string; reason: string }>;
        notChecked: boolean;
      };
      // The defect: the .mjs used to vanish from `examined` with no trace.
      expect(report.examined).toContain(realMjs);
      expect(report.skipped).toContainEqual({ file: missing, reason: 'not-found' });
      expect(report.skipped).toContainEqual({ file: 'README.md', reason: 'not-source' });
      expect(report.notChecked).toBe(true);
      expect(proc.status).toBe(EXIT_NOT_CHECKED);
    },
    120_000,
  );
});

describe('package-script strands are joined to tests that assert on the script value', () => {
  it('diffs scripts.<name> values without treating unrelated manifest changes as triggers', () => {
    const before = JSON.stringify({ version: '1.0.0', scripts: { 'test:file': 'node old.mjs', lint: 'eslint .' } });
    const after = JSON.stringify({ version: '1.0.1', scripts: { 'test:file': 'node new.mjs', lint: 'eslint .' } });
    expect(diffPackageScriptValues(before, after)).toEqual([
      { property: 'test:file', before: '"node old.mjs"', after: '"node new.mjs"' },
    ]);
    expect(diffPackageScriptValues('{ invalid json', after)).toBeNull();
  });

  it('finds regex and matcher assertions that read the changed script value', () => {
    const measuredTest = readFileSync(resolve(REPO_ROOT, 'scripts/npm-install-safe.test.mjs'), 'utf8');
    expect(hasPackageScriptAssertion(measuredTest, ['test:file'], 'scripts/npm-install-safe.test.mjs')).toBe(true);
    expect(
      hasPackageScriptAssertion(
        'assert.match(packageJson.scripts["test:file"], /runner/); expect(packageJson.scripts.build).toMatch(/build/);',
        ['test:file', 'build'],
      ),
    ).toBe(true);
    expect(
      hasPackageScriptAssertion(
        'const command = packageJson.scripts["test:file"]; assert.match(command, /runner/);',
        ['test:file'],
      ),
    ).toBe(false);
    expect(hasPackageScriptAssertion('assert.match(packageJson.scripts.build, /build/);', ['test:file'])).toBe(false);
  });

  it(
    'END TO END: a package.json script change names the tracked regex-pinning test',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'behavioural-strands-package-script-'));
      const fixtureDetector = join(root, 'scripts/check-behavioural-strands.mjs');
      const binDir = join(root, 'bin');
      const fakeGit = join(binDir, 'git');
      const testPath = 'scripts/package-script.test.mjs';
      const manifestPath = join(root, 'package.json');
      const beforeManifestPath = join(root, '.before-package.json');
      const manifest = {
        name: 'package-script-strand-fixture',
        type: 'module',
        scripts: { 'test:file': 'node old-runner.mjs' },
      };
      const env = () => ({
        ...process.env,
        FIXTURE_ROOT: root,
        PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
      });
      try {
        mkdirSync(join(root, 'scripts'), { recursive: true });
        mkdirSync(binDir, { recursive: true });
        cpSync(DETECTOR_CLI, fixtureDetector);
        symlinkSync(resolve(REPO_ROOT, 'scripts/lib'), join(root, 'scripts/lib'), 'dir');
        symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
        writeFileSync(beforeManifestPath, JSON.stringify(manifest, null, 2));
        writeFileSync(
          join(root, testPath),
          'import assert from "node:assert/strict";\nconst packageJson = { scripts: { "test:file": "node old-runner.mjs" } };\nassert.match(packageJson.scripts["test:file"], /old-runner/);\n',
        );
        manifest.scripts['test:file'] = 'node new-runner.mjs';
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        writeFileSync(
          fakeGit,
          [
            '#!/bin/sh',
            'case "$1" in',
            '  config) exit 1 ;;',
            '  rev-parse) printf "fixture-base\\n"; exit 0 ;;',
            '  show)',
            '    if [ "$2" = "HEAD:package.json" ]; then cat "$FIXTURE_ROOT/.before-package.json"; exit 0; fi',
            '    exit 1 ;;',
            '  ls-files) printf "package.json\\nscripts/package-script.test.mjs\\n"; exit 0 ;;',
            '  *) exit 1 ;;',
            'esac',
            '',
          ].join('\n'),
        );
        chmodSync(fakeGit, 0o755);

        const jsonProc = spawnSync(process.execPath, [fixtureDetector, '--base', 'HEAD', '--files=package.json', '--json'], {
          cwd: root,
          env: env(),
          encoding: 'utf8',
          timeout: 90_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(jsonProc.error).toBeUndefined();
        expect(jsonProc.status, jsonProc.stderr).toBe(0);
        const report = JSON.parse(jsonProc.stdout) as {
          packageScriptProperties: string[];
          tests: string[];
          narrow: string[];
          triggers: Array<{ file: string; scriptValues: Array<{ property: string }> }>;
        };
        expect(report.packageScriptProperties).toEqual(['test:file']);
        expect(report.triggers).toEqual([
          expect.objectContaining({
            file: 'package.json',
            scriptValues: [expect.objectContaining({ property: 'test:file' })],
          }),
        ]);
        expect(report.tests).toContain(testPath);
        expect(report.narrow).toContain(testPath);

        const textProc = spawnSync(process.execPath, [fixtureDetector, '--base', 'HEAD', '--files=package.json'], {
          cwd: root,
          env: env(),
          encoding: 'utf8',
          timeout: 90_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(textProc.error).toBeUndefined();
        expect(textProc.status, textProc.stderr).toBe(0);
        expect(textProc.stdout).toContain('PACKAGE-SCRIPT STRAND RISK');
        expect(textProc.stdout).toContain('scripts["test:file"]');
        expect(textProc.stdout).toContain(testPath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

/**
 * EI-23824032487848760 — a new call to an OPTIONAL member of an injected Deps bundle strands any
 * test fixture that builds the bundle PARTIALLY: the fixture never supplies the member, the new
 * call reaches an uninjected dependency, throws, the catch logs, and vitest-fail-on-console fails
 * the test. The fixture asserts nothing about the new seam, so no count/order anchor names it,
 * and (the measured instance, 0205cd785c: standing-goal-boot-arm.test.ts:77 and
 * goal-liveness-watchdog.test.ts:777) it sits in the SAME workspace as the change.
 *
 * The anchor is the PROPERTY — "a function gained an invoker of an optional Deps member" joined
 * to "an object literal supplies the member's siblings but not the member" — never a spelling of
 * the call or of the fixture.
 */
describe('injected-member trigger: a new call to an optional Deps member strands partial fixtures', () => {
  /** The incident's shape: factory-built local deps + an optional member called via `(deps.m ?? fb)()`. */
  const DEPS_TYPE = `
    export interface WatchdogDeps {
      now: () => number;
      escalateGiveUp: (id: string) => Promise<void>;
      reconcileStrandedLatch?: (id: string) => Promise<void>;
    }
  `;
  const BEFORE = `${DEPS_TYPE}
    export async function tick(opts: Opts) {
      const deps = makeDeps(opts);
      await deps.escalateGiveUp('a');
    }
  `;
  const AFTER = `${DEPS_TYPE}
    export async function tick(opts: Opts) {
      const deps = makeDeps(opts);
      await deps.escalateGiveUp('a');
      await (deps.reconcileStrandedLatch ?? defaultReconcile)('a');
    }
  `;

  const PARTIAL_FIXTURE = `
    it('arms the watchdog', async () => {
      const deps = { now: () => 1, escalateGiveUp: vi.fn(async () => {}) };
      await tick(build(deps));
    });
  `;
  const ADAPTED_FIXTURE = `
    it('arms the watchdog', async () => {
      const deps = { now: () => 1, escalateGiveUp: vi.fn(async () => {}), reconcileStrandedLatch: vi.fn(async () => {}) };
      await tick(build(deps));
    });
  `;

  it('names the optional member whose invocation count rose, with its sibling members as the join key', () => {
    const rows = invokedInjectedMembers(BEFORE, AFTER, 'packages/p/lib/watchdog.ts');
    expect(rows).toEqual([
      {
        member: 'reconcileStrandedLatch',
        owner: 'WatchdogDeps',
        source: 'interface',
        before: 0,
        after: 1,
        siblings: ['escalateGiveUp', 'now'],
      },
    ]);
  });

  it('sees through the `(x ?? fallback)()` and `(x || fallback)()` default idioms and non-null / parens', () => {
    for (const call of [
      `(deps.reconcileStrandedLatch ?? fb)('a')`,
      `(deps.reconcileStrandedLatch || fb)('a')`,
      `deps.reconcileStrandedLatch!('a')`,
      `(deps.reconcileStrandedLatch as Fn)('a')`,
      `deps.reconcileStrandedLatch?.('a')`,
    ]) {
      const after = `${DEPS_TYPE} export async function tick(o: Opts) { const deps = makeDeps(o); await deps.escalateGiveUp('a'); await ${call}; }`;
      const rows = invokedInjectedMembers(BEFORE, after, 'w.ts') as Array<{ member: string }>;
      expect(
        rows.map((r) => r.member),
        call,
      ).toEqual(['reconcileStrandedLatch']);
    }
  });

  it('is silent when the invocation count did not rise', () => {
    expect(invokedInjectedMembers(AFTER, AFTER, 'w.ts')).toEqual([]);
    // a mere reference (not a call) is not an invoker
    const refOnly = `${DEPS_TYPE} export function tick(o: Opts) { const deps = makeDeps(o); return deps.reconcileStrandedLatch; }`;
    expect(invokedInjectedMembers(BEFORE, refOnly, 'w.ts')).toEqual([]);
  });

  it('does NOT trigger for a REQUIRED member — omitting one is a type error lint:tsc already reports', () => {
    const required = `
      export interface WatchdogDeps { now: () => number; escalateGiveUp: (id: string) => Promise<void>; }
    `;
    const before = `${required} export async function tick(o: Opts) { const deps = makeDeps(o); await deps.now(); }`;
    const after = `${required} export async function tick(o: Opts) { const deps = makeDeps(o); await deps.now(); await deps.escalateGiveUp('a'); }`;
    expect(invokedInjectedMembers(before, after, 'w.ts')).toEqual([]);
  });

  it('only declares Deps-shaped interfaces: an unrelated optional member is not a trigger', () => {
    const before = `interface Row { label?: () => string; id: string } export const f = (r: Row) => r.id;`;
    const after = `interface Row { label?: () => string; id: string } export const f = (r: Row) => r.label?.() ?? r.id;`;
    expect(invokedInjectedMembers(before, after, 'row.ts')).toEqual([]);
  });

  it('names a partial fixture and NOT an adapted one — the join is "has the siblings, lacks the member"', () => {
    const injections = invokedInjectedMembers(BEFORE, AFTER, 'packages/p/lib/watchdog.ts');
    const texts: Record<string, string> = {
      'packages/p/lib/stranded.test.ts': PARTIAL_FIXTURE,
      'packages/p/lib/adapted.test.ts': ADAPTED_FIXTURE,
      'packages/p/lib/unrelated.test.ts': `it('x', () => { expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 2 }); });`,
    };
    const band = partialInjectionFixtures({
      tests: Object.keys(texts),
      readFile: (f: string) => texts[f] ?? '',
      injections,
    }) as Array<{ file: string; hits: Array<{ member: string; line: number; present: string[] }> }>;
    expect(band.map((b) => b.file)).toEqual(['packages/p/lib/stranded.test.ts']);
    expect(band[0].hits).toEqual([
      { member: 'reconcileStrandedLatch', line: 3, present: ['escalateGiveUp', 'now'] },
    ]);
  });

  it('a fixture naming fewer than min(2, siblings) siblings is NOT named (one shared word is not a bundle)', () => {
    const injections = [
      { member: 'reconcile', owner: 'XDeps', source: 'interface', before: 0, after: 1, siblings: ['a', 'b', 'c'] },
    ];
    const texts: Record<string, string> = {
      'one.test.ts': `const d = { a: 1 }; use(d);`,
      'two.test.ts': `const d = { a: 1, b: 2 }; use(d);`,
    };
    const band = partialInjectionFixtures({
      tests: Object.keys(texts),
      readFile: (f: string) => texts[f] ?? '',
      injections,
    }) as Array<{ file: string }>;
    expect(band.map((b) => b.file)).toEqual(['two.test.ts']);
  });

  it('matches shorthand and method-form fixture keys, not just `key: value`', () => {
    const injections = [
      { member: 'reconcile', owner: 'XDeps', source: 'interface', before: 0, after: 1, siblings: ['now', 'escalate'] },
    ];
    const text = `const now = () => 1; const deps = { now, escalate() {} };`;
    const band = partialInjectionFixtures({
      tests: ['t.test.ts'],
      readFile: () => text,
      injections,
    }) as Array<{ file: string }>;
    expect(band.map((b) => b.file)).toEqual(['t.test.ts']);
  });

  it('an injected PARAMETER receiver whose bundle interface lives in another file is also a trigger', () => {
    const before = `
      import type { WatchdogDeps } from './types';
      export async function tick(deps: WatchdogDeps) { await deps.escalateGiveUp('a'); await deps.now(); }
    `;
    const after = `
      import type { WatchdogDeps } from './types';
      export async function tick(deps: WatchdogDeps) {
        await deps.escalateGiveUp('a');
        await deps.now();
        await (deps.reconcileStrandedLatch ?? fb)('a');
      }
    `;
    const rows = invokedInjectedMembers(before, after, 'tick.ts') as Array<{
      member: string;
      source: string;
      siblings: string[];
    }>;
    expect(rows.map((r) => ({ member: r.member, source: r.source, siblings: r.siblings }))).toEqual([
      { member: 'reconcileStrandedLatch', source: 'receiver', siblings: ['escalateGiveUp', 'now'] },
    ]);
  });

  it(
    'END TO END: the CLI names the partial fixture in the SAME workspace and exits 0 once it is adapted',
    () => {
      // ROOT is derived from the script's own location, so run a COPY inside a throwaway git repo
      // (node_modules symlinked for `typescript` + the workspace import) — no mutation of this tree.
      const dir = mkdtempSync(resolve(tmpdir(), 'behavioural-strands-injection-'));
      try {
        mkdirSync(resolve(dir, 'scripts'), { recursive: true });
        cpSync(resolve(REPO_ROOT, 'scripts/check-behavioural-strands.mjs'), resolve(dir, 'scripts/check-behavioural-strands.mjs'));
        cpSync(resolve(REPO_ROOT, 'scripts/lib'), resolve(dir, 'scripts/lib'), { recursive: true });
        symlinkSync(resolve(REPO_ROOT, 'node_modules'), resolve(dir, 'node_modules'));
        mkdirSync(resolve(dir, 'packages/p/lib'), { recursive: true });
        writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'tmp-root', private: true }));
        writeFileSync(resolve(dir, 'packages/p/package.json'), JSON.stringify({ name: '@tmp/p', version: '0.0.0' }));
        writeFileSync(resolve(dir, '.gitignore'), 'node_modules\n');
        writeFileSync(resolve(dir, 'packages/p/lib/watchdog.ts'), BEFORE);
        // The barrel makes this test transitively reachable from watchdog.ts, but its generic
        // fixture object is unrelated to the WatchdogDeps bundle and must not join by key names.
        writeFileSync(
          resolve(dir, 'packages/p/lib/index.ts'),
          "export { tick } from './watchdog';\nexport const unrelated = 1;\n",
        );
        writeFileSync(
          resolve(dir, 'packages/p/lib/unrelated.test.ts'),
          "import { unrelated } from './index';\nconst deps = { now: () => 1, escalateGiveUp: () => Promise.resolve() };\nvoid unrelated;\nvoid deps;\n",
        );
        writeFileSync(resolve(dir, 'packages/p/lib/stranded.test.ts'), `import { tick } from './watchdog';\n${PARTIAL_FIXTURE}`);
        mkdirSync(resolve(dir, 'packages/p/_retired'), { recursive: true });
        writeFileSync(resolve(dir, 'packages/p/_retired/stranded.test.ts'), `import { tick } from '../lib/watchdog';\n${PARTIAL_FIXTURE}`);
        const git = (...args: string[]) =>
          spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
        git('init', '-q');
        git('add', '-A');
        expect(git('commit', '-q', '-m', 'base').status).toBe(0);
        writeFileSync(resolve(dir, 'packages/p/lib/watchdog.ts'), AFTER);

        const run = () =>
          spawnSync(process.execPath, [resolve(dir, 'scripts/check-behavioural-strands.mjs'), '--base', 'HEAD', '--json'], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 90_000,
            maxBuffer: 64 * 1024 * 1024,
          });
        const first = run();
        expect(first.error).toBeUndefined();
        const report = JSON.parse(first.stdout) as {
          triggers: Array<{ file: string; injections: Array<{ member: string }> }>;
          injectionBand: Array<{ file: string }>;
          notApplicable: Array<{ file: string; reason: string }>;
          tests: string[];
        };
        expect(report.triggers.map((t) => t.file)).toEqual(['packages/p/lib/watchdog.ts']);
        expect(report.triggers[0].injections.map((i) => i.member)).toEqual(['reconcileStrandedLatch']);
        // The stranded fixture is in the SAME workspace — the cross-workspace band excludes it by design.
        expect(report.injectionBand.map((b) => b.file)).toEqual(['packages/p/lib/stranded.test.ts']);
        expect(report.notApplicable).toEqual([{ file: 'packages/p/_retired/stranded.test.ts', reason: 'retired-test-path' }]);
        // An injection-only trigger has no count-assertion band: nothing else is named as noise.
        expect(report.tests).toEqual([]);

        // Adapt the fixture: the same run now names nothing in the injection band.
        writeFileSync(resolve(dir, 'packages/p/lib/stranded.test.ts'), `import { tick } from './watchdog';\n${ADAPTED_FIXTURE}`);
        const second = JSON.parse(run().stdout) as { injectionBand: unknown[] };
        expect(second.injectionBand).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

/**
 * WI-10005809. A const identifier in a condition guarding a seam call is resolved through its
 * binding (flowPathTokens -> canonicalFlowExpression -> visibleConstBinding). When two same-named
 * consts are visible (a shadow), the bindings are SORTED by lexicalDistance, and lexicalDistance read
 * its loop-scoped `let` cursor after the loop: `ReferenceError: current is not defined`. The shadow is
 * load-bearing — with a single binding the comparator never runs and this test would pass against the
 * broken code (measured: the pre-fix c7bed9f262 detector throws on this fixture and passes on a
 * non-shadowed one).
 */
describe('shadowed const in a seam guard (WI-10005809)', () => {
  const GUARD_BEFORE = `
    export async function run(input, probe: Probe) {
      const ready = input.ready;
      for (const spec of input.specs) {
        const ready = spec.ready;
        if (ready) await probe(spec);
      }
    }
  `;
  const GUARD_AFTER = `
    export async function run(input, probe: Probe) {
      const ready = input.ready;
      for (const spec of input.specs) {
        const ready = spec.ready;
        if (!spec.satisfiesReadiness) continue;
        if (ready) await probe(spec);
      }
    }
  `;

  it('resolves a shadowed const guard without throwing and still reports the control-flow change', () => {
    const rows = changedSeamControlFlow(GUARD_BEFORE, GUARD_AFTER, 'guard.ts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ function: 'run', seam: 'probe()', reason: 'control-flow-changed' });
  });

  it('records the guarded seam call when two same-named consts are visible', () => {
    expect(() => seamControlFlowRecords(GUARD_AFTER, 'guard.ts')).not.toThrow();
  });
});

describe('retired strand candidates (EI-29026543027151004)', () => {
  it.each([0, 1, 24, 25, 26])('discloses %i retired count fixtures without executing them', (retiredCount) => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioural-strands-retired-'));
    const active = 'packages/consumer/lib/_retired-like.test.ts';
    const retired = Array.from({ length: retiredCount }, (_, i) => i % 2
      ? `packages/consumer/_retired/old-${i}.test.ts`
      : `_retired/consumer/old-${i}.test.ts`);
    const capture = join(dir, 'npm-args.json');
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      cpSync(DETECTOR_CLI, join(dir, 'scripts/check-behavioural-strands.mjs'));
      cpSync(join(REPO_ROOT, 'scripts/lib'), join(dir, 'scripts/lib'), { recursive: true });
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
      for (const name of ['source', 'consumer']) {
        mkdirSync(join(dir, `packages/${name}/lib`), { recursive: true });
        writeFileSync(join(dir, `packages/${name}/package.json`), JSON.stringify({ name: `@tmp/${name}` }));
      }
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'retired-strand-fixture', private: true }));
      writeFileSync(join(dir, '.gitignore'), 'node_modules\nnpm-args.json\n');
      writeFileSync(join(dir, 'packages/source/lib/engine.ts'), SHARED_LIB_BEFORE);
      writeFileSync(join(dir, active), "import { lexicalWithCascade } from '../../source/lib/engine';\nexpect(probe).toHaveBeenCalledTimes(1);\n");
      for (const file of retired) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        const source = file.startsWith('_retired/') ? '../../packages/source/lib/engine' : '../../source/lib/engine';
        writeFileSync(join(dir, file), `import { lexicalWithCascade } from '${source}';\nexpect(probe).toHaveBeenCalledTimes(1);\n`);
      }
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
      expect(git('init', '-q').status).toBe(0);
      expect(git('add', '-A').status).toBe(0);
      expect(git('commit', '-q', '-m', 'fixture base').status).toBe(0);
      writeFileSync(join(dir, 'packages/source/lib/engine.ts'), SHARED_LIB_AFTER);
      mkdirSync(join(dir, 'bin'));
      const npm = join(dir, 'bin/npm');
      writeFileSync(npm, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.STRAND_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`);
      chmodSync(npm, 0o755);
      const proc = spawnSync(process.execPath, [join(dir, 'scripts/check-behavioural-strands.mjs'), '--base', 'HEAD', '--json', '--run'], {
        cwd: dir,
        env: { ...process.env, STRAND_CAPTURE: capture, PATH: [join(dir, 'bin'), process.env.PATH].filter(Boolean).join(delimiter) },
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(proc.error).toBeUndefined();
      expect(proc.status, proc.stderr).toBe(0);
      const report = JSON.parse(proc.stdout) as {
        tests: string[];
        wider: string[];
        notApplicable: Array<{ file: string; reason: string }>;
        ran: boolean;
      };
      expect(report.tests).toEqual([active]);
      expect(report.wider).toEqual([active]);
      expect(report.notApplicable).toEqual(retired.sort().map((file) => ({ file, reason: 'retired-test-path' })));
      expect(report.ran).toBe(true);
      expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['run', 'test:file', '--', active]);
      if (retiredCount === 26) {
        const text = (extra: string[]) => spawnSync(process.execPath, [join(dir, 'scripts/check-behavioural-strands.mjs'), '--base', 'HEAD', ...extra], {
          cwd: dir, encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024,
        });
        const preview = text([]);
        expect(preview.status, preview.stderr).toBe(0);
        expect(preview.stdout).toContain('… and 1 more (--all to list them, --json for the full set)');
        const complete = text(['--all']);
        expect(complete.status, complete.stderr).toBe(0);
        for (const file of retired) expect(complete.stdout).toContain(`${file} (retired-test-path)`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('runCli: an internal error is NOT CHECKED, never "strands named" (WI-10005809)', () => {
  it('maps a thrown error to EXIT_NOT_CHECKED and reports it on stderr', () => {
    const lines: string[] = [];
    const exit = runCli(
      () => {
        throw new ReferenceError('current is not defined');
      },
      { writeError: (line: string) => lines.push(line) },
    );
    expect(exit).toBe(EXIT_NOT_CHECKED);
    expect(exit).not.toBe(1);
    expect(lines.join('\n')).toContain('current is not defined');
    expect(lines.join('\n')).toContain('NOT CHECKED');
  });

  it('passes a normal exit code through unchanged', () => {
    expect(runCli(() => 0)).toBe(0);
    expect(runCli(() => 1)).toBe(1);
  });
});
