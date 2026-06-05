/**
 * Voice-channel registry — the P-007 control plane's persistent half.
 *
 * One JSONB row per workspace (`operator_voice_channels`, migration 164), the
 * standard operator-state pattern. A channel maps a human name to the 32-byte
 * Hyperswarm topic peers rendezvous on. Live presence is NOT here — presence is
 * in-band on the peer connections (D-011); this is just the durable list.
 */
import { randomBytes } from 'node:crypto';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

export interface VoiceChannel {
  id: string;
  name: string;
  topicHex: string;
  createdAt: number;
}

interface VoiceChannelsPayload {
  channels: VoiceChannel[];
}

const TABLE = 'operator_voice_channels' as const;

export async function listVoiceChannels(): Promise<VoiceChannel[]> {
  const payload = await readOperatorState<VoiceChannelsPayload>(TABLE);
  return payload?.channels ?? [];
}

export async function createVoiceChannel(name: string): Promise<VoiceChannel> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('voice: channel name required');
  const channels = await listVoiceChannels();
  const existing = channels.find((c) => c.name === trimmed);
  if (existing) return existing; // idempotent by name
  const channel: VoiceChannel = {
    id: `vc-${randomBytes(4).toString('hex')}`,
    name: trimmed,
    topicHex: randomBytes(32).toString('hex'),
    createdAt: Date.now(),
  };
  await writeOperatorState<VoiceChannelsPayload>(TABLE, { channels: [...channels, channel] });
  return channel;
}

export async function removeVoiceChannel(idOrName: string): Promise<boolean> {
  const channels = await listVoiceChannels();
  const next = channels.filter((c) => c.id !== idOrName && c.name !== idOrName);
  if (next.length === channels.length) return false;
  await writeOperatorState<VoiceChannelsPayload>(TABLE, { channels: next });
  return true;
}

export async function resolveVoiceChannel(idOrName: string): Promise<VoiceChannel | null> {
  const channels = await listVoiceChannels();
  return channels.find((c) => c.id === idOrName || c.name === idOrName) ?? null;
}
