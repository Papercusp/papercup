/**
 * keychain — OS-level (or encrypted-file fallback) persistence for an
 * Ed25519 private key. Originally the device key (Phase 1b attestation,
 * P-011); now also the per-HIVE identity key (shared-hive-federation P-002),
 * which passes a distinct `serviceName`.
 *
 * Tiers, tried in order:
 *   1. `secret-tool` (Linux, libsecret / GNOME Keyring)
 *   2. `security` CLI (macOS Keychain)
 *   3. Encrypted-file fallback in ~/.papercusp/identity/ (AES-256-GCM,
 *      machine-derived PBKDF2 key from hostname + username)
 *
 * Tier 3 is not as strong as an OS keychain but avoids storing the
 * private key in plain text. Acceptable for Phase 1b; a full Tauri
 * stronghold plugin can replace tier 3 if the threat model demands it.
 *
 * All functions are pure async; no module-level side effects.
 *
 * Service name for OS keychain entries defaults to `papercusp-device-keypair`;
 * callers (e.g. the hive keypair) pass their own to namespace a different key
 * class. Account name (label attribute) is the keychainId — e.g.
 * `<github_user_id>:<machine-fingerprint>` for a device, `hive:<ws>:<slug>`
 * for a hive. The encrypted-file fallback keys ONLY by keychainId (those id
 * shapes never collide), so existing on-disk device keys keep resolving
 * unchanged regardless of serviceName.
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { execFile as _execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname as getHostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

// Lazy promisify — import-safe in the operator-vite SPA bundle (node:util is
// browser-stubbed; a top-level promisify() call crashes at import → blank page).
// Deferred to first call; never invoked in the browser.
const execFile: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(_execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);
const pbkdf2Async: (...a: unknown[]) => Promise<Buffer> = (...a) =>
  (promisify(pbkdf2) as (...x: unknown[]) => Promise<Buffer>)(...a);

const SERVICE_NAME = 'papercusp-device-keypair';
const IDENTITY_DIR = join(homedir(), '.papercusp', 'identity');

// AES-256-GCM constants
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 recommendation for PBKDF2-SHA512

// File format: [16-byte salt][12-byte iv][16-byte auth tag][...ciphertext]
const SALT_LEN = 16;
const FILE_HEADER_LEN = SALT_LEN + IV_LEN + TAG_LEN;

export type KeychainError =
  | { kind: 'not_found' }
  | { kind: 'decryption_failed'; reason: string }
  | { kind: 'io_error'; reason: string };

export type KeychainResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: KeychainError };

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Store a private key DER buffer under keychainId. Overwrites any
 * existing entry. Uses the first available backend.
 */
export async function keychainStore(
  keychainId: string,
  privateKeyDer: Buffer,
  serviceName: string = SERVICE_NAME,
): Promise<void> {
  const b64 = privateKeyDer.toString('base64');

  if (await trySecretTool('store', keychainId, b64, serviceName)) return;
  if (await trySecurityCli('store', keychainId, b64, serviceName)) return;
  await fileStore(keychainId, privateKeyDer);
}

/**
 * Load a private key DER buffer by keychainId. Returns `not_found`
 * when no entry exists (first run → caller should generate a new key).
 */
export async function keychainLoad(
  keychainId: string,
  serviceName: string = SERVICE_NAME,
): Promise<KeychainResult<Buffer>> {
  const secTool = await trySecretTool('load', keychainId, '', serviceName);
  if (secTool !== null) {
    if (secTool === '') return { kind: 'error', error: { kind: 'not_found' } };
    return { kind: 'ok', value: Buffer.from(secTool, 'base64') };
  }

  const security = await trySecurityCli('load', keychainId, '', serviceName);
  if (security !== null) {
    if (security === '') return { kind: 'error', error: { kind: 'not_found' } };
    return { kind: 'ok', value: Buffer.from(security, 'base64') };
  }

  return fileLoad(keychainId);
}

/**
 * Delete a keychain entry. No-op if not found.
 */
export async function keychainDelete(
  keychainId: string,
  serviceName: string = SERVICE_NAME,
): Promise<void> {
  await trySecretTool('delete', keychainId, '', serviceName);
  await trySecurityCli('delete', keychainId, '', serviceName);
  await fileDelete(keychainId);
}

// ─── secret-tool (Linux / libsecret) ─────────────────────────────────────────

async function trySecretTool(
  op: 'store' | 'load' | 'delete',
  id: string,
  value: string,
  serviceName: string = SERVICE_NAME,
): Promise<string | null> {
  try {
    if (op === 'store') {
      await execFile('secret-tool', [
        'store',
        '--label', serviceName + ':' + id,
        'service', serviceName,
        'account', id,
      ], { input: value, timeout: 5000 });
      return '';
    }
    if (op === 'load') {
      const { stdout } = await execFile('secret-tool', [
        'lookup',
        'service', serviceName,
        'account', id,
      ], { timeout: 5000 });
      return stdout.trim();
    }
    if (op === 'delete') {
      await execFile('secret-tool', [
        'clear',
        'service', serviceName,
        'account', id,
      ], { timeout: 5000 });
      return '';
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // ENOENT = binary not found; "No matching secret" = not_found for load
    if (/ENOENT|not found|command not found/i.test(msg)) return null;
    if (op === 'load' && /No matching secret/i.test(msg)) return '';
    return null;
  }
}

// ─── security CLI (macOS) ─────────────────────────────────────────────────────

async function trySecurityCli(
  op: 'store' | 'load' | 'delete',
  id: string,
  value: string,
  serviceName: string = SERVICE_NAME,
): Promise<string | null> {
  try {
    if (op === 'store') {
      await execFile('security', [
        'add-generic-password',
        '-s', serviceName,
        '-a', id,
        '-w', value,
        '-U',
      ], { timeout: 5000 });
      return '';
    }
    if (op === 'load') {
      const { stdout } = await execFile('security', [
        'find-generic-password',
        '-s', serviceName,
        '-a', id,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim();
    }
    if (op === 'delete') {
      await execFile('security', [
        'delete-generic-password',
        '-s', serviceName,
        '-a', id,
      ], { timeout: 5000 });
      return '';
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|command not found/i.test(msg)) return null;
    // macOS exits 44 when the item doesn't exist
    if (op === 'load' && /The specified item could not be found|exit code 44/i.test(msg)) return '';
    return null;
  }
}

// ─── encrypted-file fallback ──────────────────────────────────────────────────

function encFilePath(keychainId: string): string {
  // Sanitize the id to a safe filename component
  const safe = keychainId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(IDENTITY_DIR, 'keypair-' + safe + '.enc');
}

async function deriveMachineKey(salt: Buffer): Promise<Buffer> {
  const machineSecret = [getHostname(), userInfo().username, 'papercusp-v1'].join(':');
  return pbkdf2Async(machineSecret, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha512');
}

async function fileStore(keychainId: string, privateKeyDer: Buffer): Promise<void> {
  await mkdir(IDENTITY_DIR, { recursive: true });
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveMachineKey(salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
  await writeFile(encFilePath(keychainId), blob, { mode: 0o600 });
}

async function fileLoad(keychainId: string): Promise<KeychainResult<Buffer>> {
  try {
    const blob = await readFile(encFilePath(keychainId));
    if (blob.length < FILE_HEADER_LEN) {
      return { kind: 'error', error: { kind: 'decryption_failed', reason: 'file too short' } };
    }
    const salt = blob.subarray(0, SALT_LEN);
    const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const authTag = blob.subarray(SALT_LEN + IV_LEN, FILE_HEADER_LEN);
    const ciphertext = blob.subarray(FILE_HEADER_LEN);

    const key = await deriveMachineKey(salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(authTag);
    try {
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return { kind: 'ok', value: plain };
    } catch {
      return {
        kind: 'error',
        error: { kind: 'decryption_failed', reason: 'auth tag mismatch — key rotated or file corrupted' },
      };
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return { kind: 'error', error: { kind: 'not_found' } };
    return { kind: 'error', error: { kind: 'io_error', reason: String(err) } };
  }
}

async function fileDelete(keychainId: string): Promise<void> {
  try {
    await unlink(encFilePath(keychainId));
  } catch {
    // ignore — not_found is fine for delete
  }
}
