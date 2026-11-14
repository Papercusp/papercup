import { describe, expect, it, vi } from 'vitest';
import { composeReuseBrief, type ReuseBriefProvider, type ReuseContribution,
  type ReuseProviderContext, type ReuseProviderId } from './reuse-brief-providers';

const context: ReuseProviderContext = { surface: 'claim', workspaceId: 'fixture-workspace', owner: 'su-fixture',
  invocation: 'actual-claim-dispatch', workItem: 'WI-target', paths: ['target.ts'], sourceVersion: 'blob-v1' };
interface Brief { mandatory: string; impact?: ReuseContribution[]; coChange?: ReuseContribution[];
  whatChangedSincePlanning?: ReuseContribution[]; tests?: ReuseContribution[] }
const append = (base: Brief, value: ReuseContribution): Brief => ({ ...base, [value.section]: [...(base[value.section] ?? []), value] });
const provider = (id: ReuseProviderId, lines = [`${id}: target.ts:2; source scope is partial`]): ReuseBriefProvider => ({ id,
  read: async () => ({ status: 'measured', lines, sourceVersion: 'blob-v1', indexVersion: 'index-v2', citedPaths: ['target.ts'] }) });

describe('reuse provider deadline isolation', () => {
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
});
