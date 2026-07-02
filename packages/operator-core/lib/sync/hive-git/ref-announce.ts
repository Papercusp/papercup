/**
 * hive-git/ref-announce.ts — G-3 ref announcements (Phase 7,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-027; D-010).
 *
 * The announcement rail: how a peer LEARNS a device's namespace advanced,
 * without polling. After a device publishes new heads and rebuilds its sigrefs
 * (G-4, sigrefs.ts), it signs a tiny `{device, sigrefsOid, version}` envelope
 * and fires it hive-wide as a P-009 federated event
 * (`events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload }`).
 * Every member awaits the same key; on wake it runs the receiver pipeline here:
 *
 *   accept (sig + membership + monotonic version + budget)
 *     → compare announced sigrefsOid vs the local mirror  → noop when current
 *     → fetchPeerNamespace (G-2)                          → mirror the heads
 *     → acceptFetchedSigrefs + reconcileFetchedHeads (G-4/G-4b) → trust verdict
 *
 * WHY an envelope at all (and not just "something changed, go fetch"): the
 * `sigrefs_oid` lets a receiver skip the fetch entirely when it already mirrors
 * that exact snapshot (dedup across relays/replays), and the mirrored `version`
 * fences stale/replayed announcements BEFORE any transport work — the same
 * no-side-table watermark idiom as G-4b (the watermark IS the version of the
 * sigrefs currently stored in the local mirror for that device).
 *
 * BUDGET CAP (the P-003 idiom, applied to fetch storms): a per-device
 * fixed-window budget bounds how many announcement-driven fetches one device
 * can trigger. Over-budget announcements are DEFERRED, not errors — the
 * periodic anti-entropy sweep (integrator cadence) reconverges; the cap only
 * bounds the burst. The budget is charged ONLY for otherwise-acceptable fresh
 * announcements, so replays/stale ones can never starve a device's budget.
 *
 * The signed payload + pure acceptance follow staging-advance.ts exactly
 * (fixed field order, domain-separated signing bytes). Pure over ed25519.ts +
 * storage.ts's RunGit seam + a caller-provided `openStream` (the Protomux
 * sub-stream to the announcing peer) — unit-tests without git, integration-
 * tests against real bare repos over a socketpair.
 */

import type { Duplex } from 'node:stream';
import { verifyEd25519 } from '../../identity/ed25519';
import { type RunGit, defaultRunGit, readNamespaceRef } from './storage';
import { fetchPeerNamespace } from './fetch-transport';
import {
  SIGREFS_REF,
  type SignedSigrefs,
  acceptFetchedSigrefs,
  readSigrefs,
  reconcileFetchedHeads,
} from './sigrefs';

/** Wire schema version for the ref-announcement envelope. */
export const REF_ANNOUNCE_SCHEMA_VERSION = 1;

/** Domain-separation tag (the staging-advance idiom) — a ref-announce signature
 *  can never be replayed as a sigrefs blob / staging advance / handoff token. */
export const REF_ANNOUNCE_SIG_DOMAIN = 'papercusp-hive-git-ref-announce-v1';

/** The hive-wide rendezvous key (P-009 rail): senders
 *  `events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload: SignedRefAnnouncement }`,
 *  every member holds an events:await on the same key. */
export const REF_ANNOUNCE_EVENT_KEY = 'hive-git:ref-announce';

/** The signed announcement payload (fixed field order = the signing order). */
export interface RefAnnouncePayload {
  /** Wire schema version. */
  v: number;
  /** The announcing device's raw-32 Ed25519 pubkey (base64) — bound into the sig. */
  device_pubkey: string;
  /** The blob sha its `refs/rad/sigrefs` points at — the snapshot being advertised. */
  sigrefs_oid: string;
  /** The sigrefs monotonic version (G-4b counter) — pre-transport fencing. */
  version: number;
  /** Announce time (epoch ms) — audit/freshness only, NOT part of the ordering. */
  ts: number;
}

export interface SignedRefAnnouncement extends RefAnnouncePayload {
  /** base64 Ed25519 signature over refAnnounceSigningBytes(payload). */
  sig: string;
}

const OID_RE = /^[0-9a-f]{40,64}$/;

function isRefAnnouncePayload(x: unknown): x is RefAnnouncePayload {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.v === 'number' &&
    typeof s.device_pubkey === 'string' &&
    typeof s.sigrefs_oid === 'string' &&
    OID_RE.test(s.sigrefs_oid) &&
    typeof s.version === 'number' &&
    Number.isInteger(s.version) &&
    s.version >= 0 &&
    typeof s.ts === 'number'
  );
}

export function isSignedRefAnnouncement(x: unknown): x is SignedRefAnnouncement {
  return isRefAnnouncePayload(x) && typeof (x as unknown as Record<string, unknown>).sig === 'string';
}

/** Canonical signing bytes: domain tag + fixed field order, `sig` excluded. */
export function refAnnounceSigningBytes(payload: RefAnnouncePayload): Buffer {
  const ordered = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    sigrefs_oid: payload.sigrefs_oid,
    version: payload.version,
    ts: payload.ts,
  };
  return Buffer.from(`${REF_ANNOUNCE_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/**
 * Build + sign THIS device's announcement from its currently-stored sigrefs in
 * `repoPath` (blob oid + version). Call AFTER buildSigrefs — throws when the
 * device has no sigrefs yet (an announcement without a snapshot is meaningless).
 * `sign` is the device signer seam (prod: `bytes => signWithDeviceKey(...)`).
 */
export async function buildRefAnnouncement(
  repoPath: string,
  devicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: { nowMs: number; runGit?: RunGit },
): Promise<SignedRefAnnouncement> {
  const runGit = opts.runGit ?? defaultRunGit;
  const sigrefsOid = await readNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, runGit);
  const stored = await readSigrefs(repoPath, devicePubkeyBase64, runGit);
  if (!sigrefsOid || !stored) {
    throw new Error('hive-git: buildRefAnnouncement requires a stored sigrefs (run buildSigrefs first)');
  }
  const payload: RefAnnouncePayload = {
    v: REF_ANNOUNCE_SCHEMA_VERSION,
    device_pubkey: devicePubkeyBase64,
    sigrefs_oid: sigrefsOid,
    version: stored.version,
    ts: opts.nowMs,
  };
  const sig = (await sign(refAnnounceSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

/**
 * Verify a signed announcement. When `expectedDevicePubkeyBase64` is given the
 * embedded device must equal it; otherwise the signature is verified against
 * the EMBEDDED key and the caller MUST separately gate that device (hive
 * membership). Never throws.
 */
export function verifyRefAnnouncement(
  signed: SignedRefAnnouncement,
  expectedDevicePubkeyBase64?: string,
): boolean {
  if (!isSignedRefAnnouncement(signed)) return false;
  if (expectedDevicePubkeyBase64 !== undefined && signed.device_pubkey !== expectedDevicePubkeyBase64) {
    return false;
  }
  try {
    return verifyEd25519(
      refAnnounceSigningBytes(signed),
      signed.device_pubkey,
      Buffer.from(signed.sig, 'base64'),
    );
  } catch {
    return false;
  }
}

// ── Budget cap ────────────────────────────────────────────────────────────────

export interface AnnounceBudgetConfig {
  /** Fixed-window length. */
  windowMs: number;
  /** Max announcement-driven fetches per device per window. */
  maxPerWindow: number;
}

/** Default: at most 12 announcement-driven fetches per device per minute — a
 *  busy autocommit cadence fits; a flood defers to the anti-entropy sweep. */
export const DEFAULT_ANNOUNCE_BUDGET: AnnounceBudgetConfig = { windowMs: 60_000, maxPerWindow: 12 };

/** Per-device budget window state (caller keeps a Map<device, state>). */
export interface AnnounceBudgetState {
  windowStartMs: number;
  count: number;
}

/**
 * PURE fixed-window take: returns whether a token was available and the next
 * state (unchanged when denied). `state` null ⇒ first sighting of the device.
 */
export function takeAnnounceBudget(
  state: AnnounceBudgetState | null,
  nowMs: number,
  cfg: AnnounceBudgetConfig = DEFAULT_ANNOUNCE_BUDGET,
): { ok: boolean; state: AnnounceBudgetState } {
  if (!state || nowMs - state.windowStartMs >= cfg.windowMs) {
    return { ok: true, state: { windowStartMs: nowMs, count: 1 } };
  }
  if (state.count >= cfg.maxPerWindow) return { ok: false, state };
  return { ok: true, state: { windowStartMs: state.windowStartMs, count: state.count + 1 } };
}

// ── Acceptance ────────────────────────────────────────────────────────────────

export type RefAnnounceRejectReason =
  | 'malformed'
  | 'self'
  | 'wrong-device'
  | 'bad-signature'
  | 'stale-version'
  | 'over-budget';

export type RefAnnounceAcceptance =
  | { ok: true; budgetState: AnnounceBudgetState | null }
  | { ok: false; reason: RefAnnounceRejectReason; budgetState: AnnounceBudgetState | null };

export interface AcceptRefAnnouncementOpts {
  /** Our own device — its announcements are ignored ('self'). */
  selfDevice?: string;
  /** Devices allowed to announce (current hive members). Omitted ⇒ signature
   *  self-consistency only — the caller MUST gate the device itself. */
  allowedDevices?: readonly string[];
  /**
   * The G-4b watermark: the `version` of the sigrefs currently stored in OUR
   * mirror for the announcing device (null when we hold none). An announcement
   * whose version is ≤ this is stale — we already mirror that state or newer.
   */
  priorVersion: number | null;
  /** Budget leg (omit to skip capping — e.g. the anti-entropy sweep path). */
  budget?: {
    state: AnnounceBudgetState | null;
    nowMs: number;
    config?: AnnounceBudgetConfig;
  };
}

/**
 * PURE acceptance for an inbound announcement: shape → self-filter → membership
 * gate → signature → version fencing → budget. The budget is charged LAST, so
 * only announcements that would otherwise trigger a fetch consume it. The
 * caller persists `budgetState` back into its per-device map either way.
 */
export function acceptRefAnnouncement(
  incoming: SignedRefAnnouncement,
  opts: AcceptRefAnnouncementOpts,
): RefAnnounceAcceptance {
  const currentBudget = opts.budget?.state ?? null;
  if (!isSignedRefAnnouncement(incoming)) return { ok: false, reason: 'malformed', budgetState: currentBudget };
  if (opts.selfDevice !== undefined && incoming.device_pubkey === opts.selfDevice) {
    return { ok: false, reason: 'self', budgetState: currentBudget };
  }
  if (opts.allowedDevices !== undefined && !opts.allowedDevices.includes(incoming.device_pubkey)) {
    return { ok: false, reason: 'wrong-device', budgetState: currentBudget };
  }
  if (!verifyRefAnnouncement(incoming)) return { ok: false, reason: 'bad-signature', budgetState: currentBudget };
  if (opts.priorVersion !== null && incoming.version <= opts.priorVersion) {
    return { ok: false, reason: 'stale-version', budgetState: currentBudget };
  }
  if (opts.budget) {
    const take = takeAnnounceBudget(opts.budget.state, opts.budget.nowMs, opts.budget.config);
    if (!take.ok) return { ok: false, reason: 'over-budget', budgetState: take.state };
    return { ok: true, budgetState: take.state };
  }
  return { ok: true, budgetState: currentBudget };
}

/** PURE fetch decision: skip transport when we already mirror the advertised
 *  snapshot (`localSigrefsOid` = the blob our mirror's sigrefs ref points at,
 *  null when we hold none for that device). */
export function shouldFetchOnAnnouncement(
  incoming: SignedRefAnnouncement,
  localSigrefsOid: string | null,
): boolean {
  return incoming.sigrefs_oid !== localSigrefsOid;
}

// ── Receiver driver ───────────────────────────────────────────────────────────

export type RefAnnounceHandleResult =
  | { action: 'rejected'; reason: RefAnnounceRejectReason; budgetState: AnnounceBudgetState | null }
  | { action: 'noop'; budgetState: AnnounceBudgetState | null }
  | { action: 'fetch-failed'; stderr: string; budgetState: AnnounceBudgetState | null }
  | {
      action: 'fetched';
      /** G-4/G-4b verdict on the fetched snapshot. When NOT accepted the caller
       *  (integrator) must treat the whole namespace as untrusted — the mirror
       *  refs are present but unverified. */
      sigrefs:
        | { accepted: true; snapshot: SignedSigrefs }
        | { accepted: false; reason: 'bad-signature' | 'wrong-device' | 'rollback' | 'malformed' | 'missing' };
      /** Heads whose fetched sha diverges from the signed snapshot (empty ⇒
       *  every head is exactly what the device signed). */
      mismatches: { ref: string; expected: string; actual: string | null }[];
      budgetState: AnnounceBudgetState | null;
    };

export interface HandleRefAnnouncementOpts {
  selfDevice?: string;
  allowedDevices?: readonly string[];
  /** Per-device budget window (pass the device's current state; persist the
   *  returned one). Omit to skip capping. */
  budget?: { state: AnnounceBudgetState | null; config?: AnnounceBudgetConfig };
  nowMs: number;
  /** Open the transport sub-stream to the ANNOUNCING peer (Protomux channel on
   *  the live hive-swarm connection; a socketpair in tests). Only called when a
   *  fetch is actually needed. */
  openStream: () => Promise<Duplex> | Duplex;
  timeoutMs?: number;
  runGit?: RunGit;
}

/**
 * Full receiver pipeline for one inbound announcement against the local mirror
 * `repoPath`: pure acceptance (watermark read from the mirror), sigrefs-oid
 * dedup, G-2 namespace fetch from the announcing peer, then the G-4/G-4b
 * verdict + head reconciliation on what arrived. Never throws on transport or
 * verification failures — every leg reports through the result union.
 *
 * NOTE the watermark is captured BEFORE the fetch: the forced namespace
 * refspec overwrites the mirrored sigrefs ref, so post-fetch the mirror holds
 * the INCOMING snapshot — `acceptFetchedSigrefs` fences it against the
 * pre-fetch version. A rejected snapshot leaves the namespace mirrored but
 * UNTRUSTED; the integrator only merges heads that reconcile against an
 * accepted sigrefs (G-5 contract), so an unaccepted fetch cannot advance
 * staging.
 */
export async function handleRefAnnouncement(
  repoPath: string,
  incoming: SignedRefAnnouncement,
  opts: HandleRefAnnouncementOpts,
): Promise<RefAnnounceHandleResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const device = incoming.device_pubkey;
  const prior = isSignedRefAnnouncement(incoming) ? await readSigrefs(repoPath, device, runGit) : null;
  const priorVersion = prior?.version ?? null;
  const localOid = isSignedRefAnnouncement(incoming)
    ? await readNamespaceRef(repoPath, device, SIGREFS_REF, runGit)
    : null;

  const acceptance = acceptRefAnnouncement(incoming, {
    selfDevice: opts.selfDevice,
    allowedDevices: opts.allowedDevices,
    priorVersion,
    budget: opts.budget ? { state: opts.budget.state, nowMs: opts.nowMs, config: opts.budget.config } : undefined,
  });
  if (!acceptance.ok) return { action: 'rejected', reason: acceptance.reason, budgetState: acceptance.budgetState };
  if (!shouldFetchOnAnnouncement(incoming, localOid)) {
    return { action: 'noop', budgetState: acceptance.budgetState };
  }

  const duplex = await opts.openStream();
  const res = await fetchPeerNamespace(repoPath, duplex, device, { timeoutMs: opts.timeoutMs });
  if (res.code !== 0) {
    return { action: 'fetch-failed', stderr: res.stderr, budgetState: acceptance.budgetState };
  }

  const fetched = await readSigrefs(repoPath, device, runGit);
  if (!fetched) {
    return {
      action: 'fetched',
      sigrefs: { accepted: false, reason: 'missing' },
      mismatches: [],
      budgetState: acceptance.budgetState,
    };
  }
  const verdict = acceptFetchedSigrefs(fetched, device, priorVersion);
  const mismatches = await reconcileFetchedHeads(repoPath, device, fetched, runGit);
  return {
    action: 'fetched',
    sigrefs: verdict.ok ? { accepted: true, snapshot: fetched } : { accepted: false, reason: verdict.reason },
    mismatches,
    budgetState: acceptance.budgetState,
  };
}
