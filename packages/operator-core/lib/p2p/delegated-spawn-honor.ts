/**
 * p2p/delegated-spawn-honor.ts — the P-009 HONOR path: a contributing host (B)
 * receives a fleet owner's signed 'spawn_request' offer-store record and, if —
 * and only if — every gate passes, spawns bounded members from its own
 * delegated seats onto the owner's fleet
 * (agent-allocation-framework-2026-07-03 P-009, entry gate P-008/D-006).
 *
 * DRIVE: projection-driven, not polled (the WI-1940 reaper pattern) — the
 * work-offers projection calls {@link honorSpawnRequestFromProjection} after a
 * REMOTE-origin open 'spawn_request' row lands (sync catch-up covers an offline
 * host: the hook fires whenever the row finally applies). There is NO
 * re-trigger on a later ACCEPT_DELEGATED_SEATS flip — a request that arrived
 * while the gate was off just sits un-disposed and EXPIRES; the owner
 * re-requests after the host opts in (the freshness fence is what makes a late
 * flip safe: a stale request must never fire a surprise spawn).
 *
 * GATES, in order (all fail-closed):
 *   1. ACCEPT_DELEGATED_SEATS (owner-authority, default-OFF) — gate off is a
 *      SILENT skip (no disposition, no receipt: the host owner simply hasn't
 *      opted in; nothing here is refused *yet*).
 *   2. Target match — the request names a seat-offer THIS machine published:
 *      re-derive seatOfferId over the host's own agent_slot allotments with its
 *      own device pubkey (the M19-local account string never crossed the wire;
 *      only its hash contribution did). Someone else's request → silent skip.
 *   3. Freshness — requestedAtMs within the honor window (default 60 min).
 *   4. Seat availability — resolveSeatLaunch's cap math; consumeSeatAtBoot
 *      re-enforces atomically at each member's bootstrap regardless.
 *   5. Atomic claim — local_disposition 'honoring' (per-offer variant, WHERE
 *      NULL) so two concurrent hooks can never double-spawn.
 * Refusals past gate 2 are LOUD: a host-local disposition ('refused:<code>')
 * + a federated p2p_receipts refusal (D-004 no-silent-drops) so the owner
 * learns why. Success needs no receipt: the members' federated presence
 * joining the owner's fleet IS the signal.
 *
 * The spawn itself reuses the launch-from-seats machinery verbatim
 * (memberLaunchCommand --seat/--fleet/--plan → bootstrap-su fleet stamp +
 * consumeSeatAtBoot), via dynamic import so this module — which the sync
 * projection layer imports — never drags the agent-tools graph into the
 * replication path. WI-1408 gotcha handled: bootstrap's fleet JOIN fail-softs
 * without a local agent_fleets row, and the registry is machine-local, so the
 * honor path ensures the row exists (createFleetIfAbsent, leader = the
 * requesting owner) before spawning.
 */

import type { Sql } from 'postgres';
import { hostAcceptsDelegatedSeats } from './accept-delegated-seats';
import { resolveUsageActor } from '../harness/usage-actor';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { listResourceAllotments } from './resource-allotments';
import {
  resolveSeatLaunch,
  seatAvailabilityForFleet,
  seatLaunchOpts,
  slotFromAllotment,
  type SeatSlot,
} from '../fleet/seat-accounting';
import { setLocalOfferDispositionForOffer } from './offer-store';
import {
  parseWorkOfferRecordJson,
  type SpawnRequestPayload,
  type WorkOfferStoreRecord,
} from './offer-store-schema';
import { seatOfferId } from './offer-store-publish';
import { emitP2pReceipt } from './receipts';
import type { OrgSql } from '../work-items';

/** How long a spawn-request stays honorable after its publisher-clock stamp. */
export const SPAWN_REQUEST_HONOR_WINDOW_MS = 60 * 60_000;
/** Tolerated forward clock skew before a future-dated request is refused. */
export const SPAWN_REQUEST_CLOCK_SKEW_MS = 10 * 60_000;

/** D-003 sentinel mirrored from offer-store-publish (the offer-id hash side). */
const AUTO_ACCOUNT = 'AUTO';

export type SpawnRequestEvaluation =
  | { ok: true; slot: SeatSlot; payload: SpawnRequestPayload }
  | {
      ok: false;
      code: 'not_spawn_request' | 'not_open' | 'not_target' | 'expired' | 'seat_ref_unknown';
      detail: string;
      /** null ⇒ silent skip (not ours to judge); a string ⇒ dispose + receipt. */
      disposition: string | null;
    };

/**
 * PURE: is this request addressed to THIS host, fresh, and matched to one of
 * its delegated slot templates? No I/O — the caller supplies the host's own
 * identity + its active agent_slot slots for the record's fleet.
 */
export function evaluateSpawnRequestTarget(opts: {
  record: WorkOfferStoreRecord;
  selfGithubUserId: number;
  selfDevicePubkey: string;
  /** THIS host's active agent_slot slots for record.fleetSlug. */
  slots: readonly SeatSlot[];
  nowMs: number;
  honorWindowMs?: number;
  clockSkewMs?: number;
}): SpawnRequestEvaluation {
  const { record } = opts;
  if (record.kind !== 'spawn_request' || !record.spawnRequest) {
    return { ok: false, code: 'not_spawn_request', detail: `kind=${record.kind}`, disposition: null };
  }
  const payload = record.spawnRequest;
  if (record.status !== 'open') {
    return { ok: false, code: 'not_open', detail: `status=${record.status}`, disposition: null };
  }
  if (payload.targetPublisherGithubUserId !== opts.selfGithubUserId) {
    return {
      ok: false,
      code: 'not_target',
      detail: `targets publisher ${payload.targetPublisherGithubUserId}, self=${opts.selfGithubUserId}`,
      disposition: null,
    };
  }
  const windowMs = opts.honorWindowMs ?? SPAWN_REQUEST_HONOR_WINDOW_MS;
  const skewMs = opts.clockSkewMs ?? SPAWN_REQUEST_CLOCK_SKEW_MS;
  const age = opts.nowMs - payload.requestedAtMs;
  if (age > windowMs || age < -skewMs) {
    return {
      ok: false,
      code: 'expired',
      detail:
        age > windowMs
          ? `request is ${Math.round(age / 60_000)} min old (window ${Math.round(windowMs / 60_000)} min) — the owner must re-request`
          : `request is dated ${Math.round(-age / 60_000)} min in the future (skew cap ${Math.round(skewMs / 60_000)} min)`,
      disposition: 'refused:expired',
    };
  }
  // The M19 re-derivation: the wire named a seat-offer id; only THIS machine
  // can recompute it (the hash needs the local account string + device pubkey).
  const slot = opts.slots.find(
    (s) =>
      seatOfferId({
        fleetSlug: record.fleetSlug,
        model: s.model,
        effort: s.effort,
        account: s.account || AUTO_ACCOUNT,
        devicePubkey: opts.selfDevicePubkey,
      }) === payload.targetOfferId,
  );
  if (!slot) {
    return {
      ok: false,
      code: 'seat_ref_unknown',
      detail: `no active agent_slot delegation on this machine matches seat-offer ${payload.targetOfferId} for fleet ${record.fleetSlug} (revoked since, or a different device)`,
      disposition: 'refused:seat_ref_unknown',
    };
  }
  return { ok: true, slot, payload };
}

export interface SpawnMembersRequest {
  workspaceId: string;
  /** The hive HOME slug — the harness the members boot into. */
  potHomeSlug: string;
  fleetSlug: string;
  planSlug: string;
  count: number;
  /** The consumed slot template ref ('<model>:<effort>:<account>'). */
  seatRef: string;
  /** psu pins derived from the slot (seatLaunchOpts). */
  launch: { model: string; account: string };
  /** Raw brief text from the request (composed under the baseline), or null. */
  launchContext: string | null;
  /** The requesting owner — becomes the ensured local fleet row's leader. */
  requesterOwnerId: string;
  /** Labels for the spawned terminals. */
  requestOfferId: string;
}

export interface SpawnMembersResult {
  opened: number;
  failed: number;
  firstError: string | null;
}

export type DelegatedSpawnHonorOutcome =
  | { outcome: 'gate_off' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'already_claimed' }
  | { outcome: 'refused'; code: string }
  | { outcome: 'honored'; opened: number; failed: number };

/** DI seams so unit tests run without PG/keychain/desktop. */
export interface DelegatedSpawnHonorDeps {
  hostAccepts?: typeof hostAcceptsDelegatedSeats;
  resolveActor?: typeof resolveUsageActor;
  resolveDevicePubkey?: (githubUserId: number) => Promise<string>;
  listAllotments?: typeof listResourceAllotments;
  availabilityForFleet?: typeof seatAvailabilityForFleet;
  setDisposition?: typeof setLocalOfferDispositionForOffer;
  spawnMembers?: (req: SpawnMembersRequest) => Promise<SpawnMembersResult>;
  emitReceipt?: typeof emitP2pReceipt;
  nowMs?: () => number;
  honorWindowMs?: number;
}

async function defaultResolveDevicePubkey(githubUserId: number): Promise<string> {
  const keypair = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(githubUserId));
  return keypair.pubkeyBase64;
}

/**
 * The default spawner — the launch-from-seats machinery, loaded lazily so the
 * projection layer's import of THIS module stays light (the agent-tools graph
 * only loads when a spawn is actually happening).
 */
async function defaultSpawnMembers(req: SpawnMembersRequest): Promise<SpawnMembersResult> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { papercuspPathForWorkspace } = await import('../papercusp-root');
  const { createFleetIfAbsent } = await import('../agent-fleets-store');
  const { buildConsoleEnvelope } = await import('../console-launcher');
  const { spawnConsole } = await import('../console-spawn');
  const { memberLaunchCommand, defaultMemberAccountRouting, composeMemberLaunchContext, isOmpLocalModel } = await import(
    '../agent-tools/fleet_registry/launch-on-plan'
  );

  // WI-1408: bootstrap's fleet JOIN fail-softs without a local agent_fleets row
  // and the registry is machine-local — ensure it (idempotent), leader = the
  // requesting owner (their presence federates, so the leadership is real).
  await createFleetIfAbsent({
    workspaceId: req.workspaceId,
    fleetSlug: req.fleetSlug,
    title: req.fleetSlug,
    owner: req.requesterOwnerId,
    leaderOwnerId: req.requesterOwnerId,
  });

  // Compose the member brief under the universal baseline (launch-on-plan's
  // exact flow); a compose failure falls back to no launch-context file.
  let launchContextPath: string | undefined;
  try {
    const composed = composeMemberLaunchContext({
      fleetSlug: req.fleetSlug,
      plan: req.planSlug,
      count: req.count,
      customBriefText: req.launchContext,
    });
    const ctxDir = join(papercuspPathForWorkspace(req.workspaceId), 'launch-context');
    mkdirSync(ctxDir, { recursive: true });
    const ctxPath = join(ctxDir, `fleet-${req.fleetSlug}-delegated-launch-context.md`);
    writeFileSync(ctxPath, composed, 'utf8');
    launchContextPath = ctxPath;
  } catch {
    launchContextPath = undefined;
  }

  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  const operatorBaseUrl = fromEnv
    ? fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '')
    : `http://localhost:${process.env.PAPERCUSP_HONO_PORT?.trim() || '3070'}`;
  const base = await buildConsoleEnvelope({
    workspaceId: req.workspaceId,
    slug: req.potHomeSlug,
    operatorBaseUrl,
    skipMcpJson: true,
  });
  const command = memberLaunchCommand({
    fleetSlug: req.fleetSlug,
    agent: isOmpLocalModel(req.launch.model) ? 'omp' : 'claude',
    harness: req.potHomeSlug,
    plan: req.planSlug,
    model: req.launch.model,
    // Same cross-platform-member-credential-inheritance default as fleet:launch-on-plan: an
    // un-pinned member honored on a macOS host routes via the gateway (inherits the Keychain
    // login) instead of booting logged out. Gated on THIS (honoring) host's platform.
    account: defaultMemberAccountRouting(req.launch.account ?? undefined),
    seat: req.seatRef,
    launchContext: launchContextPath,
  });
  const results = await Promise.all(
    Array.from({ length: req.count }, (_v, i) =>
      spawnConsole({
        envelope: { ...base, greetingCmd: command, cwd: base.cwd },
        label: `${req.fleetSlug} · delegated ${i + 1}/${req.count} (${req.requestOfferId})`,
        writeMcpJson: false,
        scheme: null,
      }),
    ),
  );
  let opened = 0;
  let firstError: string | null = null;
  for (const r of results) {
    if (r.status === 'ok') opened += 1;
    else if (firstError === null) firstError = r.error;
  }
  return { opened, failed: req.count - opened, firstError };
}

/**
 * The projection hook (WI-1940 pattern): evaluate + honor ONE landed
 * spawn-request row. Never throws — the caller is the replication apply path
 * and a spawn hiccup must never unwind a landed write.
 */
export async function honorSpawnRequestFromProjection(
  args: {
    workspaceId: string;
    potHomeSlug: string;
    row: { publisher_github_user_id: number; offer_id: string; record_json: string; fleet_slug: string };
    sql?: Sql;
  },
  deps: DelegatedSpawnHonorDeps = {},
): Promise<DelegatedSpawnHonorOutcome> {
  const hostAccepts = deps.hostAccepts ?? hostAcceptsDelegatedSeats;
  const resolveActor = deps.resolveActor ?? resolveUsageActor;
  const resolveDevicePubkey = deps.resolveDevicePubkey ?? defaultResolveDevicePubkey;
  const listAllotments = deps.listAllotments ?? listResourceAllotments;
  const availabilityForFleet = deps.availabilityForFleet ?? seatAvailabilityForFleet;
  const setDisposition = deps.setDisposition ?? setLocalOfferDispositionForOffer;
  const spawnMembers = deps.spawnMembers ?? defaultSpawnMembers;
  const emitReceipt = deps.emitReceipt ?? emitP2pReceipt;
  const nowMs = deps.nowMs ?? Date.now;

  const record = parseWorkOfferRecordJson(args.row.record_json);
  if (!record) return { outcome: 'skipped', reason: 'unparseable_record' };
  const publisher = args.row.publisher_github_user_id;

  // Gate 1 FIRST and silent: a host that hasn't opted in does no work at all.
  if (!(await hostAccepts())) return { outcome: 'gate_off' };

  const actor = await resolveActor();
  if (!actor) return { outcome: 'skipped', reason: 'no_github_identity' };
  let devicePubkey: string;
  try {
    devicePubkey = await resolveDevicePubkey(actor.githubUserId);
  } catch (e) {
    return { outcome: 'skipped', reason: `device_key_unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const allotments = await listAllotments(
    { workspaceId: args.workspaceId, fleetSlug: args.row.fleet_slug },
    args.sql as OrgSql | undefined,
  );
  const slots = allotments.map(slotFromAllotment).filter((s): s is SeatSlot => s != null);

  const evaluated = evaluateSpawnRequestTarget({
    record,
    selfGithubUserId: actor.githubUserId,
    selfDevicePubkey: devicePubkey,
    slots,
    nowMs: nowMs(),
    honorWindowMs: deps.honorWindowMs,
  });

  const refuse = async (code: string, detail: string, disposition: string): Promise<DelegatedSpawnHonorOutcome> => {
    const claimed = await setDisposition(
      args.workspaceId,
      args.potHomeSlug,
      publisher,
      args.row.offer_id,
      disposition,
      undefined,
      args.sql,
    );
    if (!claimed) return { outcome: 'already_claimed' };
    await emitReceipt({
      workspaceId: args.workspaceId,
      potSlug: args.potHomeSlug,
      kind: 'refusal',
      offerId: args.row.offer_id,
      action: 'delegated-seat:spawn',
      refusal: { code, detail },
      requester: {
        kind: 'session',
        ref: record.spawnRequest?.requesterOwnerId ?? null,
        githubUserId: publisher,
      },
      responderGithubUserId: actor.githubUserId,
      responderDevicePubkey: devicePubkey,
      actor: 'delegated-spawn-honor',
    });
    return { outcome: 'refused', code };
  };

  if (!evaluated.ok) {
    if (evaluated.disposition === null) return { outcome: 'skipped', reason: evaluated.code };
    return refuse(evaluated.code, evaluated.detail, evaluated.disposition);
  }
  const { slot, payload } = evaluated;

  // Gate 4: cap pre-check (consumeSeatAtBoot re-enforces atomically at boot).
  const availability = await availabilityForFleet(
    { workspaceId: args.workspaceId, fleetSlug: record.fleetSlug },
    args.sql as OrgSql | undefined,
  );
  const resolution = resolveSeatLaunch({ availability, count: payload.count, seatRef: slot.ref });
  if (!resolution.ok) {
    return refuse(resolution.refusal.code, resolution.refusal.detail, `refused:${resolution.refusal.code}`);
  }

  // Gate 5: the atomic claim — exactly one hook invocation spawns.
  const claimed = await setDisposition(
    args.workspaceId,
    args.potHomeSlug,
    publisher,
    args.row.offer_id,
    'honoring',
    undefined,
    args.sql,
  );
  if (!claimed) return { outcome: 'already_claimed' };

  let spawn: SpawnMembersResult;
  try {
    spawn = await spawnMembers({
      workspaceId: args.workspaceId,
      potHomeSlug: args.potHomeSlug,
      fleetSlug: record.fleetSlug,
      planSlug: payload.planSlug,
      count: payload.count,
      seatRef: slot.ref,
      launch: resolution.launch,
      launchContext: payload.launchContext,
      requesterOwnerId: payload.requesterOwnerId,
      requestOfferId: args.row.offer_id,
    });
  } catch (e) {
    spawn = { opened: 0, failed: payload.count, firstError: e instanceof Error ? e.message : String(e) };
  }

  if (spawn.opened === 0) {
    await setDisposition(
      args.workspaceId,
      args.potHomeSlug,
      publisher,
      args.row.offer_id,
      'refused:spawn_failed',
      { expect: 'honoring' },
      args.sql,
    );
    await emitReceipt({
      workspaceId: args.workspaceId,
      potSlug: args.potHomeSlug,
      kind: 'refusal',
      offerId: args.row.offer_id,
      action: 'delegated-seat:spawn',
      refusal: {
        code: 'spawn_failed',
        detail: `all ${payload.count} member spawn(s) failed on the honoring host${spawn.firstError ? `: ${spawn.firstError}` : ''}`,
      },
      requester: { kind: 'session', ref: payload.requesterOwnerId, githubUserId: publisher },
      responderGithubUserId: actor.githubUserId,
      responderDevicePubkey: devicePubkey,
      actor: 'delegated-spawn-honor',
    });
    return { outcome: 'refused', code: 'spawn_failed' };
  }

  await setDisposition(
    args.workspaceId,
    args.potHomeSlug,
    publisher,
    args.row.offer_id,
    'honored',
    { expect: 'honoring' },
    args.sql,
  );
  return { outcome: 'honored', opened: spawn.opened, failed: spawn.failed };
}
