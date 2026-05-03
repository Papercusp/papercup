/**
 * Voice credentials reader (Phase 1c).
 *
 * Lives in `~/.papercusp/credentials.json` per the existing credentials
 * pattern (file mode 0600, GET masks values, PUT preserves missing fields).
 * Already on the snapshot private list — keys never travel.
 *
 * v4 §1.2.4: ElevenLabs key sits alongside any other plugin/service keys.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface CredentialsFile {
  elevenlabs?: { apiKey: string };
  openai?: { apiKey: string };
  cartesia?: { apiKey: string };
  deepgram?: { apiKey: string };
  // Other plugin/service keys may live here too — we only read/write
  // our own slice.
  [k: string]: unknown;
}

function PATH(): string {
  return join(homedir(), '.papercusp', 'credentials.json');
}

function readAll(): CredentialsFile {
  const path = PATH();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(creds: CredentialsFile): void {
  const path = PATH();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2));
  try { chmodSync(path, 0o600); } catch { /* best-effort on filesystems without mode */ }
}

/** Return the raw ElevenLabs key (server-side only). Null if not configured. */
export function readElevenLabsKey(): string | null {
  const all = readAll();
  return all.elevenlabs?.apiKey ?? null;
}

/** Mask a key for client display. `sk_••••3c2a` style. */
export function maskKey(key: string | null): string | null {
  if (!key || key.length < 8) return null;
  const tail = key.slice(-4);
  return `${key.slice(0, 3)}_••••${tail}`;
}

/** Set the ElevenLabs key. Pass `null` to clear. */
export function writeElevenLabsKey(apiKey: string | null): void {
  const all = readAll();
  if (apiKey === null) {
    delete all.elevenlabs;
  } else {
    all.elevenlabs = { ...all.elevenlabs, apiKey };
  }
  writeAll(all);
}

export function readOpenAiKey(): string | null {
  const all = readAll();
  return all.openai?.apiKey ?? null;
}

export function writeOpenAiKey(apiKey: string | null): void {
  const all = readAll();
  if (apiKey === null) {
    delete all.openai;
  } else {
    all.openai = { ...all.openai, apiKey };
  }
  writeAll(all);
}

export function readCartesiaKey(): string | null {
  const all = readAll();
  return all.cartesia?.apiKey ?? null;
}

export function writeCartesiaKey(apiKey: string | null): void {
  const all = readAll();
  if (apiKey === null) {
    delete all.cartesia;
  } else {
    all.cartesia = { ...all.cartesia, apiKey };
  }
  writeAll(all);
}

export function readDeepgramKey(): string | null {
  const all = readAll();
  return all.deepgram?.apiKey ?? null;
}

export function writeDeepgramKey(apiKey: string | null): void {
  const all = readAll();
  if (apiKey === null) {
    delete all.deepgram;
  } else {
    all.deepgram = { ...all.deepgram, apiKey };
  }
  writeAll(all);
}
