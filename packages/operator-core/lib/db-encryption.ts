/**
 * Encryption-at-rest key sourcing for the credentials-class operator-state
 * tables.
 *
 * Resolution order:
 *   1. `process.env.PAPERCUSP_DB_ENCRYPTION_KEY` — deploy-time override.
 *      Strings are passed verbatim to pgcrypto's pgp_sym_encrypt.
 *   2. `~/.papercusp/db-encryption-key` — auto-bootstrapped on first
 *      access. 32 random bytes, base64-encoded (44 chars), mode 0600.
 *
 * Loss of the key file (with no env override) means the encrypted
 * credentials are unrecoverable. They're not catastrophic to lose
 * (re-enter API keys via the UI), but document accordingly in the
 * runbook.
 *
 * The set of tables encrypted is narrow on purpose:
 *   - operator_credentials, operator_voice_credentials  — API keys
 *   - operator_marketplace_token, operator_publish_credentials — tokens
 *   - operator_trust_store — publisher fingerprints + rotation log
 *
 * Each is single-row-per-workspace with a JSONB payload; the encrypted
 * column is `payload_ct BYTEA` alongside the legacy `payload JSONB`. The
 * read helper prefers `payload_ct` when present and falls back to
 * `payload` while the staged backfill is rolling. Write helpers always
 * write `payload_ct`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const ENV_VAR = 'PAPERCUSP_DB_ENCRYPTION_KEY';

/**
 * Resolve the key-file path lazily. This MUST NOT run at module-eval time:
 * this module is transitively pulled into the operator-vite renderer bundle
 * (via `operator-state-pg.ts` → `ENCRYPTED_TABLES`), where `node:os` is an
 * empty browser stub and `homedir()` is `undefined` — a top-level call threw
 * "homedir is not a function" on chunk load. Deferring it means importing the
 * module is side-effect-free; the fs/os work only runs server-side when
 * `getDbEncryptionKey()` is actually called.
 */
function keyFile(): string {
  return join(homedir(), '.papercusp', 'db-encryption-key');
}

let _cachedKey: string | null = null;

/**
 * Set of tables whose JSONB payload is encrypted-at-rest. Adding a table
 * here means the helpers in `operator-state-pg.ts` will route reads
 * through `pgp_sym_decrypt` and writes through `pgp_sym_encrypt`. Tables
 * NOT in this set continue to use plaintext JSONB.
 */
export const ENCRYPTED_TABLES = new Set<string>([
  'operator_credentials',
  'operator_voice_credentials',
  'operator_marketplace_token',
  'operator_publish_credentials',
  'operator_trust_store',
  // Migration 047 — search-provider API keys for OMP web_search.
  'operator_search_provider_credentials',
  // Migration 526 — generic third-party integration API keys (owner-ask-batch-2026-07-06 P-002).
  'operator_integration_credentials',
]);

/**
 * Returns the symmetric key as a string. Bootstraps a key file on first
 * call if neither the env var nor the file exists. Cached in-process.
 */
export function getDbEncryptionKey(): string {
  if (_cachedKey !== null) return _cachedKey;

  const fromEnv = process.env[ENV_VAR];
  if (fromEnv && fromEnv.trim()) {
    _cachedKey = fromEnv.trim();
    return _cachedKey;
  }

  const KEY_FILE = keyFile();
  if (existsSync(KEY_FILE)) {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    if (raw) {
      _cachedKey = raw;
      return _cachedKey;
    }
  }

  // Bootstrap: generate a 32-byte random key, base64-encoded, mode 0600.
  // The dir already exists for normal installs; create defensively.
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const generated = randomBytes(32).toString('base64');
  writeFileSync(KEY_FILE, generated + '\n', { encoding: 'utf8' });
  chmodSync(KEY_FILE, 0o600);
  _cachedKey = generated;
  return _cachedKey;
}

/** Test-only — drop the in-process cache so `getDbEncryptionKey()` re-resolves. */
export function __resetDbEncryptionKeyForTests(): void {
  _cachedKey = null;
}
