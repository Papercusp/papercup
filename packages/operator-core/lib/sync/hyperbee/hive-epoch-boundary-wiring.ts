/**
 * hive-epoch-boundary-wiring — the P-004 boundary TRIGGER wiring for the read-plane
 * re-key (shared-hive-rekey-2026-06-19, K's lane). Turns a real membership/visibility
 * boundary (member-remove via revokeHiveContributor / go-private via setHiveListing)
 * into a read cut-off:
 *
 *   resolve the flag-gated crypto → compute the REMAINING members (all hive_members
 *   device pubkeys minus the cut-off set) → advanceEpochAndWrap (the pure P2 core) →
 *   putWrappedKeys (P-005 store; the mig-316 capture trigger federates them via the
 *   hive-epoch-keys projection).
 *
 * The cut-off member is simply absent from `remaining`, so it gets no wrapped row → it
 * replicates future ciphertext it can never unwrap = the C-001 read cut.
 *
 * DARK behind `papercusp-hive-rekey`: enabled=false ⇒ no-op (today's PG-only revoke).
 * Every PG/crypto seam is injectable for hermetic unit tests (no PG, no real crypto).
 */
import type { Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import { advanceEpochAndWrap, type WrappedEpochKeyRow } from './hive-epoch-boundary';
import { resolveHiveEpochCrypto } from './hive-epoch-serving';
import { putWrappedKeys } from './hive-epoch-keys-store';
import { getHiveEpoch } from './hive-epoch-state';
import { listHiveMembers } from '../../hive-membership-store';
import { loadHivePubkey } from '../../identity/hive-keypair';

/**
 * Is the read-plane re-key (papercusp-hive-rekey) on? The SHARED flag resolver for the
 * boundary trigger (produce side, here) AND the apply-side decrypt-gate (`rekeyOn`).
 * Default flag = false (the whole re-key is dark until cutover).
 */
export async function isHiveRekeyEnabled(): Promise<boolean> {
  return getFlag(FLAGS.HIVE_REKEY, 'system');
}

export interface BoundaryRekeyResult {
  /** True when the re-key actually ran (flag on) — the boundary became a live read-cut. */
  applied: boolean;
  /** The advanced epoch (when applied). */
  newEpoch?: number;
  /** # of remaining members the new epoch key was wrapped + persisted to (when applied). */
  distributed?: number;
  /**
   * When NOT applied, WHICH silent early-return fired (WI-280 diagnostic, ee7e9's gap):
   * 'flag-disabled' (re-key resolved off in this context), 'no-fresh-members'
   * (newMemberPubkeys empty after dedup/filter), or 'no-author' (loadHivePubkey null — not
   * the owner box). The grant returns 0 keys with NO throw in all three, so 328af's
   * throw-only rekey_grant_failed event never sees them; the admit call-site reads this to
   * emit a queryable rekey_grant_skipped event so a 0-keys run NAMES the cause.
   */
  reason?: 'flag-disabled' | 'no-fresh-members' | 'no-author';
}

export interface BoundaryRekeySeams {
  resolveCrypto?: (enabled: boolean) => HiveEpochCrypto | Promise<HiveEpochCrypto>;
  loadAllMemberPubkeys?: (ws: string, slug: string, sql?: Sql) => Promise<string[]>;
  resolveAuthorPubkey?: (ws: string, slug: string) => Promise<string | null>;
  persistWrappedKeys?: (
    ws: string,
    slug: string,
    epoch: number,
    rows: readonly WrappedEpochKeyRow[],
    author: string | null,
    sql?: Sql,
  ) => Promise<number>;
  advanceAndWrap?: typeof advanceEpochAndWrap;
}

/** Every device pubkey currently bound to the hive (deduped across every member). */
export async function loadAllHiveMemberDevicePubkeys(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<string[]> {
  const members = await listHiveMembers(workspaceId, hiveHomeSlug, sql);
  const out = new Set<string>();
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
        out.add(a.device_pubkey);
      }
    }
  }
  return [...out];
}

/**
 * Advance the hive epoch on a boundary + distribute the new key to the REMAINING members.
 *
 * @param enabled the `papercusp-hive-rekey` flag, resolved at the call site
 *   (isHiveRekeyEnabled). false ⇒ no-op, returns { applied: false }.
 * @param cutOffPubkeys device pubkeys to EXCLUDE from the new epoch (the removed member /
 *   go-private exclusions). They get no wrapped row → cannot decrypt post-boundary content.
 *
 * hiveId for deriveEpochKey / the OpAAD is the hive HOME slug — the federated hive
 * identity every peer agrees on (a joiner resolves it via the A-003 hiveHomeProjectionSlug
 * binding), so mint here ↔ encrypt/decrypt on any peer use an identical key id.
 */
export async function advanceEpochOnHiveBoundary(
  opts: {
    workspaceId: string;
    hiveHomeSlug: string;
    enabled: boolean;
    cutOffPubkeys?: readonly string[];
    sql?: Sql;
  },
  seams: BoundaryRekeySeams = {},
): Promise<BoundaryRekeyResult> {
  if (!opts.enabled) return { applied: false };
  const {
    resolveCrypto = resolveHiveEpochCrypto,
    loadAllMemberPubkeys = loadAllHiveMemberDevicePubkeys,
    resolveAuthorPubkey = loadHivePubkey,
    persistWrappedKeys = putWrappedKeys,
    advanceAndWrap = advanceEpochAndWrap,
  } = seams;

  const crypto = await resolveCrypto(true);
  const all = await loadAllMemberPubkeys(opts.workspaceId, opts.hiveHomeSlug, opts.sql);
  const cut = new Set(opts.cutOffPubkeys ?? []);
  const remaining = all.filter((pk) => pk && !cut.has(pk));

  const { newEpoch, wrapped } = await advanceAndWrap(
    crypto,
    { workspaceId: opts.workspaceId, hiveHomeSlug: opts.hiveHomeSlug, hiveId: opts.hiveHomeSlug },
    remaining,
    opts.sql,
  );

  const author = await resolveAuthorPubkey(opts.workspaceId, opts.hiveHomeSlug);
  const distributed = await persistWrappedKeys(
    opts.workspaceId,
    opts.hiveHomeSlug,
    newEpoch,
    wrapped,
    author,
    opts.sql,
  );
  return { applied: true, newEpoch, distributed };
}

/**
 * Member-ADD key distribution (shared-hive-rekey-2026-06-19, su-ee7e9) — the complement of
 * the boundary trigger that closes the join-time gap. When the OWNER recognizes a NEW
 * member, wrap EVERY epoch key [0..current] to that member's device(s) so they can decrypt
 * ALL existing hive content (the project: features/plans/etc.), WITHOUT advancing the epoch
 * (adding a member cuts no one off).
 *
 * Why [0..current], not current-only (c2a63's v1 CORRECTNESS call, 2026-06-19): content is
 * encrypted ONCE at write under the then-current epoch + is NEVER re-encrypted on advance,
 * so a current-epoch-only joiner holds the ciphertext for all history but can decrypt ZERO
 * pre-join content. The shared-hive is a COLLABORATION substrate — a new member joins to
 * read the EXISTING project. C-001 is unaffected (removal still advances + withholds the NEW
 * key, cutting FUTURE reads); barring a member from history = a future forward-secrecy
 * policy (ed300 + owner). Owner-only (`deriveEpochKey` needs the hive key). Flag-gated;
 * idempotent per (epoch, member). Cost bounded — epochs advance only on a membership change.
 */
export async function grantEpochKeysToMembers(
  opts: {
    workspaceId: string;
    hiveHomeSlug: string;
    enabled: boolean;
    /** the new member's device pubkeys (base64) to grant the current epoch key. */
    newMemberPubkeys: readonly string[];
    sql?: Sql;
  },
  seams: Pick<BoundaryRekeySeams, 'resolveCrypto' | 'resolveAuthorPubkey' | 'persistWrappedKeys'> & {
    getCurrentEpoch?: (ws: string, slug: string, sql?: Sql) => Promise<number>;
  } = {},
): Promise<BoundaryRekeyResult> {
  if (!opts.enabled) return { applied: false, reason: 'flag-disabled' };
  const fresh = [...new Set(opts.newMemberPubkeys.filter((pk) => pk))];
  if (fresh.length === 0) return { applied: false, reason: 'no-fresh-members' };
  const {
    resolveCrypto = resolveHiveEpochCrypto,
    resolveAuthorPubkey = loadHivePubkey,
    persistWrappedKeys = putWrappedKeys,
    getCurrentEpoch = getHiveEpoch,
  } = seams;

  // Owner-only SELF-GATE: only the box holding the hive key can derive epoch keys.
  // resolveAuthorPubkey (loadHivePubkey) is null/empty on a non-owner box, so the helper
  // no-ops there — safe to call from the admit path on EVERY peer (328af's DUAL hook:
  // upsertHiveMember owner-side + the open-mode admittedIdentities.set, which fires on every
  // box) without the caller re-checking owner-ness.
  const author = await resolveAuthorPubkey(opts.workspaceId, opts.hiveHomeSlug);
  if (!author) return { applied: false, reason: 'no-author' };

  const crypto = await resolveCrypto(true);
  const current = await getCurrentEpoch(opts.workspaceId, opts.hiveHomeSlug, opts.sql);

  // Grant EVERY epoch key [0..current] — content is encrypted-once per epoch + never
  // re-encrypted on advance, so a joiner needs all prior keys to read existing content
  // (c2a63's v1 correctness call). Owner derives each; the member unwraps to read history.
  let distributed = 0;
  for (let epoch = 0; epoch <= current; epoch++) {
    const key = await crypto.deriveEpochKey(opts.hiveHomeSlug, epoch);
    const wrapped: WrappedEpochKeyRow[] = [];
    for (const pk of fresh) {
      wrapped.push({ memberDevicePubkey: pk, wrappedKey: await crypto.wrapKeyToMember(key, pk) });
    }
    distributed += await persistWrappedKeys(opts.workspaceId, opts.hiveHomeSlug, epoch, wrapped, author, opts.sql);
  }
  return { applied: true, newEpoch: current, distributed };
}
