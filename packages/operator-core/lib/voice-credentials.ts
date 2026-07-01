/**
 * Voice credentials reader/writer.
 *
 * Persisted in `harness_shared.operator_voice_credentials` (PG, migration
 * 023). NOT in the zero_harness publication — credentials must not be
 * broadcast over WS. Read by 10 voice/STT/TTS bootstrap routes; written
 * by /api/agent-mcp/operator-credentials.
 *
 * Was previously `~/.papercusp/credentials.json`. The PG migration also
 * closes a bifurcation bug: `lib/credentials.ts` already moved to PG in
 * round 1 (operator_credentials), but voice-credentials.ts kept reading
 * the file. Both modules used the same physical file with different
 * shapes — after that round, writes split between PG and file. Both are
 * now PG-resident in their own tables.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

interface CredentialsPayload {
  elevenlabs?: { apiKey: string };
  openai?: { apiKey: string };
  cartesia?: { apiKey: string };
  deepgram?: { apiKey: string };
  picovoice?: { apiKey: string };
}

async function readAll(): Promise<CredentialsPayload> {
  const raw = await readOperatorState<CredentialsPayload>('operator_voice_credentials');
  return raw && typeof raw === 'object' ? raw : {};
}

async function writeAll(creds: CredentialsPayload): Promise<void> {
  await writeOperatorState('operator_voice_credentials', creds);
}

/** Mask a key for client display. `sk_••••3c2a` style. */
export function maskKey(key: string | null): string | null {
  if (!key || key.length < 8) return null;
  const tail = key.slice(-4);
  return `${key.slice(0, 3)}_••••${tail}`;
}

/** Return the raw ElevenLabs key (server-side only). Null if not configured. */
export async function readElevenLabsKey(): Promise<string | null> {
  return (await readAll()).elevenlabs?.apiKey ?? null;
}

export async function writeElevenLabsKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.elevenlabs;
  else all.elevenlabs = { ...all.elevenlabs, apiKey };
  await writeAll(all);
}

export async function readOpenAiKey(): Promise<string | null> {
  return (await readAll()).openai?.apiKey ?? null;
}

export async function writeOpenAiKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.openai;
  else all.openai = { ...all.openai, apiKey };
  await writeAll(all);
}

export async function readCartesiaKey(): Promise<string | null> {
  return (await readAll()).cartesia?.apiKey ?? null;
}

export async function writeCartesiaKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.cartesia;
  else all.cartesia = { ...all.cartesia, apiKey };
  await writeAll(all);
}

export async function readDeepgramKey(): Promise<string | null> {
  return (await readAll()).deepgram?.apiKey ?? null;
}

export async function writeDeepgramKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.deepgram;
  else all.deepgram = { ...all.deepgram, apiKey };
  await writeAll(all);
}

export async function readPicovoiceKey(): Promise<string | null> {
  return (await readAll()).picovoice?.apiKey ?? null;
}

export async function writePicovoiceKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.picovoice;
  else all.picovoice = { ...all.picovoice, apiKey };
  await writeAll(all);
}

