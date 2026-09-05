/**
 * Tests for the pure auto-accept policy predicates used by both the panel and
 * the background scanner. Run with:
 *   cd packages/operator-core && npx vitest run lib/operator-shared-state.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateOperatorStateFromPg,
  isAutoAcceptLevel,
  isAutoAcceptedByThreshold,
} from './operator-shared-state';

afterEach(() => vi.unstubAllGlobals());

describe('isAutoAcceptLevel', () => {
  it('accepts the four valid levels', () => {
    for (const v of ['off', 'low', 'medium', 'high']) {
      expect(isAutoAcceptLevel(v)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const v of ['', 'HIGH', 'none', 1, null, undefined, {}, ['low']]) {
      expect(isAutoAcceptLevel(v)).toBe(false);
    }
  });
});

describe('isAutoAcceptedByThreshold', () => {
  const tiers = ['low', 'medium', 'high'] as const;

  it('threshold "off" never auto-accepts', () => {
    for (const t of tiers) expect(isAutoAcceptedByThreshold(t, 'off')).toBe(false);
  });

  it('threshold "high" always auto-accepts', () => {
    for (const t of tiers) expect(isAutoAcceptedByThreshold(t, 'high')).toBe(true);
  });

  it('threshold "medium" accepts everything except high-tier', () => {
    expect(isAutoAcceptedByThreshold('low', 'medium')).toBe(true);
    expect(isAutoAcceptedByThreshold('medium', 'medium')).toBe(true);
    expect(isAutoAcceptedByThreshold('high', 'medium')).toBe(false);
  });

  it('threshold "low" accepts only low-tier', () => {
    expect(isAutoAcceptedByThreshold('low', 'low')).toBe(true);
    expect(isAutoAcceptedByThreshold('medium', 'low')).toBe(false);
    expect(isAutoAcceptedByThreshold('high', 'low')).toBe(false);
  });
});

describe('hydrateOperatorStateFromPg', () => {
  it('demotes the hidden Operator chrome profile read behind visible route work', async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://app.papercusp.com/cloud-workspaces' },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ auto_accept: 'medium' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await hydrateOperatorStateFromPg();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profile',
      expect.objectContaining({ papercuspRequestClass: 'background-sync' }),
    );
  });
});
