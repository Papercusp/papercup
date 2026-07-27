/**
 * federated-pot-scope — the PG-level recurrence guard for EI-18777176681958978.
 *
 * The unit tests (federated-pot-scope.test.ts) pin the resolution RULES with injected seams.
 * This file pins the thing that only real Postgres can prove: on a joiner whose LOCAL handle
 * differs from the OWNER-authored slug, the membership rows physically live under the
 * canonical scope, and a reader that resolves through `resolveFederatedPotScope` finds them
 * while the pre-fix local-handle read finds NOTHING.
 *
 * That asymmetry IS the bug, stated as a test: an empty read is indistinguishable from "this
 * Pot has no members" / "nobody is revoked", which is why the defect was silent and why the
 * revocation half was a security hole (`loadRevokedHivePubkeys(<local>)` empty ⇒ a revoked
 * member is never refused).
 *
 * The registry/announce leg (source 1) is stubbed to `null` here on purpose: it reads through
 * the process-wide org PG, not this file's per-file schema, so leaving it live would make the
 * test depend on ambient state. Everything under test — migration 686's column, the repointed
 * `pot_members_pot_fkey`, and both real SQL readers — runs against real PG.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { generateEd25519KeypairDer } from './identity/ed25519';
import { hiveKeychainId } from './identity/hive-keypair';
import { insertHiveIfAbsent } from './hive-store';
import { upsertHiveMember, loadRevokedHivePubkeys, listHiveMembers } from './hive-membership-store';
import { resolveFederatedPotScope, unsafeFederatedPotScope } from './federated-pot-scope';
import { applyPot557RenameAndFixups } from './sync/hyperbee/__tests__/_hive-substrate-rig';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const WS = 'ws-fedscope';
/** What THIS box calls the joined Pot — `freeSlug` suffixed it on a local collision. */
const LOCAL = 'spoon-knife-pot-2';
/** What the OWNER calls it — the scope every hive-home projection writes under. */
// WI-6312: OWNER is the owner-authored slug — i.e. it IS the federated scope, by definition
// of this suite's topology. (LOCAL, above, is the joiner's divergent handle and must stay an
// unbranded string: the whole point of these tests is that it is NOT the federated scope.)
const OWNER = unsafeFederatedPotScope(
  'spoon-knife-pot',
  'fedscope suite: OWNER is the owner-authored slug the projections write under',
);
const REVOKED_PK = 'dev-revoked';

/** Source 1 cannot answer inside a per-file schema (it reads the process org PG). */
const NO_ANNOUNCE_LEG = { canonicalHiveHomeSlug: async () => null };

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('federated-pot-scope');
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8'));
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '185-hive-members-admission.sql'), 'utf8'));
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '406-hive-members-forbid-wildcard-workspace.sql'), 'utf8'));
  await applyPot557RenameAndFixups(db.sql);
  // The subject: canonical_pot_home_slug + the repointed pot_members FK.
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '686-pots-canonical-home-slug-fk.sql'), 'utf8'));
});

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.pot_members, harness_shared.pots CASCADE');
});

/**
 * The divergent-joiner topology: ONE identity row (pots_public_key_key is UNIQUE, so a second
 * row is impossible by construction — see migration 686's rejected alternative (a)), whose
 * local handle and canonical slug differ.
 */
async function seedDivergentJoinerPot(): Promise<void> {
  await insertHiveIfAbsent(
    {
      workspaceId: WS,
      homeSlug: LOCAL,
      pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
      keychainId: hiveKeychainId(WS, LOCAL),
    },
    db.sql,
  );
  // `insertHiveIfAbsent` deliberately does not name the column (the 686 trigger fills it with
  // the local handle), so the divergence is introduced the way reconcilePotCanonicalSlug does:
  // by re-pointing the canonical slug once the owner's announce is known.
  await db.sql.unsafe(
    `UPDATE harness_shared.pots SET canonical_pot_home_slug = $1
      WHERE workspace_id = $2 AND pot_home_slug = $3`,
    [OWNER, WS, LOCAL],
  );
}

describe('EI-18777176681958978 — a divergent joiner reads the scope the writers wrote', () => {
  it('resolves the LOCAL handle to the OWNER scope from migration 686’s column', async () => {
    await seedDivergentJoinerPot();
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      sql: db.sql,
      seams: NO_ANNOUNCE_LEG,
    });
    expect(scope).toBe(OWNER);
  });

  it('the projection-written roster + revocations are readable under the resolved scope, and INVISIBLE under the local handle', async () => {
    await seedDivergentJoinerPot();
    // What the ~16 hiveScoped projections do on this box: persist under the OWNER slug. The
    // FK accepts it because 686 repointed pot_members_pot_fkey at canonical_pot_home_slug —
    // if that regressed, this write throws instead of the read coming back empty.
    await upsertHiveMember(
      {
        workspaceId: WS,
        potHomeSlug: OWNER,
        githubUserId: 7,
        githubUsername: 'octo',
        revokedPubkeys: [REVOKED_PK],
        bindingStatus: 'verified',
      },
      db.sql,
    );

    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      sql: db.sql,
      seams: NO_ANNOUNCE_LEG,
    });

    // FIXED behavior: the reader that resolves sees the roster AND the revocation.
    expect(await listHiveMembers(WS, scope, db.sql)).toHaveLength(1);
    expect([...(await loadRevokedHivePubkeys(WS, scope, db.sql))]).toEqual([REVOKED_PK]);

    // PRE-FIX behavior, kept as the falsifier: reading the LOCAL handle returns an empty set
    // — not an error. `revoked.has(pk)` is then false for every key, i.e. a revoked member is
    // never refused. If a future change makes these two reads agree by accident, the test
    // above stops proving anything, so both halves are asserted together.
    const localScope = await resolveFederatedPotScope(WS, LOCAL, {
      sql: db.sql,
      seams: { canonicalHiveHomeSlug: async () => null, getHiveBySlug: async () => null },
    });
    expect(localScope).toBe(LOCAL); // fail-open reproduces the old scope exactly
    expect(await listHiveMembers(WS, localScope, db.sql)).toHaveLength(0);
    expect([...(await loadRevokedHivePubkeys(WS, localScope, db.sql))]).toEqual([]);
  });

  it('is a NO-OP on an owner (canonical == local): same scope, same rows', async () => {
    // The regression guard for the common case — every owned Pot must behave byte-identically
    // to pre-fix, since the whole live gate runs on owned pots.
    await insertHiveIfAbsent(
      {
        workspaceId: WS,
        homeSlug: OWNER,
        pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
        keychainId: hiveKeychainId(WS, OWNER),
      },
      db.sql,
    );
    await upsertHiveMember(
      { workspaceId: WS, potHomeSlug: OWNER, githubUserId: 1, githubUsername: 'owner' },
      db.sql,
    );
    const scope = await resolveFederatedPotScope(WS, OWNER, {
      sql: db.sql,
      seams: NO_ANNOUNCE_LEG,
    });
    expect(scope).toBe(OWNER); // the 686 trigger filled canonical == local
    expect(await listHiveMembers(WS, scope, db.sql)).toHaveLength(1);
  });
});
