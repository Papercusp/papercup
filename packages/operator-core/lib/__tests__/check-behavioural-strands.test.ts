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
  hasValueAssertion,
  hasCountOrOrderAssertion,
  mentionsSeamMember,
  seamMemberNames,
  reverseReachable,
  packageMapsByName,
  candidateSkipReason,
  exitForDeclaredRun,
  EXIT_NOT_CHECKED,
  // @ts-expect-error — .mjs guard script, no type declarations by design
} from '../../../../scripts/check-behavioural-strands.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    expect(candidateSkipReason('package.json')).toBe('not-source');
    expect(candidateSkipReason('scripts/lib/not-checked.d.mts')).toBe('declaration');
    expect(candidateSkipReason('packages/x/index.d.ts')).toBe('declaration');
    expect(candidateSkipReason('scripts/__tests__/a.test.mjs')).toBe('test-file');
    expect(candidateSkipReason('packages/x/lib/a.spec.cjs')).toBe('test-file');
    expect(candidateSkipReason('packages/x/dist/index.mjs')).toBe('excluded-path');
    expect(candidateSkipReason('node_modules/pkg/index.js')).toBe('excluded-path');
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
