import { describe, expect, it, vi } from 'vitest';

import {
  parseAgentTimelineEntries,
  parseOperatorDeadPayload,
  parseUiIntentMessage,
} from './cross-boundary-event-contracts';

describe('cross-boundary event contracts', () => {
  it('accepts each canonical payload shape', () => {
    expect(parseUiIntentMessage({ id: 1, intent: 'focus', args: {} })).toEqual({
      id: 1, intent: 'focus', args: {},
    });
    expect(parseOperatorDeadPayload({ reason: 'cap hit', respawns: 5, window_secs: 300 }))
      .toEqual({ reason: 'cap hit', respawns: 5, window_secs: 300 });
    expect(parseAgentTimelineEntries([{ kind: 'tool_use', toolName: 'coord:orient' }]))
      .toEqual([{ kind: 'tool_use', toolName: 'coord:orient' }]);
  });

  it('drops malformed records fail-soft and reports bounded drift without payload values', () => {
    const report = vi.fn();
    expect(parseUiIntentMessage({ id: 'secret', intent: 'focus', args: {} }, report)).toBeNull();
    expect(parseOperatorDeadPayload({ reason: 'secret', respawns: 'five', window_secs: 300 }, report))
      .toBeNull();
    expect(parseAgentTimelineEntries([
      { kind: 'text', text: 'kept' },
      { kind: 'future-kind', text: 'secret' },
    ], report)).toEqual([{ kind: 'text', text: 'kept' }]);
    expect(report).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
  });
});
