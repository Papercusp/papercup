/**
 * A-003 (shared-hive-release-testing Brief I) — the JOINER projection-binding fix.
 *
 * A joiner boots a MEMBER harness; the hive_members / hive_settings ops it reads
 * off the shared Hive topic carry the HIVE-HOME slug (hive_home_slug / harness_slug
 * = the Hive home). Before this fix the member-slug-bound projections dropped them
 * — the member list/settings never reached the joiner, and
 * `loadRevokedHivePubkeys(<home>)` was empty so a revoked member was never refused
 * by the joiner's admission union. `register-all`'s `potHomeSlug` binds ONLY those
 * two projections to the home slug so the already-running member merge lands them.
 *
 * This drives the REAL `buildHarnessProjectionApply` dispatch (boot's scoped apply,
 * NOT a hand-bound projection), constructing federated (origin='remote') ops:
 *   - member-slug apply, no potHomeSlug  → DROPS the home-grained ops (the A-003 bug, RED)
 *   - member-slug apply WITH potHomeSlug → LANDS them under the home slug (the fix, GREEN)
 * Teeth: the first two `it`s ARE the RED/GREEN pair; neutering `register-all`'s
 * `hiveScoped` (back to `opts`) flips the GREEN ones red.
 *
 * Real full-schema PG (createOrgTestDb → the boot-path migration runner) so the
 * hive_members/hive_settings capture triggers + functions exist; assertions use the
 * RLS-bypass admin client.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { generateEd25519KeypairDer } from '../../../identity/ed25519';
import { hiveKeychainId } from '../../../identity/hive-keypair';
import { insertHiveIfAbsent } from '../../../hive-store';
import { loadRevokedHivePubkeys, getHiveMember } from '../../../hive-membership-store';
import { getHiveSetting } from '../../../hive-settings-store';
import { buildHarnessProjectionApply } from './register-all';
import { announceSlugInScope } from '../read-admission';
import type { OpEnvelope } from '../op-envelope-types';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';

const WS = 'ws-a003';
const HOME = 'hive-home'; // the Hive home slug — the op carries this
const MEMBER = 'member-repo'; // the harness a joiner actually boots
const OWN_LOG = 'own-log-hex';
const REMOTE_LOG = 'remote-log-hex'; // != OWN_LOG → origin='remote' (a federated op)

function dev(pk: string): DeviceAttestationEntry {
  return { device_pubkey: pk, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' };
}

/** A federated (remote) hive_members put, exactly as the read-merge would hand it
 *  to the scoped apply (sourceLogKeyHex != ownLog → origin='remote', not skipped). */
function memberOp(over: Record<string, unknown> = {}, ts = 100): OpEnvelope {
  return {
    type: 'put',
    table: 'hive-members',
    hbKey: '7',
    value: {
      hive_home_slug: HOME,
      github_user_id: 7,
      github_username: 'octo',
      device_attestations: [dev('pk-a')],
      revoked_pubkeys: [],
      binding_status: 'verified',
      ...over,
    },
    ts,
    writerPubkey: 'peer-hex',
    sourceLogKeyHex: REMOTE_LOG,
  };
}
function settingsOp(over: Record<string, unknown> = {}, ts = 100): OpEnvelope {
  return {
    type: 'put',
    table: 'hive-settings-by-key',
    hbKey: 'theme',
    value: { harness_slug: HOME, setting_key: 'theme', value: '"dark"', ...over },
    ts,
    writerPubkey: 'peer-hex',
    sourceLogKeyHex: REMOTE_LOG,
  };
}

let db: OrgTestDb;

/** A member-slug apply WITHOUT the fix — today's behavior (the bug). */
const memberBoundApply = () =>
  buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: MEMBER, sql: db.adminSql, ownLogKeyHex: OWN_LOG });
/** A member-slug apply WITH the fix — the joiner binds the two hive tables to HOME. */
const joinerApply = () =>
  buildHarnessProjectionApply({
    workspaceId: WS,
    harnessSlug: MEMBER,
    sql: db.adminSql,
    ownLogKeyHex: OWN_LOG,
    potHomeSlug: HOME,
  });

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.adminSql.unsafe(
    'TRUNCATE harness_shared.hive_members, harness_shared.hive_settings, harness_shared.hives CASCADE',
  );
});

async function seedHive(slug: string) {
  await insertHiveIfAbsent(
    {
      workspaceId: WS,
      homeSlug: slug,
      pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
      keychainId: hiveKeychainId(WS, slug),
    },
    db.adminSql,
  );
}

describe('A-003 — hive_members/hive_settings reach a member-booted joiner', () => {
  it('RED (the bug): a member-slug apply with NO potHomeSlug drops the home-grained ops', async () => {
    await seedHive(HOME);
    const apply = memberBoundApply();
    await apply(memberOp());
    await apply(settingsOp());
    // The op is decoded + writeToPg is called, but the member-slug guard no-ops it.
    expect(await getHiveMember(WS, HOME, 7, db.adminSql)).toBeNull();
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).toBeNull();
  });

  it('GREEN (the fix): with potHomeSlug=HOME the same ops land under the home slug', async () => {
    await seedHive(HOME);
    const apply = joinerApply();
    await apply(memberOp());
    await apply(settingsOp());
    expect((await getHiveMember(WS, HOME, 7, db.adminSql))?.githubUsername).toBe('octo');
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull();
  });

  it('revocation reaches the joiner: a federated revoked_pubkeys lands where loadRevokedHivePubkeys reads', async () => {
    await seedHive(HOME);
    // The revocation half of A-003: without the fix the joiner's admission union is empty.
    await memberBoundApply()(memberOp({ revoked_pubkeys: ['bad-pk'] }));
    expect([...(await loadRevokedHivePubkeys(WS, HOME, db.adminSql))]).toEqual([]);
    // With the fix, the revoked pubkey reaches the union boot.ts seeds/refreshes from.
    await db.adminSql.unsafe('TRUNCATE harness_shared.hive_members CASCADE');
    await joinerApply()(memberOp({ revoked_pubkeys: ['bad-pk'] }));
    expect([...(await loadRevokedHivePubkeys(WS, HOME, db.adminSql))]).toEqual(['bad-pk']);
  });

  it('surgical: the rebind still DEMUXES — an op for a DIFFERENT hive home is dropped', async () => {
    await seedHive(HOME);
    await seedHive('other-hive');
    const apply = joinerApply(); // bound to HOME
    await apply(memberOp({ hive_home_slug: 'other-hive', github_user_id: 9 }));
    await apply(settingsOp({ harness_slug: 'other-hive' }));
    expect(await getHiveMember(WS, HOME, 9, db.adminSql)).toBeNull(); // not under our home
    expect(await getHiveMember(WS, 'other-hive', 9, db.adminSql)).toBeNull(); // and not blindly accepted
    expect(await getHiveSetting(WS, 'other-hive', 'theme', db.adminSql)).toBeNull();
  });
});

// A-003 (a′): the SEND-SIDE composition. Once the owner's hive-home harness federates
// its log on the shared topic (the re-key) and dc9db's (a′) broadcasts it alongside the
// member's, the onAnnounce slug-filter (`announceSlugInScope`) decides WHICH logs a
// harness merges — and the rebind (above) lands the admitted hive-home ops under the
// home. This composes the two halves over the REAL apply: the slug-filter is the gate;
// the rebind is the landing. (The full on-the-wire/binary crossing is su-9140a's live
// content-matrix witness; this is the durable, in-suite regression guard for the
// gate↔apply composition + the no-cross-merge invariant.)
describe('A-003 (a′) — slug-filter gate composed with the rebind apply', () => {
  it("a JOINER's member harness admits the hive-home log (slug-filter) → the rebind lands its ops under the home", async () => {
    await seedHive(HOME);
    // GATE: a joiner's member harness (ownSlug=MEMBER) whose joinerPotHomeSlug rebinds
    // HOME admits the hive-home log (origin-slug=HOME).
    expect(announceSlugInScope(HOME, MEMBER, HOME)).toBe(true);
    // LANDING: so the hive-home log's ops reach the member's (rebound) apply + materialise
    // under the home slug — origin='remote' (a federated crossing), exactly the A-003 fix.
    const apply = joinerApply();
    await apply(memberOp());
    await apply(settingsOp());
    expect((await getHiveMember(WS, HOME, 7, db.adminSql))?.githubUsername).toBe('octo');
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull();
  });

  it("the OWNER's hive-home harness REJECTS a member-log (slug-filter) — the no-cross-merge gate", () => {
    // The owner's hive-home harness (ownSlug=HOME, NOT a joiner → no rebind) must NOT admit
    // a member-log (origin-slug=MEMBER). Without this gate, since every harness registers
    // ALL projections and the apply dispatches purely on op.table, the member-log's
    // member-scoped ops (e.g. features) would materialise in the HIVE-HOME schema =
    // cross-merge pollution. The slug-filter rejects the log at admission, so those ops
    // never reach the hive-home apply at all.
    expect(announceSlugInScope(MEMBER, HOME, null)).toBe(false);
    // Scope-PRECISE, not a blanket cross-slug reject: the joiner's member (rebinds HOME)
    // still admits the hive-home log, and absent (legacy) still admits — so single-harness
    // + the existing two-hive federation are unchanged.
    expect(announceSlugInScope(HOME, MEMBER, HOME)).toBe(true);
    expect(announceSlugInScope(null, HOME, null)).toBe(true);
  });
});
