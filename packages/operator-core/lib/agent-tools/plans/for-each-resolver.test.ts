/**
 * Adapter coverage for the papercusp `for_each` resolver seam (P-043).
 *
 * The fan-out ALGORITHM (resolve/dedupe/cap/escalate) is covered in the generic
 * `@papercusp/fanout-resolver` lib's own suite. These tests cover the thin
 * papercusp ADAPTER: the wave-shape guards and the `ForEachResolver` →
 * `FanoutSpec` mapping (notably the `from_feature` ⇒ `deferred` translation).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveForEach,
  isForEachResolver,
  isCompletionTimeForEach,
  isFromInputForEach,
} from './for-each-resolver';
import { FanoutResolverError } from '@papercusp/fanout-resolver';
import type { ForEachResolver } from './promote-policy';

describe('isForEachResolver', () => {
  it('a legacy named string is NOT a resolver', () => {
    expect(isForEachResolver('universal_type')).toBe(false);
  });
  it('an items/glob/sql/from_feature object IS a resolver', () => {
    expect(isForEachResolver({ items: ['a'] })).toBe(true);
    expect(isForEachResolver({ glob: 'x' })).toBe(true);
    expect(isForEachResolver({ sql: 'select 1' })).toBe(true);
    expect(isForEachResolver({ from_feature: 'F-1' })).toBe(true);
  });
});

describe('isCompletionTimeForEach', () => {
  it('true only for a from_feature (completion-time) resolver', () => {
    expect(isCompletionTimeForEach({ from_feature: 'F-1' })).toBe(true);
    expect(isCompletionTimeForEach({ items: ['a'] })).toBe(false);
    expect(isCompletionTimeForEach({ glob: 'x' })).toBe(false);
    expect(isCompletionTimeForEach('universal_type')).toBe(false);
  });
});

describe('resolveForEach (adapter → generic lib)', () => {
  it('items: passes through the generic resolver (trimmed + deduped)', async () => {
    expect(await resolveForEach({ items: [' a ', 'b', 'a'] })).toEqual(['a', 'b']);
  });

  it('glob: forwards the injected runner', async () => {
    const runGlob = vi.fn(async () => ['app/api/x/route.ts', 'app/api/x/route.ts', 'app/api/y/route.ts']);
    expect(await resolveForEach({ glob: 'app/api/**/route.ts' }, { runGlob })).toEqual([
      'app/api/x/route.ts',
      'app/api/y/route.ts',
    ]);
    expect(runGlob).toHaveBeenCalledOnce();
  });

  it('maps a from_feature (completion-time) resolver onto the deferred spec → escalates', async () => {
    const spec: ForEachResolver = { from_feature: 'F-SCAN' };
    const err = await resolveForEach(spec).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    // the producing feature ref survives the from_feature → deferred translation
    expect((err as Error).message).toContain('F-SCAN');
  });
});

/**
 * plan-structured-inputs-2026-08-01 P-012 — the `from_input` kind.
 *
 * The other kinds make a wave's fan-out a property of the PLAN (hardcoded, or derived
 * from the repo/DB). This one makes it a property of the RUN, which is what lets one
 * parameterized plan replace N near-duplicate plans. The failure cases matter more
 * than the happy path: a generative wave that silently resolves to zero items mints
 * nothing and looks like it ran.
 */
describe('P-012: from_input fan-out', () => {
  it('resolves the item-set from the run inputs', async () => {
    expect(
      await resolveForEach({ from_input: 'paths' }, {}, { paths: ['packages/a', 'libs/b'], harness: 'p' }),
    ).toEqual(['packages/a', 'libs/b']);
  });

  it('gets the SAME dedupe/trim as every other kind (one shared safety path)', async () => {
    expect(await resolveForEach({ from_input: 'paths' }, {}, { paths: ['  a  ', 'a', 'b'] })).toEqual([
      'a',
      'b',
    ]);
  });

  it('the same plan fans out differently per run — the whole point of the kind', async () => {
    const spec: ForEachResolver = { from_input: 'targets' };
    expect(await resolveForEach(spec, {}, { targets: ['x'] })).toEqual(['x']);
    expect(await resolveForEach(spec, {}, { targets: ['y', 'z'] })).toEqual(['y', 'z']);
  });

  it('FAILS LOUD when the named input is absent — never a silent zero-item wave', async () => {
    const err = await resolveForEach({ from_input: 'paths' }, {}, { harness: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    expect((err as Error).message).toMatch(/no such input/i);
  });

  it('FAILS LOUD when the input is not an array', async () => {
    const err = await resolveForEach({ from_input: 'paths' }, {}, { paths: 'one' }).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    expect((err as Error).message).toMatch(/expected an array/i);
  });

  it('FAILS LOUD when inputs are missing entirely', async () => {
    const err = await resolveForEach({ from_input: 'paths' }, {}, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
  });

  it('coerces a non-string entry rather than dropping it (a shrunk fan-out is invisible)', async () => {
    const items = await resolveForEach({ from_input: 'ids' }, {}, { ids: ['a', 7] });
    expect(items).toHaveLength(2);
    expect(items[0]).toBe('a');
  });

  it('is a resolver, and is NOT completion-time', () => {
    expect(isForEachResolver({ from_input: 'paths' })).toBe(true);
    expect(isFromInputForEach({ from_input: 'paths' })).toBe(true);
    // Misclassifying it as completion-time would defer the wave forever, waiting on a
    // producing feature that does not exist.
    expect(isCompletionTimeForEach({ from_input: 'paths' })).toBe(false);
    expect(isFromInputForEach({ from_feature: 'F-1' })).toBe(false);
    expect(isFromInputForEach('legacy-named-set')).toBe(false);
  });
});
