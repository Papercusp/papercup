/**
 * channels.test.ts — the voice:channels HANDLER op dispatch (registry ops mocked). Pins
 * the three branches: list returns the registry; create returns the new channel; remove
 * returns ok = the boolean the registry reports (a remove of a missing channel is
 * ok:false, not a fake success). A regression that mis-routes an op or hard-codes
 * remove's ok is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/voice/channels.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../voice-node/registry', () => ({
  createVoiceChannel: vi.fn(),
  listVoiceChannels: vi.fn(),
  removeVoiceChannel: vi.fn(),
}));

import { createVoiceChannel, listVoiceChannels, removeVoiceChannel } from '../../voice-node/registry';
const createM = vi.mocked(createVoiceChannel);
const listM = vi.mocked(listVoiceChannels);
const removeM = vi.mocked(removeVoiceChannel);
const tool = (await import('./channels')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('voice:channels handler', () => {
  it('list returns the registry', async () => {
    listM.mockResolvedValue([{ id: 'vc-1', name: 'general' }] as never);
    expect(body(await call({ op: 'list' }))).toMatchObject({ ok: true, channels: [{ id: 'vc-1' }] });
  });

  it('create returns the new channel', async () => {
    createM.mockResolvedValue({ id: 'vc-2', name: 'standup' } as never);
    const b = body(await call({ op: 'create', name: 'standup' }));
    expect(createM).toHaveBeenCalledWith('standup');
    expect(b).toMatchObject({ ok: true, channel: { id: 'vc-2', name: 'standup' } });
  });

  it('remove reports ok = the registry boolean (false for a missing channel)', async () => {
    removeM.mockResolvedValue(true as never);
    expect(body(await call({ op: 'remove', channel: 'vc-1' }))).toMatchObject({ ok: true });
    removeM.mockResolvedValue(false as never);
    expect(body(await call({ op: 'remove', channel: 'gone' }))).toMatchObject({ ok: false });
  });
});
