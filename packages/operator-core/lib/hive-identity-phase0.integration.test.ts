/**
 * Phase-0 SEAM integration test (shared-hive-federation-2026-06-08 P-002 + P-003).
 *
 * Proves the two halves of Phase 0 compose end-to-end against a REAL Postgres
 * (migration 184) — the integration risk that unit tests can't reach:
 *   - core libs (su-30045): identity/ed25519.ts pubkey encoding + derive-swarm-topic.ts
 *     hive federation topic.
 *   - entity store (su-02ae39e9): hive-store.ts over harness_shared.hives (migration 184).
 *
 * The seam asserted here is: a minted pubkey (raw-32 base64) survives the PG `bytea`
 * round-trip byte-exact, the stored pubkey derives the SAME federation topic as the
 * minted key, the identity is immutable (re-ensure never rotates it), and one pubkey
 * maps to exactly one Hive (the UNIQUE invariant).
 *
 * We mint pubkeys with the pure `generateEd25519KeypairDer` — byte-identical to what
 * `loadOrGenerateHiveKeypair` returns (both go through ed25519.ts `rawPubkeyBase64`) —
 * so this exercises the store seam without the keychain (whose persistence/stability
 * is fully covered by hive-keypair.test.ts, and whose child_process backend must not
 * be mocked here or it would break the testcontainer).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { generateEd25519KeypairDer } from './identity/ed25519';
import { hiveKeychainId } from './identity/hive-keypair';
import {
  insertHiveIfAbsent,
  upsertRemoteHiveIdentity,
  getHiveBySlug,
  getHiveByPubkey,
  listHives,
  deleteHive,
} from './hive-store';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';

const MIG_184 = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../libs/papercusp/libs/db/sql/184-hives-table.sql',
);
const WS = 'ws-phase0';

/** A minted-key stand-in: EXACTLY the pubkeyBase64 encoding loadOrGenerateHiveKeypair
 *  returns (both route through ed25519.ts rawPubkeyBase64), so the store seam is
 *  identical to the real mint path. */
function mintPubkey(): string {
  return generateEd25519KeypairDer().pubkeyBase64;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('hive-phase0');
  await db.sql.unsafe(readFileSync(MIG_184, 'utf8')); // the REAL migration, not a fixture
});

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.hives');
});

describe('Phase-0 Hive identity seam (keypair encoding → hives table → federation topic)', () => {
  it('mint → persist → read: the stored pubkey is byte-exact and derives the same federation topic', async () => {
    const pub = mintPubkey();
    const keychainId = hiveKeychainId(WS, 'alpha');

    const { record, created } = await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'alpha', pubkeyBase64: pub, keychainId },
      db.sql,
    );
    expect(created).toBe(true);
    expect(record.pubkeyBase64).toBe(pub); // bytea round-trip preserved the raw 32 bytes
    expect(record.keychainId).toBe('hive:ws-phase0:alpha');

    const read = await getHiveBySlug(WS, 'alpha', db.sql);
    expect(read?.pubkeyBase64).toBe(pub);

    // P-003: the topic derived from the STORED pubkey == from the minted key
    expect(
      deriveHiveFederationTopic(read!.pubkeyBase64).equals(deriveHiveFederationTopic(pub)),
    ).toBe(true);
  });

  it('rejects a malformed (non-32-byte) pubkey before it can land as a Hive identity', async () => {
    await expect(
      insertHiveIfAbsent(
        { workspaceId: WS, homeSlug: 'bad', pubkeyBase64: Buffer.alloc(16).toString('base64'), keychainId: 'k' },
        db.sql,
      ),
    ).rejects.toThrow(/32 raw bytes/);
  });

  it('is idempotent and IMMUTABLE — re-ensure never rotates the identity key', async () => {
    const pub1 = mintPubkey();
    const a = await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'beta', pubkeyBase64: pub1, keychainId: hiveKeychainId(WS, 'beta') },
      db.sql,
    );
    expect(a.created).toBe(true);

    // re-ensure with the SAME key → no-op insert
    const same = await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'beta', pubkeyBase64: pub1, keychainId: hiveKeychainId(WS, 'beta') },
      db.sql,
    );
    expect(same.created).toBe(false);
    expect(same.record.pubkeyBase64).toBe(pub1);

    // re-ensure with a DIFFERENT key MUST NOT rotate the stored identity (federation
    // topic stability depends on the key never silently changing)
    const pub2 = mintPubkey();
    const rotated = await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'beta', pubkeyBase64: pub2, keychainId: hiveKeychainId(WS, 'beta') },
      db.sql,
    );
    expect(rotated.created).toBe(false);
    expect(rotated.record.pubkeyBase64).toBe(pub1); // unchanged — NOT pub2

    expect(await listHives(WS, db.sql)).toHaveLength(1); // never duplicated
  });

  it('repairs stale remote view identities but never clobbers owned hive identities', async () => {
    const staleRemote = mintPubkey();
    const freshRemote = mintPubkey();
    await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'remote-view', pubkeyBase64: staleRemote, keychainId: 'remote:old' },
      db.sql,
    );

    const repaired = await upsertRemoteHiveIdentity(
      { workspaceId: WS, homeSlug: 'remote-view', pubkeyBase64: freshRemote, keychainId: 'remote:new' },
      db.sql,
    );
    expect(repaired.created).toBe(false);
    expect(repaired.repaired).toBe(true);
    expect(repaired.record.pubkeyBase64).toBe(freshRemote);
    expect(repaired.record.keychainId).toBe('remote:new');

    const owned = mintPubkey();
    const ownedKeychainId = hiveKeychainId(WS, 'owned');
    await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'owned', pubkeyBase64: owned, keychainId: ownedKeychainId },
      db.sql,
    );
    const attempted = await upsertRemoteHiveIdentity(
      { workspaceId: WS, homeSlug: 'owned', pubkeyBase64: mintPubkey(), keychainId: 'remote:not-owned' },
      db.sql,
    );
    expect(attempted.created).toBe(false);
    expect(attempted.repaired).toBe(false);
    expect(attempted.record.pubkeyBase64).toBe(owned);
    expect(attempted.record.keychainId).toBe(ownedKeychainId);
  });

  it('resolves a Hive by its pubkey (dial identity) and enforces one-pubkey-one-Hive (UNIQUE)', async () => {
    const pub = mintPubkey();
    await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'gamma', pubkeyBase64: pub, keychainId: hiveKeychainId(WS, 'gamma') },
      db.sql,
    );

    const byPub = await getHiveByPubkey(WS, pub, db.sql);
    expect(byPub?.homeSlug).toBe('gamma');

    // a DIFFERENT hive cannot reuse the same pubkey (the cross-Hive addressing invariant)
    await expect(
      insertHiveIfAbsent(
        { workspaceId: WS, homeSlug: 'gamma-clone', pubkeyBase64: pub, keychainId: hiveKeychainId(WS, 'gamma-clone') },
        db.sql,
      ),
    ).rejects.toThrow();
  });

  it('distinct hives get distinct keypairs AND distinct federation topics', async () => {
    const a = mintPubkey();
    const b = mintPubkey();
    expect(a).not.toBe(b);
    expect(
      deriveHiveFederationTopic(a).equals(deriveHiveFederationTopic(b)),
    ).toBe(false);
  });

  it('deleteHive removes the identity row (create-rollback / dissolve path)', async () => {
    await insertHiveIfAbsent(
      { workspaceId: WS, homeSlug: 'doomed', pubkeyBase64: mintPubkey(), keychainId: hiveKeychainId(WS, 'doomed') },
      db.sql,
    );
    expect(await deleteHive(WS, 'doomed', db.sql)).toBe(true);
    expect(await getHiveBySlug(WS, 'doomed', db.sql)).toBeNull();
    expect(await deleteHive(WS, 'doomed', db.sql)).toBe(false); // idempotent
  });
});
