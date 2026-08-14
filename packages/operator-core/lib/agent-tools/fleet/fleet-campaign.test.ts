import { describe, expect, it } from 'vitest';
import {
  FLEET_CAMPAIGN_RECENT_ROW_CAP,
  partitionTerminalGroups,
  recentEvidence,
  resolveFleetCampaignBoundary,
} from './fleet-campaign';

describe('fleet campaign pure contracts', () => {
  it('uses a valid explicit since boundary and otherwise falls back to fleet creation', () => {
    expect(resolveFleetCampaignBoundary('2026-08-13T10:00:00Z', 1)).toEqual({
      at: '2026-08-13T10:00:00.000Z',
      source: 'explicit-since',
    });
    expect(resolveFleetCampaignBoundary('not-a-date', Date.UTC(2026, 7, 12))).toEqual({
      at: '2026-08-12T00:00:00.000Z',
      source: 'fleet-created-at',
    });
  });

  it('caps recent evidence without capping or disguising the exact total', () => {
    const rows = Array.from({ length: 20 }, (_, id) => ({ id }));
    expect(recentEvidence(rows, 20)).toEqual({
      total: 20,
      shown: FLEET_CAMPAIGN_RECENT_ROW_CAP,
      truncated: true,
      rows: rows.slice(0, FLEET_CAMPAIGN_RECENT_ROW_CAP),
    });
  });

  it('partitions terminal flow by owner class, fleet membership, and authority', () => {
    const out = partitionTerminalGroups([
      { terminal_owner: 'su-member', authority: 'committed', count: 3 },
      { terminal_owner: 'su-outsider', authority: 'proposed', count: 2 },
      { terminal_owner: 'system:reconciler', authority: 'validated', count: 1 },
      { terminal_owner: null, authority: null, count: 4 },
    ], new Set(['su-member']));

    expect(out).toMatchObject({
      total: 10,
      counted: 8,
      notCounted: 2,
      byOwnerClass: { agent: 5, system: 1, unattributed: 4 },
      byFleetMembership: { member: 3, nonMember: 3, unattributed: 4 },
      byAuthority: { committed: 3, proposed: 2, validated: 1, 'legacy-null': 4 },
    });
  });
});
