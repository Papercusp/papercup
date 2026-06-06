/**
 * Voice-channel registry — deterministic harness video topic (plan
 * holepunch-video-shared-harnesses-2026-06-05 D-003). operator-state mocked with
 * an in-memory store so this is a pure unit test (no PG).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: { value: {} as Record<string, unknown> } }));
vi.mock('../operator-state-pg', () => ({
  readOperatorState: async (table: string) => store.value[table] ?? null,
  writeOperatorState: async (table: string, value: unknown) => {
    store.value[table] = value;
  },
}));

import { ensureVideoChannel, harnessVideoTopicHex, createVoiceChannel } from './registry';

beforeEach(() => {
  store.value = {};
});

describe('harnessVideoTopicHex', () => {
  it('is a 64-hex (32-byte) topic, deterministic per harness, distinct across harnesses', () => {
    const a = harnessVideoTopicHex('papercup');
    const b = harnessVideoTopicHex('papercup');
    const c = harnessVideoTopicHex('other');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // same harness → same topic (both peers rendezvous)
    expect(a).not.toBe(c); // different harness → different topic
  });
});

describe('ensureVideoChannel', () => {
  it('creates an idempotent channel with the deterministic topic', async () => {
    const ch1 = await ensureVideoChannel('papercup');
    expect(ch1.id).toBe('vid-papercup');
    expect(ch1.name).toBe('video:papercup');
    expect(ch1.topicHex).toBe(harnessVideoTopicHex('papercup'));

    const ch2 = await ensureVideoChannel('papercup');
    expect(ch2).toEqual(ch1); // idempotent — no duplicate, same topic
  });

  it('heals a drifted topic to the deterministic value', async () => {
    // Seed a stale entry with a wrong (random) topic under the same id.
    store.value['operator_voice_channels'] = {
      channels: [{ id: 'vid-papercup', name: 'video:papercup', topicHex: 'deadbeef'.repeat(8), createdAt: 1 }],
    };
    const ch = await ensureVideoChannel('papercup');
    expect(ch.topicHex).toBe(harnessVideoTopicHex('papercup'));
  });

  it('rejects an empty harness', async () => {
    await expect(ensureVideoChannel('  ')).rejects.toThrow(/harness required/);
  });

  it('coexists with named (random-topic) channels', async () => {
    const named = await createVoiceChannel('standup');
    const vid = await ensureVideoChannel('papercup');
    expect(named.topicHex).not.toBe(vid.topicHex);
    expect(named.id).toMatch(/^vc-/);
    expect(vid.id).toBe('vid-papercup');
  });
});
