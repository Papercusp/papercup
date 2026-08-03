/**
 * no-module-scope-flag-subscribe-guard.test.ts — the module-scope flag-touch CI
 * guard's detection predicate (WI-6650, residual of EI-18825928993608425).
 *
 * The guard (`scripts/check-no-module-scope-flag-subscribe.mjs`) runs green on the
 * clean tree (its BASELINE grandfathers the 14 pre-existing subscribers). This locks
 * the direction WI-6650 actually asks for — that it FLAGS a NEW module-scope
 * `onFlagChange(...)` or eager `FLAG_DEFAULTS[...]` deref, while NOT flagging the
 * lazy first-use forms that are the prescribed fix.
 *
 * Homed here rather than beside the guard because this directory is where the class
 * fired twice (log.ts — WI-6449 then WI-6588) and was root-fixed.
 */
import { describe, it, expect } from 'vitest';
// ⚠ NOTHING MAY SIT BETWEEN THE `@ts-ignore` BELOW AND THE `import` — not even a comment.
// `@ts-ignore` suppresses the NEXT LINE ONLY, and the TS7016 "no declaration file" error is
// reported at the MODULE SPECIFIER. There are two ways to move the specifier out from under the
// directive, and BOTH have now been measured in this exact file:
//   1. wrapping the import into a multi-line named-import list (2026-08-03, WI-8887);
//   2. inserting any line between the directive and the import — including an explanation of
//      rule 1. That is how this file red-pinned the fleet gate: the note lived here, six lines
//      of it, so `@ts-ignore` applied to a comment and the import was unguarded
//      (2026-08-03, EI-19457275636306147).
// Hence: explanation ABOVE, directive pair welded to the import, import on ONE line. This matches
// no-bespoke-state-read-guard.test.ts, plane-adoption-probe.test.ts and no-bespoke-state-read-live.ts,
// which carry longer imports the same way. If it ever grows past the print width, move the
// directive rather than reflowing the import.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { usesModuleScopeFlagSubscribe, checkUnpopulatedDeclaration } from '../../../../../scripts/check-no-module-scope-flag-subscribe.mjs';

describe('no-module-scope-flag-subscribe guard predicate (WI-6650)', () => {
  it('FLAGS a module-scope onFlagChange subscription', () => {
    const src = ['onFlagChange((key) => {', '  if (key === null) refresh();', '});'].join('\n');
    expect(usesModuleScopeFlagSubscribe(src)).toBe(true);
  });

  it('FLAGS the `void onFlagChange(...)` variant', () => {
    expect(usesModuleScopeFlagSubscribe('void onFlagChange((key) => refresh(key));')).toBe(true);
  });

  it('FLAGS an eager module-scope FLAG_DEFAULTS deref (the WI-6588 shape)', () => {
    expect(usesModuleScopeFlagSubscribe('const DEFAULT = FLAG_DEFAULTS[FLAGS.COORD_PER_WORKSPACE];')).toBe(true);
  });

  it('FLAGS an exported eager FLAG_DEFAULTS binding', () => {
    expect(usesModuleScopeFlagSubscribe('export let D = FLAG_DEFAULTS[FLAGS.X];')).toBe(true);
  });

  it('does NOT flag a subscription inside a first-use init (the prescribed fix)', () => {
    const lazy = [
      'let inited = false;',
      'function ensureCoordFlagInit() {',
      '  if (inited) return;',
      '  inited = true;',
      '  onFlagChange((key) => { if (key === null) refresh(); });',
      '}',
    ].join('\n');
    expect(usesModuleScopeFlagSubscribe(lazy)).toBe(false);
  });

  it('does NOT flag the lazy arrow form of FLAG_DEFAULTS (what log.ts now uses)', () => {
    expect(
      usesModuleScopeFlagSubscribe('const COORD_PER_WORKSPACE_DEFAULT = (): boolean => FLAG_DEFAULTS[FLAGS.X];'),
    ).toBe(false);
  });

  it('does NOT flag an unrelated module-scope subscribe (e.g. onConfigChange)', () => {
    expect(usesModuleScopeFlagSubscribe('onConfigChange((key) => refresh(key));')).toBe(false);
  });

  it('does NOT flag mentions only in comments (comments are stripped)', () => {
    const codeWithComment = [
      '// never call `onFlagChange(...)` at module scope — see ensureCoordFlagInit',
      '/** const D = FLAG_DEFAULTS[FLAGS.X] would throw under a partial mock */',
      'function ok() { return null; }',
    ].join('\n');
    expect(usesModuleScopeFlagSubscribe(codeWithComment)).toBe(false);
  });
});

/**
 * The `unpopulated` declaration cross-check (WI-8887).
 *
 * `checkUnpopulatedDeclaration` had NO test coverage until this block — it was falsified once by
 * hand, in a session, which is falsification that dies with the transcript. These cases are the
 * permanent CONTROLS: each BAD input is a declaration that is internally inconsistent in a way the
 * cross-check exists to catch, so if the predicate ever weakens, a control stops failing and this
 * block goes red.
 *
 * The third case is the load-bearing one, and it is why the FLAG_DEFAULTS check is scoped to the
 * seed BODY rather than the whole call: `serves` prose routinely names `FLAG_DEFAULTS[...]` when
 * explaining what the window serves, so a whole-call substring test is satisfied by the COMMENT
 * while the seed itself assigns a literal — i.e. the naive check passes on precisely the shape it
 * was written to reject.
 */
describe('unpopulated declaration cross-check (WI-8887)', () => {
  it('ACCEPTS a seed that reads the flag registry (block body)', () => {
    const src = [
      'lazyFlagRefresh(refresh, {',
      '  keys: [FLAGS.X],',
      '  seed: () => { on = FLAG_DEFAULTS[FLAGS.X]; },',
      "  unpopulated: { kind: 'seeded-from-flag-default', serves: 'FLAG_DEFAULTS[X] — currently true.' },",
      '})',
    ].join('\n');
    expect(checkUnpopulatedDeclaration(src)).toBeNull();
  });

  it('ACCEPTS the concise-arrow seed form', () => {
    const src =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], seed: () => (on = FLAG_DEFAULTS[FLAGS.X]), unpopulated: { kind: 'seeded-from-flag-default', serves: 'the registry default' } })";
    expect(checkUnpopulatedDeclaration(src)).toBeNull();
  });

  it('REJECTS a LITERAL seed even when `serves` prose names FLAG_DEFAULTS (the whole-call defeat)', () => {
    const src = [
      'lazyFlagRefresh(refresh, {',
      '  keys: [FLAGS.X],',
      '  seed: () => { on = true; },',
      "  unpopulated: { kind: 'seeded-from-flag-default', serves: 'FLAG_DEFAULTS[X] — currently true, so the window matches production.' },",
      '})',
    ].join('\n');
    expect(checkUnpopulatedDeclaration(src)).toMatch(/does not read FLAG_DEFAULTS/);
  });

  it('REJECTS a seeded kind that passes no seed at all', () => {
    const src =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], unpopulated: { kind: 'seeded-from-flag-default', serves: 'FLAG_DEFAULTS[X]' } })";
    expect(checkUnpopulatedDeclaration(src)).toMatch(/passes no `seed`/);
  });

  it('REJECTS a seed passed under a non-seeded kind', () => {
    const src =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], seed: () => { on = FLAG_DEFAULTS[FLAGS.X]; }, unpopulated: { kind: 'gates-an-override-store', serves: 'the baked constants' } })";
    expect(checkUnpopulatedDeclaration(src)).toMatch(/declare 'seeded-from-flag-default' instead/);
  });

  it("REJECTS 'not-flag-gated' contradicting its own keys", () => {
    const src =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], unpopulated: { kind: 'not-flag-gated', serves: 'the baked constants' } })";
    expect(checkUnpopulatedDeclaration(src)).toMatch(/contradicts the flag keys/);
  });

  it('REJECTS a flag-gated kind with no keys', () => {
    const src =
      "lazyFlagRefresh(refresh, { unpopulated: { kind: 'gates-an-override-store', serves: 'the baked constants' } })";
    expect(checkUnpopulatedDeclaration(src)).toMatch(/requires at least one flag key/);
  });

  it('REJECTS a missing or unknown kind', () => {
    expect(checkUnpopulatedDeclaration('lazyFlagRefresh(refresh, { keys: [FLAGS.X] })')).toMatch(
      /no `unpopulated.kind` declared/,
    );
    const unknown =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], unpopulated: { kind: 'probably-fine', serves: 'x' } })";
    expect(checkUnpopulatedDeclaration(unknown)).toMatch(/unknown `unpopulated.kind`/);
  });

  it("REJECTS a 'selects-behaviour' whose safeBecause is too thin to be a judgement", () => {
    const src =
      "lazyFlagRefresh(refresh, { keys: [FLAGS.X], unpopulated: { kind: 'selects-behaviour', serves: 'the off branch', safeBecause: 'it is fine' } })";
    expect(checkUnpopulatedDeclaration(src)).toMatch(/substantive `safeBecause`/);
  });
});
