import { describe, expect, it, vi } from 'vitest';
import { briefCodePoints, composeReuseBrief, registerReuseBriefProvider,
  type ReuseBriefProvider, type ReuseContribution, type ReuseProviderContext, type ReuseProviderId } from './reuse-brief-providers';

const context: ReuseProviderContext = { surface: 'claim', workspaceId: 'fixture-workspace', owner: 'su-fixture',
  invocation: 'actual-claim-dispatch', workItem: 'WI-fixture', paths: ['target.ts'], sourceVersion: 'blob-v1' };
interface Brief { mandatory: string; impact?: ReuseContribution[]; coChange?: ReuseContribution[];
  whatChangedSincePlanning?: ReuseContribution[]; tests?: ReuseContribution[] }
const append = (base: Brief, value: ReuseContribution): Brief => ({ ...base, [value.section]: [...(base[value.section] ?? []), value] });
const provider = (id: ReuseProviderId, lines = [`${id}: target.ts:2; source scope is partial`]): ReuseBriefProvider => ({ id,
  read: async () => ({ status: 'measured', lines, sourceVersion: 'blob-v1', indexVersion: 'index-v2', citedPaths: ['target.ts'] }) });
const compose = (base: Brief, providers: ReuseBriefProvider[], now = Date.now, deadline = now() + 6_000) =>
  composeReuseBrief({ base, providers, context, append, now, deadline });

describe('P009 shared claim provider composition', () => {
  it('preserves mandatory data and orders independently completed providers by declared priority in their destinations', async () => {
    const base = { mandatory: 'Existing source and anchor evidence must remain byte-identical.' };
    const result = await compose(base, ['coverage', 'sql', 'provenance', 'cochange', 'clones'].map(id => provider(id as ReuseProviderId)));
    expect(base).toEqual({ mandatory: 'Existing source and anchor evidence must remain byte-identical.' });
    expect(result.brief.mandatory).toBe(base.mandatory);
    expect(result.brief.impact?.map(value => value.provider)).toEqual(['clones', 'sql']);
    expect(result.brief.coChange?.[0]?.provider).toBe('cochange');
    expect(result.brief.whatChangedSincePlanning?.[0]?.provider).toBe('provenance');
    expect(result.brief.tests?.[0]?.provider).toBe('coverage');
    expect(result.observations.map(row => [row.provider, row.status])).toEqual([
      ['clones', 'issued'], ['cochange', 'issued'], ['provenance', 'issued'], ['sql', 'issued'], ['coverage', 'issued'],
    ]);
    expect(result.observations.every(row => row.sourceVersion === 'blob-v1' && row.indexVersion === 'index-v2')).toBe(true);
  });

  it.each([['clones', 600], ['cochange', 250], ['provenance', 400], ['sql', 450], ['coverage', 400]] as const)(
    'charges the %s envelope to its %i cap, truncating at whole lines', async (id, cap) => {
      const line = 'Located evidence target.ts:42 qualified as partial 😀';
      const result = await compose({ mandatory: 'base' }, [provider(id, Array.from({ length: 40 }, () => line))]);
      const row = result.observations[0]!;
      expect(row).toMatchObject({ status: 'issued', reason: 'truncated' });
      expect(row.chars).toBeLessThanOrEqual(cap);
      const section = Object.values(result.brief).find(Array.isArray) as ReuseContribution[];
      expect(section[0]!.text.split('\n').every(part => part === line)).toBe(true);
      const enlarged = { ...section[0]!, text: `${section[0]!.text}\n${line}` };
      const delta = briefCodePoints(JSON.stringify(append({ mandatory: 'base' }, enlarged)))
        - briefCodePoints(JSON.stringify({ mandatory: 'base' }));
      expect(Math.max(briefCodePoints(JSON.stringify(enlarged)), delta)).toBeGreaterThan(cap);
    });

  it('uses the global serialized Unicode limit, includes section envelopes, and preserves base even when nothing fits', async () => {
    const providers = ['clones', 'cochange', 'provenance', 'sql', 'coverage'].map(id => provider(id as ReuseProviderId, ['😀'.repeat(50)]));
    const base = { mandatory: '😀'.repeat(2_700) };
    const result = await compose(base, providers);
    expect(result.brief.mandatory).toBe(base.mandatory);
    expect(briefCodePoints(JSON.stringify(result.brief))).toBeLessThanOrEqual(3_000);
    expect(JSON.stringify(result.brief).length).toBeGreaterThan(3_000); // UTF-16 is not this contract's unit.
    expect(result.observations[0]?.status).toBe('issued');
    expect(result.observations.slice(1).some(row => row.status === 'budget')).toBe(true);
    const full = { mandatory: 'x'.repeat(3_000) };
    let calls = 0;
    const blocked = await compose(full, [{ id: 'clones', read: async () => { calls++; return provider('clones').read(context, new AbortController().signal); } }]);
    expect(blocked.brief).toBe(full); expect(calls).toBe(0);
    expect(blocked.observations[0]).toMatchObject({ status: 'budget' });
  });

  it('does not emit no-match or unversioned guesses, and a failed provider leaves base and other providers intact', async () => {
    const result = await compose({ mandatory: 'source base' }, [provider('clones', []),
      { id: 'cochange', read: async () => { throw new Error('unavailable index'); } },
      { id: 'provenance', read: async () => ({ status: 'measured', lines: ['unverified claim'], sourceVersion: null, indexVersion: null }) },
      provider('sql')]);
    expect(result.brief).toEqual({ mandatory: 'source base', impact: [{ provider: 'sql', section: 'impact',
      text: 'sql: target.ts:2; source scope is partial', sourceVersion: 'blob-v1', indexVersion: 'index-v2' }] });
    expect(result.observations.slice(0, 3).map(row => [row.status, row.reason])).toEqual([
      ['no-match', 'complete'], ['unknown', 'failure'], ['unknown', 'unversioned'],
    ]);
  });

  it('cancels a hung provider at its soft deadline while retaining an independently completed source', async () => {
    let aborted = false;
    const result = await compose({ mandatory: 'base' }, [{ id: 'clones', read: async (_context, signal) => {
      signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {});
    } }, provider('coverage')]);
    expect(aborted).toBe(true);
    expect(result.observations[0]).toMatchObject({ status: 'unknown', reason: 'timeout' });
    expect(result.brief.tests?.[0]?.provider).toBe('coverage');
  });

  it('shares the original hard deadline with mandatory assembly and serialization', async () => {
    let clock = 6_000;
    let called = false;
    const expired = await compose({ mandatory: 'base' }, [{ id: 'clones', read: async () => { called = true; throw new Error(); } }], () => clock, 6_000);
    expect(expired.brief).toEqual({ mandatory: 'base' }); expect(called).toBe(false);
    clock = 5_999;
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context, deadline: 6_000, now: () => clock,
      providers: [provider('clones')], append, serialize: brief => {
        if (brief.impact?.length) clock = 6_000;
        return JSON.stringify(brief);
      } });
    expect(result.brief).toEqual({ mandatory: 'base' });
    expect(result.observations[0]?.status).not.toBe('issued');
  });

  it('makes registration explicit, rejects duplicate identity, and removes only its own registration', async () => {
    const source = provider('clones'); const remove = registerReuseBriefProvider(source);
    try {
      expect(() => registerReuseBriefProvider(source)).toThrow('already registered');
      const result = await composeReuseBrief({ base: { mandatory: 'base' }, context, append, deadline: Date.now() + 6_000 });
      expect(result.brief.impact?.[0]?.provider).toBe('clones');
    } finally { remove(); }
  });

  it.each(['claim', 'authoring', 'completion'] as const)('%s keeps independent match, no-match, overflow, failure and timeout outcomes', async surface => {
    vi.useFakeTimers();
    try {
      const pending = composeReuseBrief({ base: { mandatory: 'base' }, context: { ...context, surface }, append,
        deadline: Date.now() + 6000, providers: [provider('clones'), provider('cochange', []),
          provider('provenance', ['x'.repeat(500)]), { id: 'sql', read: async () => { throw new Error('index unavailable'); } },
          { id: 'coverage', read: async () => new Promise(() => {}) }] });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;
      expect(result.brief.impact?.[0]?.provider).toBe('clones');
      expect(result.observations.map(row => [row.status, row.reason])).toEqual([
        ['issued', 'complete'], ['no-match', 'complete'], ['budget', 'truncated'], ['unknown', 'failure'], ['unknown', 'timeout'],
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a stale source version even when the provider labels the result measured', async () => {
    const result = await composeReuseBrief({ base: { mandatory: 'base' }, context: { ...context, sourceVersion: 'new-blob' },
      append, deadline: Date.now() + 6000, providers: [provider('clones')] });
    expect(result.brief).toEqual({ mandatory: 'base' });
    expect(result.observations[0]).toMatchObject({ status: 'unknown', reason: 'source-mismatch', chars: 0 });
  });
});
