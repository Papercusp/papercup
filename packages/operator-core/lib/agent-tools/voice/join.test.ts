/**
 * join.test.ts — the voice:join HANDLER (joinVoiceChannel mocked). Thin, but pins that
 * the channel arg is forwarded to the voice manager and the returned status is surfaced
 * under { ok, status }. A regression that drops the channel arg or the status is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/voice/join.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../voice-node/manager', () => ({ joinVoiceChannel: vi.fn() }));

import { joinVoiceChannel } from '../../voice-node/manager';
const joinM = vi.mocked(joinVoiceChannel);
const tool = (await import('./join')).default;

// voice:join returns the canonical `{ data }` shape (token-opt P-003, migrated
// 2026-08-25 / WI-41709). Pinned deliberately rather than accepting both shapes,
// so a revert to inline JSON fails here instead of passing quietly.
type Out = { data: Record<string, unknown> };
const body = (o: Out) => o.data;

beforeEach(() => vi.clearAllMocks());

describe('voice:join handler', () => {
  it('forwards the channel and surfaces the join status', async () => {
    joinM.mockResolvedValue({ channel: 'vc-1', connected: true } as never);
    const out = (await tool.handler({ channel: 'vc-1' } as never, {} as never)) as Out;
    expect(joinM).toHaveBeenCalledWith('vc-1');
    expect(body(out)).toMatchObject({ ok: true, status: { channel: 'vc-1', connected: true } });
  });
});
