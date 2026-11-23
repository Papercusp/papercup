import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadHarnessRegistryMock = vi.fn();
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: (...args: unknown[]) => loadHarnessRegistryMock(...args),
}));

import {
  duplicateScreeningComplaint,
  duplicateScreeningOf,
  projectDuplicateScreening,
  projectScreeningExemption,
  screeningExemption,
  screeningHolds,
} from './work-items-duplicate-screening';

describe('duplicate screening level (pure)', () => {
  it('holds every kind at `all`, only bugs at `bugs`, nothing at `off`', () => {
    const held = (level: 'all' | 'bugs' | 'off') =>
      ['bug', 'change', 'task', 'feature'].filter((kind) => screeningHolds(level, kind));
    expect(held('all')).toEqual(['bug', 'change', 'task', 'feature']);
    expect(held('bugs')).toEqual(['bug']);
    expect(held('off')).toEqual([]);
  });

  it('names the policy that admitted an item, and names nothing for an item it holds', () => {
    expect(screeningExemption('off', 'bug')).toBe('policy:duplicate-screening-off');
    expect(screeningExemption('bugs', 'change')).toBe('policy:duplicate-screening-bugs');
    expect(screeningExemption('bugs', 'bug')).toBeNull();
    expect(screeningExemption('all', 'change')).toBeNull();
  });

  it('reads `all` from overrides that name no level or one it does not know', () => {
    expect(duplicateScreeningOf(undefined)).toBe('all');
    expect(duplicateScreeningOf({})).toBe('all');
    expect(duplicateScreeningOf({ duplicateScreening: null })).toBe('all');
    expect(duplicateScreeningOf({ duplicateScreening: 'none' })).toBe('all');
    expect(duplicateScreeningOf({ duplicateScreening: 'off' })).toBe('off');
  });

  it('complains about a level it does not know when one is about to be stored, and about nothing else', () => {
    expect(duplicateScreeningComplaint({ maxCostUsd: 5 })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: 'bugs' })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: null })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: 'none' })).toContain("'all', 'bugs', 'off'");
    expect(duplicateScreeningComplaint({ duplicateScreening: false })).toContain('false');
  });
});

describe('a project\'s screening level, read from the registry', () => {
  beforeEach(() => {
    loadHarnessRegistryMock.mockReset();
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [
        { slug: 'small', path: '/p/small', configOverrides: { duplicateScreening: 'off' } },
        { slug: 'bugsonly', path: '/p/bugsonly', configOverrides: { duplicateScreening: 'bugs' } },
        { slug: 'plain', path: '/p/plain' },
      ],
    });
  });

  it('is the level the project set, and `all` for a project that set none', async () => {
    expect(await projectDuplicateScreening('ws', 'small')).toBe('off');
    expect(await projectDuplicateScreening('ws', 'bugsonly')).toBe('bugs');
    expect(await projectDuplicateScreening('ws', 'plain')).toBe('all');
    expect(loadHarnessRegistryMock).toHaveBeenCalledWith('ws');
  });

  it('is `all` for a project that is not registered, is not named, or cannot be read', async () => {
    expect(await projectDuplicateScreening('ws', 'nowhere')).toBe('all');
    expect(await projectDuplicateScreening('ws', undefined)).toBe('all');
    expect(await projectDuplicateScreening('ws', '*')).toBe('all');
    loadHarnessRegistryMock.mockRejectedValueOnce(new Error('registry unreadable'));
    expect(await projectDuplicateScreening('ws', 'small')).toBe('all');
  });

  it('exempts a change in a bugs-only project and holds its bug', async () => {
    expect(await projectScreeningExemption('ws', 'bugsonly', 'change')).toBe('policy:duplicate-screening-bugs');
    expect(await projectScreeningExemption('ws', 'bugsonly', 'bug')).toBeNull();
    expect(await projectScreeningExemption('ws', 'plain', 'change')).toBeNull();
  });
});
