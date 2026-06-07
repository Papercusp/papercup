/**
 * Voice relay config resolution (P-013/D-009) — env ∪ PG merge, validation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  state: null as unknown,
  written: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => pg.state,
  writeOperatorState: async (key: string, value: unknown) => {
    pg.written.push({ key, value });
  },
}));

import { getVoiceRelayKeys, readVoiceRelayState } from './voice-relay';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

afterEach(() => {
  pg.state = null;
  pg.written.length = 0;
  delete process.env.PAPERCUSP_VOICE_RELAY_KEYS;
});

describe('getVoiceRelayKeys', () => {
  it('returns [] with nothing configured', async () => {
    expect(await getVoiceRelayKeys()).toEqual([]);
  });

  it('parses env keys (comma-separated hex)', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = `${KEY_A}, ${KEY_B}`;
    const keys = await getVoiceRelayKeys();
    expect(keys.map((b) => b.toString('hex'))).toEqual([KEY_A, KEY_B]);
  });

  it('unions env with the PG state, deduped', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = KEY_A;
    pg.state = { relayKeys: [KEY_A, KEY_B] };
    const keys = await getVoiceRelayKeys();
    expect(keys.map((b) => b.toString('hex'))).toEqual([KEY_A, KEY_B]);
  });

  it('drops malformed keys instead of throwing', async () => {
    process.env.PAPERCUSP_VOICE_RELAY_KEYS = `nonsense, ${KEY_A}, 1234`;
    pg.state = { relayKeys: ['zz'.repeat(32)] };
    const keys = await getVoiceRelayKeys();
    expect(keys.map((b) => b.toString('hex'))).toEqual([KEY_A]);
  });
});

describe('readVoiceRelayState', () => {
  it('defaults to {} when the row is unset', async () => {
    expect(await readVoiceRelayState()).toEqual({});
  });
  it('returns the stored state', async () => {
    pg.state = { serve: true, relayKeys: [KEY_A] };
    expect(await readVoiceRelayState()).toEqual({ serve: true, relayKeys: [KEY_A] });
  });
});
