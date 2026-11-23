import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadHarnessRegistryMock = vi.fn();
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: (...args: unknown[]) => loadHarnessRegistryMock(...args),
}));

import {
  DEFAULT_DUPLICATE_SCREENING_FILTER,
  duplicateScreeningComplaint,
  duplicateScreeningOf,
  projectDuplicateScreening,
  projectScreeningExemption,
  screeningExemption,
  screeningHolds,
} from './work-items-duplicate-screening';

const bug = { kind: 'bug', severity: 'major', title: 'loader drops rows', topics: ['loader'] };
const change = { kind: 'change', severity: 'minor', title: 'add a slug helper', planRef: 'IDC-412' };

describe('duplicate screening (pure)', () => {
  it('holds the items its filter selects and no others', () => {
    expect(screeningHolds({ kind: 'bug' }, bug)).toBe(true);
    expect(screeningHolds({ kind: 'bug' }, change)).toBe(false);
    expect(screeningHolds({ kind: { in: ['bug', 'change'] } }, change)).toBe(true);
    // Any fact of the item can be filtered on, and conditions combine.
    expect(screeningHolds({ all: [{ kind: 'bug' }, { not: { severity: 'major' } }] }, bug)).toBe(false);
    expect(screeningHolds({ planRef: { exists: true } }, change)).toBe(true);
    expect(screeningHolds({ planRef: { exists: true } }, bug)).toBe(false);
  });

  it('holds every item under the empty filter and none when off', () => {
    expect([bug, change].map((item) => screeningHolds({}, item))).toEqual([true, true]);
    expect([bug, change].map((item) => screeningHolds('off', item))).toEqual([false, false]);
  });

  it('holds the item when its filter cannot be evaluated', () => {
    expect(screeningHolds({ title: { matches: '(' } }, bug)).toBe(true);
  });

  it('names the policy that admitted an item, and names nothing for an item it holds', () => {
    expect(screeningExemption('off', bug)).toBe('policy:duplicate-screening-off');
    expect(screeningExemption({ kind: 'bug' }, change)).toBe('policy:duplicate-screening-filter');
    expect(screeningExemption({ kind: 'bug' }, bug)).toBeNull();
  });

  it('reads the bug filter from overrides that name no screening or one that is not valid', () => {
    expect(DEFAULT_DUPLICATE_SCREENING_FILTER).toEqual({ kind: 'bug' });
    expect(duplicateScreeningOf(undefined)).toEqual({ kind: 'bug' });
    expect(duplicateScreeningOf({ duplicateScreening: null })).toEqual({ kind: 'bug' });
    expect(duplicateScreeningOf({ duplicateScreening: 'bugs' })).toEqual({ kind: 'bug' });
    expect(duplicateScreeningOf({ duplicateScreening: { all: 'not a list' } })).toEqual({ kind: 'bug' });
    expect(duplicateScreeningOf({ duplicateScreening: 'off' })).toBe('off');
    expect(duplicateScreeningOf({ duplicateScreening: {} })).toEqual({});
    expect(duplicateScreeningOf({ duplicateScreening: { kind: { in: ['bug', 'task'] } } })).toEqual({
      kind: { in: ['bug', 'task'] },
    });
  });

  it('complains about a value that is neither off nor a filter when one is about to be stored', () => {
    expect(duplicateScreeningComplaint({ maxCostUsd: 5 })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: 'off' })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: { kind: 'bug' } })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: {} })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: null })).toBeNull();
    expect(duplicateScreeningComplaint({ duplicateScreening: 'bugs' })).toContain('"off"');
    expect(duplicateScreeningComplaint({ duplicateScreening: { all: 'not a list' } })).toContain('filter');
    expect(duplicateScreeningComplaint({ duplicateScreening: ['bug'] })).toContain('["bug"]');
  });
});

describe('a project\'s screening, read from the registry', () => {
  beforeEach(() => {
    loadHarnessRegistryMock.mockReset();
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [
        { slug: 'small', path: '/p/small', configOverrides: { duplicateScreening: 'off' } },
        { slug: 'wide', path: '/p/wide', configOverrides: { duplicateScreening: {} } },
        { slug: 'plain', path: '/p/plain' },
      ],
    });
  });

  it('is what the project set, and the bug filter for a project that set nothing', async () => {
    expect(await projectDuplicateScreening('ws', 'small')).toBe('off');
    expect(await projectDuplicateScreening('ws', 'wide')).toEqual({});
    expect(await projectDuplicateScreening('ws', 'plain')).toEqual({ kind: 'bug' });
    expect(loadHarnessRegistryMock).toHaveBeenCalledWith('ws');
  });

  it('is the bug filter for a project that is not registered, is not named, or cannot be read', async () => {
    expect(await projectDuplicateScreening('ws', 'nowhere')).toEqual({ kind: 'bug' });
    expect(await projectDuplicateScreening('ws', undefined)).toEqual({ kind: 'bug' });
    expect(await projectDuplicateScreening('ws', '*')).toEqual({ kind: 'bug' });
    loadHarnessRegistryMock.mockRejectedValueOnce(new Error('registry unreadable'));
    expect(await projectDuplicateScreening('ws', 'small')).toEqual({ kind: 'bug' });
  });

  it('admits a change and holds a bug in a project that set nothing', async () => {
    expect(await projectScreeningExemption('ws', 'plain', change)).toBe('policy:duplicate-screening-filter');
    expect(await projectScreeningExemption('ws', 'plain', bug)).toBeNull();
    expect(await projectScreeningExemption('ws', 'wide', change)).toBeNull();
    expect(await projectScreeningExemption('ws', 'small', bug)).toBe('policy:duplicate-screening-off');
  });
});
