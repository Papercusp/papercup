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
 * HOST IDENTITY GAP (flagged, not invented): `selfHostRef` /
 * `responderGithubUserId` / `executorDevice` / `sourceRepoPath` / `rootPath`
 * are THIS host's own configuration — grepped exhaustively (2026-07-18):
 * no production caller anywhere in the p2p stack resolves a "who am I"
 * identity today (`runForeignGitSyncTick`'s own `hostGithubUserId` opt
 * defaults to 0/unknown and NO caller supplies it either — the same gap,
 * already shipped that way). Rather than fabricate a hostRef/identity
 * convention here (which would either silently diverge from whatever an
 * owner configures in resource-allotments, or worse, silently match by
 * accident), this module takes them as an EXPLICIT, REQUIRED
 * `WorkIntakeHostIdentity` — resolved by the caller (the system-action
 * wiring in work-intake-action.ts reads it from the routine's
 * `triggerConfig`, matching this codebase's existing per-routine config
 * convention). The routine is therefore built + tested but NOT YET SEEDED
 * anywhere (mirrors WI-1937 item 3's sweep-orphaned-foreign-harnesses
 * precedent — its seeding also has no existing call site) — seeding requires
 * an owner-configured host identity, tracked as a named follow-up, not
 * guessed here.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listWorkOffers, type StoredWorkOffer } from './offer-store';
import { pullAndExecuteOffer, type PullAndExecuteContext, type PullAndExecuteResult } from './offer-pull-and-execute';
import type { PullEvaluationInput } from './standing-puller';
import type { P2pEffectiveTier } from './rollout-tiers';
import { resolveMaxRolloutTier } from './rollout-tiers';
import { readP2pSettings } from './settings';
import { PgFleetDirectory } from './fleet-directory';
import { listHiveMembers, loadRevokedHivePubkeys } from '../hive-membership-store';
import { currentGrantorEpoch } from './grant-store';
import { emitP2pReceipt, type EmitP2pReceiptResult } from './receipts';
import { getFlag } from '../flags';
import { FLAGS } from '@papercusp/flags';

/** The p2p WIRE-COMPATIBILITY version this host presents for C5 min-runtime
 *  gating — a protocol capability stamp, NOT the app build version. Bump only
 *  when this host's p2p wire handling changes in a way an offer's
 *  `minRuntimeVersion` should be able to require. */
export const P2P_HOST_RUNTIME_VERSION = '1.0.0';

/** THIS host's own configuration — required, never fabricated (see module doc). */
export interface WorkIntakeHostIdentity {
  /** P-205 metering `host_ref` — must match whatever the allotments admin
   *  configured for this host (host-availability.ts's HostAvailabilityContext). */
  hostRef: string;
  /** THIS host's own grantor identity — the H9 fence subject AND receipt author. */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  executorDevice: string;
  sourceRepoPath: string;
  rootPath: string;
  branch?: string;
  workspaceRoot?: string;
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
  /** Injection seams (tests). */
  listWorkOffers?: typeof listWorkOffers;
  emitReceipt?: (args: Parameters<typeof emitP2pReceipt>[0]) => Promise<EmitP2pReceiptResult>;
  pullAndExecute?: (
    input: PullEvaluationInput,
    ctx: PullAndExecuteContext,
  ) => Promise<PullAndExecuteResult>;
  log?: (m: string) => void;
  nowMs?: number;
}

/** Fail-closed: no attested member owns this device pubkey (or it was
 *  revoked) ⇒ null, same convention as foreign-git-sync's
 *  resolveOriginCommitIdentity (an unattested id must never be trusted). */
async function resolveAttestedGithubUserId(
  workspaceId: string,
  potHomeSlug: string,
  devicePubkey: string,
  sql?: Sql,
): Promise<number | null> {
  const [members, revoked] = await Promise.all([
    listHiveMembers(workspaceId, potHomeSlug, sql),
    loadRevokedHivePubkeys(workspaceId, potHomeSlug, sql),
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

  const [settingsLayers, flagEnabled] = await Promise.all([
    readP2pSettings(workspaceId, sql),
    getFlag(FLAGS.P2P, 'system').catch(() => false),
  ]);
  const maxRolloutTier: P2pEffectiveTier = resolveMaxRolloutTier({ flagEnabled });
  const directory = new PgFleetDirectory({ workspaceId, potSlug: potHomeSlug, sqlOverride: sql });

  for (const stored of offers) {
    const outcome = await processOneOffer(stored, {
      workspaceId,
      potHomeSlug,
      host,
      settings: settingsLayers.effective,
      maxRolloutTier,
      nowMs,
      directory,
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
  directory: PgFleetDirectory;
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
  if (!record || record.kind !== 'work' || !record.workOffer || !record.authorship) {
    ctx.log(`offer ${stored.offerId}: UNRESOLVABLE — pre-schema/junk or non-work record.`);
    return { offerId: stored.offerId, outcome: 'unresolvable', reason: 'malformed_or_non_work_record' };
  }
  const { workOffer: offer, authorship } = record;

  // V1 boundary (module doc): the store schema carries no designation column
  // today, so every offer is undesignated — evaluatePull is always called
  // with designation: null. Steal/H9 are structurally unreachable from here.
  const publisherSet = await ctx.directory.resolvePublisherSet({
    kind: 'fleet',
    ownerGithubUserId: stored.publisherGithubUserId,
    slug: stored.fleetSlug,
  });
  if (!publisherSet.ownerAnchored || !publisherSet.ownerSignatureValid) {
    return receiptSkip(
      ctx,
      stored,
      'publisher_set_unresolvable',
      `fleet '${stored.fleetSlug}' owner ${stored.publisherGithubUserId} publisher set failed to resolve (ownerAnchored=${publisherSet.ownerAnchored}, ownerSignatureValid=${publisherSet.ownerSignatureValid}).`,
    );
  }

  const [attestedGithubUserId, ownerHighWaterEpoch] = await Promise.all([
    resolveAttestedGithubUserId(ctx.workspaceId, ctx.potHomeSlug, authorship.devicePubkey, ctx.sql),
    currentGrantorEpoch(ctx.workspaceId, ctx.potHomeSlug, publisherSet.ownerGithubUserId, ctx.sql),
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
    hostAvailability: { remote: null, local: null }, // recomputed for real inside productionOfferExecutorDeps at claim time
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

  const execCtx: PullAndExecuteContext = {
    workspaceId: ctx.workspaceId,
    potSlug: ctx.potHomeSlug,
    responderGithubUserId: ctx.host.responderGithubUserId,
    responderDevicePubkey: ctx.host.responderDevicePubkey,
    executorDevice: ctx.host.executorDevice,
    hostRef: ctx.host.hostRef,
    sourceRepoPath: ctx.host.sourceRepoPath,
    rootPath: ctx.host.rootPath,
    branch: ctx.host.branch,
    workspaceRoot: ctx.host.workspaceRoot,
    canonicalTree: ctx.host.canonicalTree,
    actor: 'p2p:work-intake-tick',
  };

  const outcome = await ctx.pullExec(input, execCtx);
  if (outcome.outcome === 'skip') {
    return receiptSkip(ctx, stored, `puller:${outcome.decision.reason}`, outcome.decision.detail);
  }
  ctx.log(`offer ${stored.offerId}: EXECUTED (outcome=${outcome.decision.outcome}, resultOutcome=${outcome.execute.outcome}).`);
  await ctx.emitReceipt({
    workspaceId: ctx.workspaceId,
    potSlug: ctx.potHomeSlug,
    kind: 'refusal', // P2P_RECEIPT_KINDS is currently ['refusal','excused-breach'] only —
    // an executed claim has no receipt KIND of its own yet; a 'claimed'/'executed'
    // kind is real product surface, not this ticket's scope (D-004 boundary) —
    // flagged as a follow-up rather than mis-typing this as a refusal receipt.
    offerId: stored.offerId,
    action: 'work-offer:intake-executed-marker',
    refusal: { code: 'not-a-refusal-informational-only', detail: 'see module TODO: no executed-claim receipt kind exists yet.' },
    requester: { kind: 'fleet', ref: stored.fleetSlug, githubUserId: stored.publisherGithubUserId },
    responderGithubUserId: ctx.host.responderGithubUserId,
    responderDevicePubkey: ctx.host.responderDevicePubkey,
    actor: 'p2p:work-intake-tick',
  }).catch(() => undefined); // best-effort informational marker only — never let this fail the tick
  return { offerId: stored.offerId, outcome: 'executed' };
}
