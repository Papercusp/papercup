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
  collectOutputPropertyValues,
  diffOutputValues,
  hasValueAssertion,
  hasCountOrOrderAssertion,
  mentionsSeamMember,
  seamMemberNames,
  reverseReachable,
  packageMapsByName,
  // @ts-expect-error — .mjs guard script, no type declarations by design
} from '../../../../scripts/check-behavioural-strands.mjs';

/** The measured instance, reduced to its essential shape: a two-stage cascade. */
const SHARED_LIB_BEFORE = `
  export async function lexicalWithCascade(source, params) {
    const stage1 = await source.lexical(params);
    return stage1;
  }
`;
const SHARED_LIB_AFTER = `
  export async function lexicalWithCascade(source, params) {
    const stage1 = await source.lexical(params);
    if (stage1.length >= params.limit) return stage1;
    // The added call — correct engine behaviour, and the whole trap.
    const graded = await source.lexical({ ...params, lexicalMode: 'coverage-graded' });
    return graded;
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

describe('the trigger: a seam gained call sites', () => {
  it('counts only calls rooted at a FUNCTION PARAMETER — an injected collaborator', () => {
    const counts = seamCallCounts(SHARED_LIB_AFTER, 'hybrid.ts');
    expect(counts.get('source.lexical')).toBe(2);
  });

  it('does NOT count a call on a module-scope import — a test cannot inject or count it', () => {
    const src = `
      import { helper } from './helper';
      export function run(params) { helper(params); helper(params); }
    `;
    expect(seamCallCounts(src, 'x.ts').size).toBe(0);
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
    const before = `export function run({ lexical }, embed) { lexical(1); embed(2); }`;
    const after = `export function run({ lexical }, embed) { lexical(1); lexical(2); embed(2); }`;
    expect(increasedSeams(before, after, 'x.ts')).toEqual([{ seam: 'lexical()', before: 1, after: 2 }]);
  });

  it('counts a seam called inside a nested closure — the parameter is still injected', () => {
    const src = `export function run(source, items) { items.map((i) => source.lexical(i)); }`;
    expect(seamCallCounts(src, 'x.ts').get('source.lexical')).toBe(1);
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
