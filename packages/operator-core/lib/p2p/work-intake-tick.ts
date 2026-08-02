/**
 * p2p/work-intake-tick.ts — the P-406 (D-004) MINIMAL PRODUCTION INTAKE LOOP:
 * the missing IO edge standing-puller.ts's module doc calls "the receiver's
 * IO layer (the actual standing-claim runner, a P-016 supervisor-owned
 * claim-spec)" — nothing in this codebase decoded live stored offers and
 * ticked `pullAndExecuteOffer` (WI-3629) until this file.
 *
 * SCOPE (D-004 ruling, p2p-public-release-remaining-lanes-2026-07-16 P-406):
 * existing seams only — offer-store (listWorkOffers) → evaluatePull gate
 * order → pullAndExecuteOffer — armed solely by the existing admission stack
 * (kill-switch → per-fleet opt-in → window, all inside evaluatePull/
 * resolveForeignWorkAdmission), so it ships LIVE-BUT-CONSENT-GATED: it does
 * nothing until an owner opts in (consent semantics, not a dark flag). Loud
 * structured receipts on every decision (emitP2pReceipt, mirrors
 * foreign-git-sync-action.ts's PARKED-with-receipt convention).
 *
 * V1 BOUNDARY (held deliberately, per D-004's "if this forces NEW
 * worker-seat/seat-semantics design decisions, STOP and escalate"): this tick
 * ONLY evaluates OPEN offers — WorkOfferStoreRecord carries NO `designation`
 * field today (offer-store-schema.ts), so every stored offer is, in fact,
 * undesignated; the X12 steal path (reliability-weighting across HOSTS,
 * "betterCandidateExists") is real seat-semantics design with no production
 * resolver anywhere in this codebase and is NOT built here. `evaluatePull` is
 * always called with `designation: null`, so its H9 execution-epoch
 * revalidation branch (`if (input.designation)`) and the steal branch are
 * both structurally unreachable from this caller — the `steal`/high-water
 * fields on `PullEvaluationInput` are inert placeholders for that reason, not
 * a guess at real values.
 *
 * HOST IDENTITY: `selfHostRef` / `responderGithubUserId` / `executorDevice` /
 * `sourceRepoPath` / `foreignWorkRoot` are THIS host's own configuration.
 * This module never fabricates them — it takes them as an EXPLICIT, REQUIRED
 * `WorkIntakeHostIdentity` resolved by the caller (the system-action wiring in
 * work-intake-action.ts reads them from the routine's `triggerConfig`,
 * matching this codebase's per-routine config convention).
 *
 * ⚠ The identity gap this doc used to describe as OPEN was CLOSED by WI-5327
 * (p2p/ensure-host-routines.ts), which resolves the whole set at boot and
 * seeds the routine. The stale "built + tested but NOT YET SEEDED anywhere /
 * no production caller resolves a who-am-I identity" text was removed under
 * WI-6680 — it had been false since 2026-07-18 and led readers (twice, on
 * record) to conclude the seeding gap was unsolved when it is not.
 *
 * What remains genuinely open is narrower and is tracked on WI-6680: on a
 * PACKAGED install `projectDirForSlug` resolves no registered project dir, so
 * `sourceRepoPath` (the repo a foreign clone is made FROM) has no answer and
 * the routine is skipped there. Identity and paths are otherwise resolved.
 */
import type { Sql } from 'postgres';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { listWorkOffers, type StoredWorkOffer } from './offer-store';
import { pullAndExecuteOffer, type PullAndExecuteContext, type PullAndExecuteResult } from './offer-pull-and-execute';
import type { PullEvaluationInput } from './standing-puller';
import type { P2pEffectiveTier } from './rollout-tiers';
import { resolveMaxRolloutTier } from './rollout-tiers';
import { readP2pSettings } from './settings';
import { PgFleetDirectory } from './fleet-directory';
// EI-18777176681958978: the tick is handed a LOCAL pot handle
// (work-intake-action.ts: `potHomeSlugForHarness(...) ?? ctx.installSlug`), so both reads
// must resolve the OWNER-authored scope the pot_members projection writes under. Reading
// the local handle on a joiner returns an empty roster AND an empty revocation set — the
// latter meaning a revoked device's offer would be trusted.
import {
  listHiveMembersForLocalPot,
  loadRevokedHivePubkeysForLocalPot,
} from '../federated-pot-scope';
import { currentGrantorEpoch } from './grant-store';
import { hostAvailability as buildHostAvailability } from './host-availability';
import { emitP2pReceipt, type EmitP2pReceiptResult } from './receipts';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/** The p2p WIRE-COMPATIBILITY version this host presents for C5 min-runtime
 *  gating — a protocol capability stamp, NOT the app build version. Bump only
 *  when this host's p2p wire handling changes in a way an offer's
 *  `minRuntimeVersion` should be able to require. */
export const P2P_HOST_RUNTIME_VERSION = '1.0.0';

/**
 * WI-6680: an offerId is REMOTE-AUTHORED (it arrives on a peer's published
 * record), so it is never pasted into a filesystem path as-is — a crafted
 * `../../..` would place the foreign root outside the intended base, and the
 * Q1 invariant would NOT catch it (Q1 only refuses roots INSIDE the host
 * trees; it says nothing about an escape to some other part of the disk).
 * Collapse to a conservative charset and refuse anything left empty.
 */
export function foreignRootSegmentForOffer(offerId: string): string | null {
  const safe = offerId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return safe.length > 0 ? safe.slice(0, 128) : null;
}

/** THIS host's own configuration — required, never fabricated (see module doc). */
export interface WorkIntakeHostIdentity {
  /** P-205 metering `host_ref` — must match whatever the allotments admin
   *  configured for this host (host-availability.ts's HostAvailabilityContext). */
  hostRef: string;
  /** THIS host's own grantor identity — the H9 fence subject AND receipt author. */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  executorDevice: string;
  /** The host repo to clone FROM (this host's canonical tree or a bare mirror). */
  sourceRepoPath: string;
  /**
   * WI-6680: the per-host BASE directory for foreign work — NOT one offer's
   * root. Each offer gets its own `<foreignWorkRoot>/<offerId>` subtree below
   * (the clone then lands at `<root>/repo`), because `p2p_foreign_workspaces`
   * has a UNIQUE index on `root_path`: one static root shared by every offer
   * registers offer #1 and then refuses every later one with `conflict`.
   * Must sit OUTSIDE `workspaceRoot` and `canonicalTree` (the Q1 invariant).
   */
  foreignWorkRoot: string;
  branch?: string;
  /** Q1 scope: the host tree root foreign work must stay OUTSIDE of. */
  workspaceRoot?: string;
  /** Q1 scope: the canonical tree foreign work must stay OUTSIDE of. */
  canonicalTree?: string;
}

export interface WorkIntakeTickResult {
  offers: Array<{
    offerId: string;
    outcome: 'executed' | 'skip' | 'unresolvable';
    reason?: string;
  }>;
}

export interface RunWorkIntakeTickOpts {
  sql?: Sql;
  host: WorkIntakeHostIdentity;
  /** Injection seams (tests) — every real IO edge this tick touches is
   *  overridable, mirroring runForeignGitSyncTick's convention, so the
   *  decision logic is unit-testable without a live PG. */
  listWorkOffers?: typeof listWorkOffers;
  emitReceipt?: (args: Parameters<typeof emitP2pReceipt>[0]) => Promise<EmitP2pReceiptResult>;
  pullAndExecute?: (
    input: PullEvaluationInput,
    ctx: PullAndExecuteContext,
  ) => Promise<PullAndExecuteResult>;
  resolvePublisherSet?: PgFleetDirectory['resolvePublisherSet'];
  resolveAttestedGithubUserId?: typeof resolveAttestedGithubUserId;
  currentGrantorEpoch?: typeof currentGrantorEpoch;
  hostAvailability?: typeof buildHostAvailability;
  /** The settings read is a real IO edge too (two `operator_state` layer reads).
   *  It was the one edge missing from this seam set, which left the unit test
   *  reading the developer's live DB — silently, until the no-real-PG rail
   *  (EI-19311807188719573) made it loud. */
  readP2pSettings?: typeof readP2pSettings;
  log?: (m: string) => void;
  nowMs?: number;
}

/** Fail-closed: no attested member owns this device pubkey (or it was
 *  revoked) ⇒ null, same convention as foreign-git-sync's
 *  resolveOriginCommitIdentity (an unattested id must never be trusted). */
export async function resolveAttestedGithubUserId(
  workspaceId: string,
  potHomeSlug: string,
  devicePubkey: string,
  sql?: Sql,
): Promise<number | null> {
  const [members, revoked] = await Promise.all([
    listHiveMembersForLocalPot(workspaceId, potHomeSlug, sql),
    loadRevokedHivePubkeysForLocalPot(workspaceId, potHomeSlug, sql),
  ]);
  if (revoked.has(devicePubkey)) return null;
  const member = members.find((m) => m.deviceAttestations?.some((a) => a?.device_pubkey === devicePubkey));
  return member ? member.githubUserId : null;
}

/**
 * One `system:p2p-work-intake` tick: list open 'work' offers in `potHomeSlug`,
 * evaluate + (on a won claim) execute each via the existing WI-3629 seam.
 * Errors/refusals on one offer never stall the others (same loud-separation
 * discipline as foreign-git-sync). Never throws.
 */
export async function runWorkIntakeTick(
  workspaceId: string,
  potHomeSlug: string,
  opts: RunWorkIntakeTickOpts,
): Promise<WorkIntakeTickResult> {
  const log = opts.log ?? ((m: string) => console.log(`[p2p-work-intake] ${m}`));
  const list = opts.listWorkOffers ?? listWorkOffers;
  const emitReceipt = opts.emitReceipt ?? emitP2pReceipt;
  const pullExec = opts.pullAndExecute ?? pullAndExecuteOffer;
  const sql = opts.sql ?? getOrgPg().sql;
  const nowMs = opts.nowMs ?? Date.now();
  const { host } = opts;

  const result: WorkIntakeTickResult = { offers: [] };

  const offers = await list(workspaceId, potHomeSlug, { kind: 'work', status: 'open' }, sql);
  if (!offers.length) return result;

  const readSettings = opts.readP2pSettings ?? readP2pSettings;
  const [settingsLayers, flagEnabled] = await Promise.all([
    readSettings(workspaceId, sql),
    getFlag(FLAGS.P2P, 'system').catch(() => false),
  ]);
  const maxRolloutTier: P2pEffectiveTier = resolveMaxRolloutTier({ flagEnabled });
  const directory = new PgFleetDirectory({ workspaceId, potSlug: potHomeSlug, sqlOverride: sql });
  const resolvePubSet = opts.resolvePublisherSet ?? directory.resolvePublisherSet.bind(directory);
  const resolveAttested = opts.resolveAttestedGithubUserId ?? resolveAttestedGithubUserId;
  const epochReader = opts.currentGrantorEpoch ?? currentGrantorEpoch;
  const availabilityReader = opts.hostAvailability ?? buildHostAvailability;

  for (const stored of offers) {
    const outcome = await processOneOffer(stored, {
      workspaceId,
      potHomeSlug,
      host,
      settings: settingsLayers.effective,
      maxRolloutTier,
      nowMs,
      resolvePublisherSet: resolvePubSet,
      resolveAttestedGithubUserId: resolveAttested,
      currentGrantorEpoch: epochReader,
      hostAvailability: availabilityReader,
      sql,
      emitReceipt,
      pullExec,
      log,
    });
    result.offers.push(outcome);
  }
  return result;
}

interface ProcessCtx {
  workspaceId: string;
  potHomeSlug: string;
  host: WorkIntakeHostIdentity;
  settings: Awaited<ReturnType<typeof readP2pSettings>>['effective'];
  maxRolloutTier: P2pEffectiveTier;
  nowMs: number;
  resolvePublisherSet: PgFleetDirectory['resolvePublisherSet'];
  resolveAttestedGithubUserId: typeof resolveAttestedGithubUserId;
  currentGrantorEpoch: typeof currentGrantorEpoch;
  hostAvailability: typeof buildHostAvailability;
  sql: Sql;
  emitReceipt: (args: Parameters<typeof emitP2pReceipt>[0]) => Promise<EmitP2pReceiptResult>;
  pullExec: (input: PullEvaluationInput, ctx: PullAndExecuteContext) => Promise<PullAndExecuteResult>;
  log: (m: string) => void;
}

async function receiptSkip(
  ctx: ProcessCtx,
  stored: StoredWorkOffer,
  code: string,
  detail: string,
): Promise<{ offerId: string; outcome: 'skip'; reason: string }> {
  await ctx.emitReceipt({
    workspaceId: ctx.workspaceId,
    potSlug: ctx.potHomeSlug,
    kind: 'refusal',
    offerId: stored.offerId,
    action: 'work-offer:intake',
    refusal: { code, detail },
    requester: { kind: 'fleet', ref: stored.fleetSlug, githubUserId: stored.publisherGithubUserId },
    responderGithubUserId: ctx.host.responderGithubUserId,
    responderDevicePubkey: ctx.host.responderDevicePubkey,
    actor: 'p2p:work-intake-tick',
  });
  ctx.log(`offer ${stored.offerId}: SKIP ${code} — ${detail}`);
  return { offerId: stored.offerId, outcome: 'skip', reason: code };
}

async function processOneOffer(
  stored: StoredWorkOffer,
  ctx: ProcessCtx,
): Promise<{ offerId: string; outcome: 'executed' | 'skip' | 'unresolvable'; reason?: string }> {
  const record = stored.record;
  if (!record || record.kind !== 'work' || !record.workOffer || !record.authorship || !stored.fleetSlug) {
    ctx.log(`offer ${stored.offerId}: UNRESOLVABLE — pre-schema/junk or non-work record.`);
    return { offerId: stored.offerId, outcome: 'unresolvable', reason: 'malformed_or_non_work_record' };
  }
  const { workOffer: offer, authorship } = record;
  const fleetSlug = stored.fleetSlug;

  // V1 boundary (module doc): the store schema carries no designation column
  // today, so every offer is undesignated — evaluatePull is always called
  // with designation: null. Steal/H9 are structurally unreachable from here.
  const publisherSet = await ctx.resolvePublisherSet({
    kind: 'fleet',
    ownerGithubUserId: stored.publisherGithubUserId,
    slug: fleetSlug,
  });
  if (!publisherSet.ownerAnchored || !publisherSet.ownerSignatureValid) {
    return receiptSkip(
      ctx,
      stored,
      'publisher_set_unresolvable',
      `fleet '${stored.fleetSlug}' owner ${stored.publisherGithubUserId} publisher set failed to resolve (ownerAnchored=${publisherSet.ownerAnchored}, ownerSignatureValid=${publisherSet.ownerSignatureValid}).`,
    );
  }

  const [attestedGithubUserId, ownerHighWaterEpoch, hostAvail] = await Promise.all([
    ctx.resolveAttestedGithubUserId(ctx.workspaceId, ctx.potHomeSlug, authorship.devicePubkey, ctx.sql),
    ctx.currentGrantorEpoch(ctx.workspaceId, ctx.potHomeSlug, publisherSet.ownerGithubUserId, ctx.sql),
    ctx.hostAvailability({ workspaceId: ctx.workspaceId, hostRef: ctx.host.hostRef }, offer.fleetSlug, ctx.sql),
  ]);

  const input: PullEvaluationInput = {
    selfHostRef: ctx.host.hostRef,
    settings: ctx.settings,
    nowMs: ctx.nowMs,
    maxRolloutTier: ctx.maxRolloutTier,
    authorship: {
      offer,
      authorship,
      attestedGithubUserId,
      publisherSet,
      ownerHighWaterEpoch,
      host: { runtimeVersion: P2P_HOST_RUNTIME_VERSION, capabilities: [] },
    },
    hostAvailability: hostAvail, // D-007: re-read again at spawn time inside productionOfferExecutorDeps — never a stale snapshot
    designation: null, // V1 boundary — see module doc.
    hostHighWaterEpoch: 0, // inert — never read (designation is always null here)
    hostHighWaterSeq: 0, // inert — never read (designation is always null here)
    steal: {
      // inert — evaluatePull's steal branch is unreachable when designation is null
      t2StaleMs: 0,
      selfReliability: 0,
      minReliabilityToSteal: 1,
      publisherExcludedHosts: [],
      betterCandidateExists: true,
    },
  };

  const rootSegment = foreignRootSegmentForOffer(stored.offerId);
  if (!rootSegment) {
    return receiptSkip(
      ctx,
      stored,
      'unsafe_offer_id',
      `offer id '${stored.offerId}' has no filesystem-safe form — refusing to derive a foreign work root from it.`,
    );
  }

  const execCtx: PullAndExecuteContext = {
    workspaceId: ctx.workspaceId,
    potSlug: ctx.potHomeSlug,
    responderGithubUserId: ctx.host.responderGithubUserId,
    responderDevicePubkey: ctx.host.responderDevicePubkey,
    executorDevice: ctx.host.executorDevice,
    hostRef: ctx.host.hostRef,
    sourceRepoPath: ctx.host.sourceRepoPath,
    // WI-6680: one root PER OFFER. `root_path` is UNIQUE in mig 467, so
    // passing the shared base straight through would register the first offer
    // and refuse every subsequent one with a `conflict` refusal.
    rootPath: join(ctx.host.foreignWorkRoot, rootSegment),
    branch: ctx.host.branch,
    workspaceRoot: ctx.host.workspaceRoot,
    canonicalTree: ctx.host.canonicalTree,
    actor: 'p2p:work-intake-tick',
  };

  const outcome = await ctx.pullExec(input, execCtx);
  if (outcome.outcome === 'skip') {
    return receiptSkip(ctx, stored, `puller:${outcome.decision.reason}`, outcome.decision.detail);
  }
  // No receipt here on the WON path: executeClaimedOffer (offer-executor.ts)
  // already receipts every step of its own pipeline fail-closed (P-004, M21) —
  // emitting a second one here would be redundant.
  //
  // UPDATE (EI-19333624101736074): the success-receipt kind this comment once
  // flagged as "real product surface — flagged, not invented" now EXISTS —
  // P2P_RECEIPT_KINDS carries 'honored', emitted on the delegated-spawn honored
  // path. It is deliberately NOT emitted here, for the redundancy reason above
  // and not for want of a truthful kind. If this path ever stops being covered
  // by executeClaimedOffer's own receipts, emit kind='honored' rather than
  // reusing a refusal kind.
  ctx.log(
    `offer ${stored.offerId}: EXECUTED (outcome=${outcome.decision.outcome}, ok=${outcome.execute.ok}${
      outcome.execute.ok ? '' : `, refusal=${outcome.execute.refusal.code}`
    }).`,
  );
  return { offerId: stored.offerId, outcome: 'executed' };
}
