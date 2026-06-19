/**
 * transcript.test.ts — the voice:transcript HANDLER (transcript-log mocked).
 * Pins that each op forwards to the buffer module and surfaces its result under
 * the documented shape: enable/disable toggle + return the state, read forwards
 * {since,limit} and surfaces {entries,cursor,lossy,enabled}, status returns the
 * state. A regression that drops the cursor or the since/limit args is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/voice/transcript.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../voice-node/transcript-log', () => ({
  enableTranscriptCapture: vi.fn(),
  readTranscripts: vi.fn(),
  transcriptCaptureEnabled: vi.fn(() => true),
  transcriptLogState: vi.fn(() => ({
    enabled: true,
    headSeq: 3,
    buffered: 3,
    dropped: 0,
    capacity: 200,
  })),
}));

import {
  enableTranscriptCapture,
  readTranscripts,
  transcriptCaptureEnabled,
} from '../../voice-node/transcript-log';
const enableM = vi.mocked(enableTranscriptCapture);
const readM = vi.mocked(readTranscripts);
const enabledM = vi.mocked(transcriptCaptureEnabled);
const tool = (await import('./transcript')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('voice:transcript handler', () => {
  it('enable turns capture on and returns the log state', async () => {
    const out = (await tool.handler({ op: 'enable' } as never, {} as never)) as Out;
    expect(enableM).toHaveBeenCalledWith(true);
    expect(body(out)).toMatchObject({ ok: true, enabled: true, headSeq: 3, capacity: 200 });
  });

  it('disable turns capture off and returns the log state', async () => {
    const out = (await tool.handler({ op: 'disable' } as never, {} as never)) as Out;
    expect(enableM).toHaveBeenCalledWith(false);
    expect(body(out)).toMatchObject({ ok: true });
  });

  it('status returns the log state without toggling', async () => {
    const out = (await tool.handler({ op: 'status' } as never, {} as never)) as Out;
    expect(enableM).not.toHaveBeenCalled();
    expect(body(out)).toMatchObject({ ok: true, buffered: 3, dropped: 0 });
  });

  it('read forwards {since,limit} and surfaces {entries,cursor,lossy,enabled}', async () => {
    readM.mockReturnValue({
      entries: [{ peerId: 'p', text: 'hi', seconds: 1, at: 0, seq: 4 }],
      cursor: 4,
      lossy: false,
    });
    const out = (await tool.handler({ op: 'read', since: 3, limit: 10 } as never, {} as never)) as Out;
    expect(readM).toHaveBeenCalledWith({ since: 3, limit: 10 });
    expect(enabledM).toHaveBeenCalled();
    expect(body(out)).toMatchObject({
      ok: true,
      enabled: true,
      cursor: 4,
      lossy: false,
      entries: [{ text: 'hi', seq: 4 }],
    });
  });

  it('read with no args forwards an empty options object (everything buffered)', async () => {
    readM.mockReturnValue({ entries: [], cursor: 0, lossy: false });
    const out = (await tool.handler({ op: 'read' } as never, {} as never)) as Out;
    expect(readM).toHaveBeenCalledWith({ since: undefined, limit: undefined });
    expect(body(out)).toMatchObject({ ok: true, entries: [], cursor: 0 });
  });
});
