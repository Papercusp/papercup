import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettings = vi.fn();
const snapshot = vi.fn();

vi.mock('./singleton', () => ({
  workspaceBackupFor: () => ({ getSettings, snapshot }),
}));

import { triggerSnapshotEvent } from './scheduler';

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    cadenceMode: 'event',
    eventTriggers: ['pre_destructive', 'startup'],
    ...overrides,
  };
}

describe('triggerSnapshotEvent cadence admission', () => {
  beforeEach(() => {
    getSettings.mockReset();
    snapshot.mockReset();
  });

  it('does not run lifecycle events in interval-only mode', async () => {
    getSettings.mockResolvedValue(settings({ cadenceMode: 'interval' }));

    await triggerSnapshotEvent('interval-only', 'pre_destructive');
    await triggerSnapshotEvent('interval-only-startup', 'startup');

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('runs an opted-in lifecycle event in event mode', async () => {
    getSettings.mockResolvedValue(settings());

    await triggerSnapshotEvent('event-only', 'pre_destructive', { source: 'test' });

    expect(snapshot).toHaveBeenCalledWith('pre_destructive', { source: 'test' });
  });

  it('does not run an event omitted from the trigger list', async () => {
    getSettings.mockResolvedValue(settings({ cadenceMode: 'both', eventTriggers: [] }));

    await triggerSnapshotEvent('both-without-trigger', 'pre_destructive');

    expect(snapshot).not.toHaveBeenCalled();
  });
});
