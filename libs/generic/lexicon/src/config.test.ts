import { afterEach, describe, expect, it } from 'vitest';
import { listPinnedModuleKeys, pinModuleState } from '@papercusp/module-singleton';
import {
  __resetLexiconHostForTests as reset,
  activePackId,
  configureLexicon,
  isLexiconConfigured,
  term,
  type LexiconHost,
} from './config';

// The host lives in realm-pinned state; reset through the module's OWN seam so
// order doesn't matter.
//
// This used to be `delete globalThis[Symbol.for('@papercusp/lexicon:host')]`.
// That reached past the module into its storage location, so when the storage
// moved into @papercusp/module-singleton (EI-19469900474673886) the delete kept
// succeeding while clearing NOTHING — a reset that silently stops resetting,
// leaking host state between cases with no error anywhere. Reaching past a
// module into its internals is a guard that stops guarding without failing.
afterEach(reset);

describe('configureLexicon / ambient resolution', () => {
  it('defaults to classic when unconfigured (never throws)', () => {
    reset();
    expect(isLexiconConfigured()).toBe(false);
    expect(activePackId()).toBe('classic');
    expect(term('pot')).toBe('Pot');
  });

  it('resolves against the wired pack', () => {
    configureLexicon({ activePackId: () => 'the-hive' });
    expect(isLexiconConfigured()).toBe(true);
    expect(activePackId()).toBe('the-hive');
    expect(term('pot')).toBe('Hive');
    expect(term('fleet', { plural: true })).toBe('Colonies');
  });

  it('reflects a live selector change (flag flip)', () => {
    let on = false;
    configureLexicon({ activePackId: () => (on ? 'the-hive' : 'classic') });
    // classic/public = the Papercup cup-character cast (restore-pot-lexicon D-006)
    expect(term('operator')).toBe('Papercup');
    expect(term('brain')).toBe('Mug');
    expect(term('overwatch')).toBe('Kettle');
    expect(term('scout')).toBe('Blender');
    on = true;
    // the-hive keeps the bee-theme role names
    expect(term('operator')).toBe('Sentinel'); // renamed from "Sentinel Bee" (hive-agent-tabs P-003)
    expect(term('brain')).toBe('Queen');
    expect(term('overwatch')).toBe('Overwatch');
    expect(term('scout')).toBe('Scout');
    expect(term('human', { plural: true })).toBe('Keepers');
  });

  it('falls back to classic if the selector throws', () => {
    configureLexicon({
      activePackId: () => {
        throw new Error('boom');
      },
    });
    expect(activePackId()).toBe('classic');
    expect(term('pot')).toBe('Pot');
  });
});

describe('fork-safety — the host is pinned to the realm, and VISIBLE to the central report', () => {
  it('registers its key with @papercusp/module-singleton', () => {
    // The point of pinning THROUGH the primitive rather than hand-rolling a
    // Symbol.for slot: `listModuleDuplications()` only knows about keys pinned
    // this way, so a hand-rolled pin would leave the realm-wide report
    // answering a clean `[]` while this module is split (EI-19469900474673886).
    expect(listPinnedModuleKeys()).toContain('@papercusp/lexicon:host');
  });

  it('a second module record sees the state written by the first', () => {
    const h: LexiconHost = { activePackId: () => 'the-hive' };
    configureLexicon(h);

    // What a duplicate module record does on evaluation: pin the SAME key. The
    // primitive hands back the state the first record built, which is exactly
    // the property that keeps a split from forking this seam in half.
    const asSecondRecord = pinModuleState<{ host: LexiconHost | undefined }>(
      '@papercusp/lexicon:host',
      () => ({ host: undefined }),
    );
    expect(asSecondRecord.host).toBe(h);

    // ...and a write through the second record is seen by this one.
    asSecondRecord.host = { activePackId: () => 'classic' };
    expect(activePackId()).toBe('classic');
  });
});
