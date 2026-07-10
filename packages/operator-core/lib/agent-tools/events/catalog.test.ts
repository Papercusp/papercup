/**
 * catalog.test.ts — events:catalog tool envelope (EI-9000, fleet-reliability-
 * verification-2026-07-10 P-005): `live_awaiters` is attached per family from
 * countActiveAwaitsByPrefixes, best-effort (a DB hiccup must not break catalog
 * discovery), and is skippable via `liveAwaiters: false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));

const countMock = vi.fn();
vi.mock('../../events/await/store', () => ({
  countActiveAwaitsByPrefixes: (...args: unknown[]) => countMock(...args),
}));

import catalog from './catalog';
import { familyKeyPrefix, EVENT_CATALOG } from '../../events/await/catalog';

const call = async (args: Record<string, unknown> = {}) => {
  const res = (await catalog.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  countMock.mockResolvedValue(new Map());
});

describe('events:catalog — live_awaiters', () => {
  it('attaches live_awaiters per row by default, keyed via familyKeyPrefix', async () => {
    countMock.mockImplementation(async (prefixes: string[]) => {
      const m = new Map(prefixes.map((p) => [p, 0]));
      m.set(familyKeyPrefix(EVENT_CATALOG.find((e) => e.family === 'deploy')!), 3);
      return m;
    });
    const out = await call({ family: 'deploy' });
    expect(out.families).toHaveLength(1);
    expect(out.families[0]).toMatchObject({ family: 'deploy', live_awaiters: 3 });
    expect(countMock).toHaveBeenCalledTimes(1);
  });

  it('zero-fills a family with no live registrations', async () => {
    countMock.mockResolvedValue(new Map()); // nothing registered — countActiveAwaitsByPrefixes zero-fills internally, but a stub map is fine too since the tool falls back to 0
    const out = await call({ family: 'deploy-failed' });
    expect(out.families[0].live_awaiters).toBe(0);
  });

  it('liveAwaiters:false skips the DB read entirely', async () => {
    const out = await call({ family: 'deploy', liveAwaiters: false });
    expect(countMock).not.toHaveBeenCalled();
    expect(out.families[0].live_awaiters).toBeUndefined();
  });

  it('a DB failure is swallowed — catalog discovery still returns rows, just without counts', async () => {
    countMock.mockRejectedValue(new Error('pg down'));
    const out = await call({ family: 'deploy' });
    expect(out.ok).toBe(true);
    expect(out.families).toHaveLength(1);
    expect(out.families[0].live_awaiters).toBeUndefined();
  });

  it('unfiltered call requests counts for every rendered family in one round trip', async () => {
    const out = await call({});
    expect(out.count).toBe(EVENT_CATALOG.length);
    expect(countMock).toHaveBeenCalledTimes(1);
    const requestedPrefixes = countMock.mock.calls[0][0] as string[];
    expect(requestedPrefixes.length).toBe(EVENT_CATALOG.length);
  });
});
