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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { usesModuleScopeFlagSubscribe } from '../../../../../scripts/check-no-module-scope-flag-subscribe.mjs';

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
