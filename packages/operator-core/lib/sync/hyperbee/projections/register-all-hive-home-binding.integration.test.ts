/**
 * A-003 (shared-pot-release-testing Brief I) — the JOINER projection-binding fix.
 *
 * A joiner boots a MEMBER harness; the pot_members / pot_settings ops it reads
 * off the shared Hive topic carry the HIVE-HOME slug (pot_home_slug / harness_slug
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
 * pot_members/pot_settings capture triggers + functions exist; assertions use the
 * RLS-bypass admin client.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { __resetA003DropWarnThrottleForTest } from './hive-members';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { generateEd25519KeypairDer } from '../../../identity/ed25519';
import { hiveKeychainId } from '../../../identity/hive-keypair';
import { insertHiveIfAbsent } from '../../../hive-store';
import { loadRevokedHivePubkeys, getHiveMember } from '../../../hive-membership-store';
import { unsafeFederatedPotScope } from '../../../federated-pot-scope';
import { getHiveSetting } from '../../../hive-settings-store';
import { buildHarnessProjectionApply } from './register-all';
import { announceSlugInScope } from '../read-admission';
import type { OpEnvelope } from '../op-envelope-types';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';

const WS = 'ws-a003';
// WI-6312: branded at the declaration — HOME is the owner-authored home slug the op carries.
const HOME = unsafeFederatedPotScope(
  'hive-home',
  'A-003 fixture: HOME is the owner-authored home slug the op carries',
); // the Hive home slug — the op carries this
// EI-18777176681958978: HOME is the OWNER-authored home slug the op carries, i.e. exactly the
// federated scope the readers require — this suite's whole subject is the write side binding
// to it.
/** @deprecated WI-6312: HOME is itself branded now; kept as an alias for existing call sites. */
const HOME_SCOPE = HOME;
/** A DIFFERENT hive's home slug — used only in negative assertions ("not blindly accepted").
 *  Certified because the assertion is precisely that nothing was written under it. */
const OTHER_HOME = unsafeFederatedPotScope('other-hive', 'negative assertion: asserts NO row exists under this scope');
const MEMBER = 'member-repo'; // the harness a joiner actually boots
const OWN_LOG = 'own-log-hex';
const REMOTE_LOG = 'remote-log-hex'; // != OWN_LOG → origin='remote' (a federated op)

function dev(pk: string): DeviceAttestationEntry {
  return { device_pubkey: pk, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' };
}

/** A federated (remote) pot_members put, exactly as the read-merge would hand it
 *  to the scoped apply (sourceLogKeyHex != ownLog → origin='remote', not skipped). */
function memberOp(over: Record<string, unknown> = {}, ts = 100): OpEnvelope {
  return {
    type: 'put',
    table: 'hive-members',
    hbKey: '7',
    value: {
      pot_home_slug: HOME,
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
// EI-18771324701216281: half this suite deliberately exercises the cross-Hive DROP path,
// which now emits a default-on warning — and `vitest-fail-on-console` fails any test that
// warns unexpectedly. Install one spy for the whole file so an EXPECTED drop-warning is not
// a failure, and let the tests that care assert against `warnSpy` directly.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await db.adminSql.unsafe(
    'TRUNCATE harness_shared.pot_members, harness_shared.pot_settings, harness_shared.pots, harness_shared.federation_refused_op_counters CASCADE',
  );
  warnSpy.mockRestore();
  // The roster-drop warning is rate-limited per (boundSlug, rowHome) over a 60s window, so
  // without this reset one test's drop SUPPRESSES a later test's identical one and the
  // assertion counts silently depend on file order.
  __resetA003DropWarnThrottleForTest();
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

describe('A-003 — pot_members/pot_settings reach a member-booted joiner', () => {
  it('RED (the bug): a member-slug apply with NO potHomeSlug drops the home-grained ops', async () => {
    await seedHive(HOME);
    const apply = memberBoundApply();
    await apply(memberOp());
    await apply(settingsOp());
    // The op is decoded + writeToPg is called, but the member-slug guard no-ops it.
    expect(await getHiveMember(WS, HOME, 7, db.adminSql)).toBeNull();
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).toBeNull();
    // EI-18771324701216281: this bug-reproducing drop is now AUDIBLE instead of silent.
    // The warning firing here, on the exact shape of the original bug, is the point.
    expect(warnSpy).toHaveBeenCalledTimes(1); // the members drop; settings has no such warning
    expect(String(warnSpy.mock.calls[0][0])).toContain('NOT evidence of health');
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
    expect([...(await loadRevokedHivePubkeys(WS, HOME_SCOPE, db.adminSql))]).toEqual([]);
    // With the fix, the revoked pubkey reaches the union boot.ts seeds/refreshes from.
    await db.adminSql.unsafe('TRUNCATE harness_shared.pot_members CASCADE');
    await joinerApply()(memberOp({ revoked_pubkeys: ['bad-pk'] }));
    expect([...(await loadRevokedHivePubkeys(WS, HOME_SCOPE, db.adminSql))]).toEqual(['bad-pk']);
  });

  it('surgical: the rebind still DEMUXES — an op for a DIFFERENT hive home is dropped', async () => {
    await seedHive(HOME);
    await seedHive('other-hive');
    const apply = joinerApply(); // bound to HOME
    await apply(memberOp({ pot_home_slug: 'other-hive', github_user_id: 9 }));
    await apply(settingsOp({ harness_slug: 'other-hive' }));
    expect(await getHiveMember(WS, HOME, 9, db.adminSql)).toBeNull(); // not under our home
    expect(await getHiveMember(WS, OTHER_HOME, 9, db.adminSql)).toBeNull(); // and not blindly accepted
    expect(await getHiveSetting(WS, 'other-hive', 'theme', db.adminSql)).toBeNull();
    // EI-18771324701216281: same drop, now audible (rate-limited, default-on).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("'other-hive'");
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

// WI-3734 — the OWNED-hive owner-side rebind + home-log exclusion. The owner's
// machine boots the home harness AND a member harness of its OWN hive; both join
// the same swarm topic. A PEER member's home-grained ops (pot_settings /
// pot_members) may only ever be READ by the owner's MEMBER scope (the pot-home
// scope can lack a replicator for that log — the WI-183 zombie), and before this
// fix the member scope demux-dropped them: B→A settings/members silently lost
// (the live-fed-gate content-matrix RED). The fix rebinds the owner-side member
// fold to the home slug — exactly like the joiner — but with a HOME-LOG
// EXCLUSION: ops sourced from the locally-booted home's OWN log are skipped
// (the home fold owns them; re-applying would double-apply the owner's rows as
// origin='remote' — the WI-2105/WI-559 fear that previously blocked this rebind).
describe('WI-3734 — owned-hive member rebind with home-log exclusion', () => {
  const HOME_LOG = 'home-own-log-hex'; // the locally-booted home harness's own log

  /** The owner-side member apply: rebound to HOME, excluding home-own-log ops.
   *  `homeLog=null` models the JOINED case (home never locally booted). */
  const ownedMemberApply = (homeLog: string | null = HOME_LOG) =>
    buildHarnessProjectionApply({
      workspaceId: WS,
      harnessSlug: MEMBER,
      sql: db.adminSql,
      ownLogKeyHex: OWN_LOG,
      potHomeSlug: HOME,
      resolveHomeLogKeyHex: () => homeLog,
    });

  it("GREEN (the fix): a PEER member's home-grained ops LAND on the owner-side member fold", async () => {
    await seedHive(HOME);
    const apply = ownedMemberApply();
    await apply(memberOp()); // sourced from REMOTE_LOG — a peer member's log
    await apply(settingsOp());
    expect((await getHiveMember(WS, HOME, 7, db.adminSql))?.githubUsername).toBe('octo');
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull();
  });

  it("HOME-LOG EXCLUSION: ops sourced from the locally-booted home's own log are SKIPPED", async () => {
    await seedHive(HOME);
    const apply = ownedMemberApply();
    await apply({ ...memberOp(), sourceLogKeyHex: HOME_LOG });
    await apply({ ...settingsOp(), sourceLogKeyHex: HOME_LOG });
    // The home fold owns home-log ops (CDC already landed them in home PG at
    // write time) — the member scope must not re-apply them as origin='remote'.
    expect(await getHiveMember(WS, HOME, 7, db.adminSql)).toBeNull();
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).toBeNull();
  });

  it('the exclusion guards DELETES too — a home-log del is skipped; a peer del still applies', async () => {
    await seedHive(HOME);
    const apply = ownedMemberApply();
    await apply(settingsOp()); // a peer put lands (ts=100)
    const del = (sourceLogKeyHex: string): OpEnvelope => ({
      type: 'del',
      table: 'hive-settings-by-key',
      hbKey: 'theme',
      ts: 200,
      writerPubkey: 'peer-hex',
      sourceLogKeyHex,
    });
    await apply(del(HOME_LOG));
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull(); // skipped
    await apply(del(REMOTE_LOG));
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).toBeNull(); // peer del applies
  });

  it('JOINED behavior preserved: resolver → null ⇒ home-log ops LAND (a joiner MUST apply them)', async () => {
    await seedHive(HOME);
    const apply = ownedMemberApply(null);
    await apply({ ...memberOp(), sourceLogKeyHex: HOME_LOG });
    await apply({ ...settingsOp(), sourceLogKeyHex: HOME_LOG });
    expect((await getHiveMember(WS, HOME, 7, db.adminSql))?.githubUsername).toBe('octo');
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull();
  });

  it("demux-mismatch is now COUNTED: a different hive-home's op drops AND bumps federation_refused_op_counters", async () => {
    await seedHive(HOME);
    await seedHive('other-hive');
    const apply = ownedMemberApply();
    await apply(settingsOp({ harness_slug: 'other-hive' }));
    // Still dropped by the projection's own harness_slug guard (surgical demux)…
    expect(await getHiveSetting(WS, 'other-hive', 'theme', db.adminSql)).toBeNull();
    // …but no longer silently: the WI-5136 observability counter records it.
    const rows = await db.adminSql`
      SELECT source_hive, table_tag, reason, count
      FROM harness_shared.federation_refused_op_counters
      WHERE workspace_id = ${WS} AND harness_slug = ${HOME} AND reason = 'demux-mismatch'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_tag).toBe('hive-settings-by-key');
    expect(rows[0].source_hive).toBe(REMOTE_LOG);
    expect(Number(rows[0].count)).toBe(1);
  });
});

// EI-18771324701216281 — the WI-5136 demux-drop counter was UNREACHABLE on JOINERS, the
// exact population the demux bug afflicts, so its emptiness read as HEALTH.
//
// Why it was unreachable: `hh()` in register-all wrapped the apply guard only when boot
// threaded `resolveHomeLogKeyHex`, and boot sets that ONLY for `memberHomeRebindSlug` —
// a block that returns undefined when `remote_hive === true`, i.e. for every joiner. So
// on a joiner the guard was the identity function and the counter could never bump. On
// WI-559 a zero drop-count was nearly read as "the fold is fine" while ~49,762 ops were
// being discarded.
//
// The guard's two duties are independent, and these tests pin BOTH halves of that split:
// the counter must now fire for a joiner (no resolver), and the home-log exclusion must
// stay OFF for one (a joiner MUST apply home-log ops — its home is remote, so excluding
// them would silently re-break the very roster this whole chain exists to deliver).
// Teeth: reverting `hh()` to `opts.resolveHomeLogKeyHex ? … : p` flips the first RED.
describe('EI-18771324701216281 — the demux-drop counter is reachable on a JOINER', () => {
  it('a joiner (potHomeSlug bound, NO resolver) COUNTS a demux-mismatch instead of dropping it silently', async () => {
    await seedHive(HOME);
    await seedHive('other-hive');
    const apply = joinerApply(); // exactly the shape boot.ts hands a joiner
    await apply(settingsOp({ harness_slug: 'other-hive' }));

    // Unchanged: the projection's own harness_slug guard still performs the actual drop.
    expect(await getHiveSetting(WS, 'other-hive', 'theme', db.adminSql)).toBeNull();

    // The fix: the drop is now OBSERVABLE on the population that actually suffers it.
    const rows = await db.adminSql`
      SELECT source_hive, table_tag, reason, count
      FROM harness_shared.federation_refused_op_counters
      WHERE workspace_id = ${WS} AND harness_slug = ${HOME} AND reason = 'demux-mismatch'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_tag).toBe('hive-settings-by-key');
    expect(rows[0].source_hive).toBe(REMOTE_LOG);
    expect(Number(rows[0].count)).toBe(1);
  });

  it('a joiner counts hive-members drops too — the table whose silent loss WAS WI-559', async () => {
    await seedHive(HOME);
    await seedHive('other-hive');
    await joinerApply()(memberOp({ pot_home_slug: 'other-hive', github_user_id: 9 }));
    expect(await getHiveMember(WS, OTHER_HOME, 9, db.adminSql)).toBeNull();
    const rows = await db.adminSql`
      SELECT table_tag, count FROM harness_shared.federation_refused_op_counters
      WHERE workspace_id = ${WS} AND harness_slug = ${HOME} AND reason = 'demux-mismatch'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_tag).toBe('hive-members');
    expect(Number(rows[0].count)).toBe(1);
  });

  it('NO REGRESSION: the home-log exclusion stays OFF for a joiner — home-log ops still LAND', async () => {
    await seedHive(HOME);
    // Broadening the wrap must NOT start excluding ops for a joiner: with no resolver
    // `homeLog` is null, so nothing is excluded. A joiner's home is remote and never
    // locally booted, so these ops are exactly the roster rows it MUST apply.
    const apply = joinerApply();
    await apply({ ...memberOp(), sourceLogKeyHex: 'any-home-log-hex' });
    await apply({ ...settingsOp(), sourceLogKeyHex: 'any-home-log-hex' });
    expect((await getHiveMember(WS, HOME, 7, db.adminSql))?.githubUsername).toBe('octo');
    expect(await getHiveSetting(WS, HOME, 'theme', db.adminSql)).not.toBeNull();
  });

  it('a matching-home op is never counted — the counter measures MISMATCH, not traffic', async () => {
    await seedHive(HOME);
    const apply = joinerApply();
    await apply(memberOp());
    await apply(settingsOp());
    const rows = await db.adminSql`
      SELECT count FROM harness_shared.federation_refused_op_counters
      WHERE workspace_id = ${WS} AND reason = 'demux-mismatch'`;
    expect(rows).toHaveLength(0);
  });
});
