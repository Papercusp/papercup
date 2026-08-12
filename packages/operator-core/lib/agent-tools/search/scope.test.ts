/**
 * scope.test.ts — the shared `scope` vocabulary for search:fulltext /
 * search:semantic (EI-20244869519887589).
 *
 * These pin the ACCEPT/REJECT BOUNDARY of the arg schema, not the prose that
 * describes it: the reported failure was a refusal, so only a test that submits
 * the rejected value and asserts it now parses can show the refusal is gone.
 */

import { describe, expect, it } from 'vitest';
import { scopeArg, scopeChoices, resolveScopeToken, SCOPE_ALL } from './scope';
import { SEARCH_SOURCES } from './sources';

const parse = (value: unknown) => scopeArg().safeParse(value);

describe('search scope choices', () => {
  it('derives the enum from the source registry so the two cannot drift', () => {
    // The defect this replaces: two byte-identical hand-maintained literals in
    // fulltext.ts and semantic.ts, either of which could fall behind a new source.
    expect(scopeChoices()).toEqual([...SEARCH_SOURCES.map((s) => s.name), SCOPE_ALL]);
    // Every registered source must be reachable as a scope value.
    for (const source of SEARCH_SOURCES) {
      expect(parse([source.name]).success).toBe(true);
    }
  });
});

describe('scope alias fold (EI-20244869519887589)', () => {
  it('accepts the exact call that was refused', () => {
    // Verbatim from the filing: scope:["work_item","transcript"] → invalid_args.
    const result = parse(['work_item', 'transcript']);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(['work_item', 'session_turn']);
  });

  it('folds transcript to session_turn, not to the near-synonym turns', () => {
    // The whole reason a declared synonym is required: `turns` (operator_turns)
    // and `session_turn` (the episodic verbatim transcript index) are both plain
    // English "turns", and only the source docblocks disambiguate them. Getting
    // this backwards would search the wrong corpus and return a confident zero.
    expect(resolveScopeToken('transcript')).toBe('session_turn');
    expect(resolveScopeToken('transcripts')).toBe('session_turn');
    expect(resolveScopeToken('operator_turns')).toBe('turns');
  });

  it('normalizes case, separators and plurals without needing a row each', () => {
    expect(resolveScopeToken('SESSION_TURN')).toBe('session_turn');
    expect(resolveScopeToken('session-turn')).toBe('session_turn');
    expect(resolveScopeToken('sessionTurns')).toBe('session_turn');
    expect(resolveScopeToken('work_items')).toBe('work_item');
    expect(resolveScopeToken('issues')).toBe('work_item');
    expect(resolveScopeToken('escalation')).toBe('escalations');
  });

  it('lets a CANONICAL name win over the synonym table', () => {
    // Mirrors suggestArgName's exact-declared-match precedence: the registry's
    // own vocabulary can never be overridden by an alias row.
    expect(resolveScopeToken('turns')).toBe('turns');
    expect(resolveScopeToken('session_turn')).toBe('session_turn');
    expect(resolveScopeToken('all')).toBe(SCOPE_ALL);
  });

  it('still REFUSES a value that is neither canonical nor a declared alias', () => {
    // The fold must not degrade into "accept anything". An unknown token falls
    // through untouched and gets the normal hard refusal with the option list.
    expect(parse(['not_a_corpus']).success).toBe(false);
    expect(parse(['work_item', 'nonsense']).success).toBe(false);
    expect(resolveScopeToken('not_a_corpus')).toBe('not_a_corpus');
  });

  it('leaves non-string and non-array input to the enum to reject', () => {
    expect(parse('transcript').success).toBe(false);
    expect(parse([42]).success).toBe(false);
    expect(parse(undefined).success).toBe(true);
  });
});
