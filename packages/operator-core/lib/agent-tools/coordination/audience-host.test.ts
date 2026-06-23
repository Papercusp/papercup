/**
 * audience-host.test.ts — the PURE surface of the audience host adapter: the env-gated
 * audienceMode() kill-switch + the listActivePresence resolver's stale/revoked filter + mapping.
 * (The listTargetSubscribers/listTaggedTopics resolvers run live PG stores — covered by the
 * integration suite, not here.) ./presence is mocked so listPresence is fully controlled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./presence', () => ({ listPresence: vi.fn() }));

import { audienceMode, hostAudienceResolvers } from './audience-host';
import { listPresence } from './presence';

const mockListPresence = listPresence as unknown as ReturnType<typeof vi.fn>;

describe('audienceMode — the PAPERCUSP_COORD_EMIT_SCOPE kill-switch (D-005)', () => {
  const KEY = 'PAPERCUSP_COORD_EMIT_SCOPE';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it("returns 'broadcast' only for the exact 'broadcast' value", () => {
    process.env[KEY] = 'broadcast';
    expect(audienceMode()).toBe('broadcast');
  });

  it("defaults to 'scoped' when unset", () => {
    expect(audienceMode()).toBe('scoped');
  });

  it("treats any other value as 'scoped'", () => {
    process.env[KEY] = 'scoped';
    expect(audienceMode()).toBe('scoped');
    process.env[KEY] = 'BROADCAST'; // case-sensitive — not the literal
    expect(audienceMode()).toBe('scoped');
  });
});

describe('hostAudienceResolvers.listActivePresence — drops stale/revoked, maps to ActivePresence', () => {
  beforeEach(() => vi.clearAllMocks());

  const rec = (over: Record<string, unknown>) =>
    ({ ownerId: 'o', currentPlanSlug: null, currentFiles: [], stale: false, revoked: false, ...over });

  it('keeps only fresh, non-revoked records and projects {ownerId, planSlug, files}', async () => {
    mockListPresence.mockResolvedValue([
      rec({ ownerId: 'alice', currentPlanSlug: 'plan-a', currentFiles: ['a.ts'] }),
      rec({ ownerId: 'stale-bob', stale: true }),
      rec({ ownerId: 'revoked-cy', revoked: true }),
      rec({ ownerId: 'dave', currentPlanSlug: null, currentFiles: [] }),
    ]);

    const active = await hostAudienceResolvers.listActivePresence();

    expect(active).toEqual([
      { ownerId: 'alice', planSlug: 'plan-a', files: ['a.ts'] },
      { ownerId: 'dave', planSlug: null, files: [] },
    ]);
  });

  it('returns an empty list when every record is stale or revoked', async () => {
    mockListPresence.mockResolvedValue([rec({ stale: true }), rec({ revoked: true })]);
    expect(await hostAudienceResolvers.listActivePresence()).toEqual([]);
  });
});
