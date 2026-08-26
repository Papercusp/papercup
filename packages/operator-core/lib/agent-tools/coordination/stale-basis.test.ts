import { describe, expect, it } from 'vitest';
import { readStaleBasis, renderStaleBasisSuffix, staleBasis } from './stale-basis';

describe('staleBasis', () => {
  it('detects a work-item version timestamp newer than the read', () => {
    const out = staleBasis([{
      ref: 'work-item:WI-41692',
      via: 'work_items:get',
      readAt: '2026-08-25T21:09:16.000Z',
      versionAtSend: `done@${Date.parse('2026-08-25T21:10:47.721Z')}`,
    }]);
    expect(out).toEqual([expect.objectContaining({
      ref: 'work-item:WI-41692',
      stateAtSend: 'done',
      changedAt: '2026-08-25T21:10:47.721Z',
    })]);
    expect(renderStaleBasisSuffix(out)).toContain('WI-41692 changed after read (now done)');
  });

  it('does not guess for older, opaque, malformed, or non-work-item tokens', () => {
    expect(staleBasis([
      { ref: 'work-item:WI-1', via: 'work_items:get', readAt: '2026-08-25T21:09:16.000Z', versionAtSend: 'open@1' },
      { ref: 'plan:p', via: 'plans:get', readAt: '2026-08-25T21:09:16.000Z', versionAtSend: 'v42' },
      { ref: 'work-item:WI-2', via: 'work_items:get', readAt: 'bad', versionAtSend: 'done@2' },
    ])).toEqual([]);
    expect(readStaleBasis([{ ref: 1 }])).toEqual([]);
  });
});
