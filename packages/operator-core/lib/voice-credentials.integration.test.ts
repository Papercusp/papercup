/**
 * voice-credentials.integration.test.ts — real testcontainer PG with pgcrypto.
 *
 * Voice provider API keys are encrypted-at-rest (operator_voice_credentials is
 * in ENCRYPTED_TABLES — payload_ct BYTEA via pgp_sym_encrypt). Untested. This
 * exercises the real write→read round-trip through operator-state-pg's
 * encryption layer and asserts the security property that matters: the
 * plaintext key never lands in the row. Plus per-provider independence,
 * deletion, and the display mask.
 *
 * P-012 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as import('postgres').Sql }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql, db: {} }) };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
// Control the encryption key + mark the credentials table encrypted (avoids the
// ~/.papercusp/db-encryption-key file dependency).
vi.mock('./db-encryption', () => ({
  ENCRYPTED_TABLES: new Set(['operator_voice_credentials']),
  getDbEncryptionKey: () => 'test-encryption-key-deterministic',
}));

import {
  readElevenLabsKey,
  writeElevenLabsKey,
  readOpenAiKey,
  writeOpenAiKey,
  readDeepgramKey,
  writeDeepgramKey,
  maskKey,
} from './voice-credentials';

const DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS harness_shared.operator_voice_credentials (
    workspace_id TEXT PRIMARY KEY,
    payload      JSONB,
    payload_ct   BYTEA,
    updated_at   BIGINT
  );
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('voicecreds');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.operator_voice_credentials`;
});

describe('voice-credentials — encrypted round-trip', () => {
  it('writes then reads back the ElevenLabs key', async () => {
    await writeElevenLabsKey('sk-eleven-abcdef');
    expect(await readElevenLabsKey()).toBe('sk-eleven-abcdef');
  });

  it('stores ciphertext at rest — the plaintext key never appears in the row', async () => {
    const SECRET = 'sk-plaintext-supersecret-9999';
    await writeElevenLabsKey(SECRET);
    const raw = await db.sql`
      SELECT payload::text AS payload, encode(payload_ct, 'escape') AS ct_text, payload_ct
        FROM harness_shared.operator_voice_credentials WHERE workspace_id = 'ws-test'
    `;
    expect(raw).toHaveLength(1);
    expect(raw[0].payload).toBe('{}'); // legacy plaintext column kept empty
    expect(raw[0].payload_ct).toBeTruthy(); // ciphertext present
    expect(String(raw[0].ct_text)).not.toContain(SECRET); // not stored in the clear
    // and it still decrypts back through the lib
    expect(await readElevenLabsKey()).toBe(SECRET);
  });

  it('keeps providers independent (multiple keys coexist)', async () => {
    await writeElevenLabsKey('el-key');
    await writeOpenAiKey('oa-key');
    await writeDeepgramKey('dg-key');
    expect(await readElevenLabsKey()).toBe('el-key');
    expect(await readOpenAiKey()).toBe('oa-key');
    expect(await readDeepgramKey()).toBe('dg-key');
  });

  it('writing null deletes one provider key without disturbing others', async () => {
    await writeElevenLabsKey('el-key');
    await writeOpenAiKey('oa-key');
    await writeElevenLabsKey(null);
    expect(await readElevenLabsKey()).toBeNull();
    expect(await readOpenAiKey()).toBe('oa-key');
  });

  it('overwrites an existing key in place', async () => {
    await writeOpenAiKey('first');
    await writeOpenAiKey('second');
    expect(await readOpenAiKey()).toBe('second');
    const rows = await db.sql`SELECT count(*)::int AS n FROM harness_shared.operator_voice_credentials`;
    expect(rows[0].n).toBe(1); // single-row-per-workspace upsert
  });

  it('returns null for an unconfigured provider', async () => {
    expect(await readDeepgramKey()).toBeNull();
  });
});

describe('maskKey', () => {
  it('masks a normal key keeping the prefix + last 4', () => {
    expect(maskKey('sk-1234567890')).toBe('sk-_••••7890');
  });
  it('returns null for null or too-short keys', () => {
    expect(maskKey(null)).toBeNull();
    expect(maskKey('short')).toBeNull();
  });
});
