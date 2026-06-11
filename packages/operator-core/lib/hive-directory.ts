/**
 * hive-directory.ts — the P2P HIVE DIRECTORY service (p2p-hive-directory-2026-06-06 P-003).
 *
 * On substrate boot a peer JOINS the well-known directory topic
 * (derive-hive-topic.ts), VERIFIES inbound hive announces (signature + GitHub
 * attestation), and keeps the discovered set in memory with a PG-cached copy for
 * offline listing. It also ANNOUNCES the peer's own public/invite hives onto the
 * topic, re-announcing on a timer + on metadata change.
 *
 * DISCOVERY UX, NOT A TRUST SURFACE (D-002): a listed hive is best-effort gossip.
 * The directory renders only VERIFIED announces (valid Ed25519 signature +
 * GitHub attestation — D-001 verified-only posture, the spam floor) and supports
 * a LOCAL mute/hide list, but JOINING a listed hive still runs the full
 * admission/attestation flow elsewhere — a listing grants nothing.
 *
 * Architecture: the service core (verify → dedupe → maintain set → build/announce
 * → mute → re-announce) is pure over INJECTED seams — the swarm transport
 * (`broadcast`), the device signer (`sign`), the channel-2 attestation check
 * (`verifyAttestation`), and the PG cache (`loadCache`/`saveCache`). This mirrors
 * the established inject-the-IO-seam pattern (announce.ts's injected signer,
 * change-feed-deps, watchdog collectors) so the logic unit-tests without a swarm,
 * a keychain, or PG. Production wires the seams at boot (see `wireHiveDirectory`).
 *
 * Storage: PG is a CACHE for offline listing, never the transport (DB-is-not-a-
 * transport) — the live source is the topic; the cache only answers "what did I
 * last see" before the swarm reconnects.
 */

import {
  deriveDirectoryTopic,
  deriveInviteTopic,
  hiveTopicAsHex,
} from './sync/hyperbee/derive-hive-topic';
import {
  buildHiveAnnounce,
  verifyHiveAnnounce,
  type HiveAnnounceBody,
  type HiveVisibility,
  type SignedHiveAnnounce,
} from './sync/hyperbee/hive-announce';
import {
  HIVE_UNLIST_KIND,
  buildHiveUnlist,
  verifyHiveUnlist,
  type SignedHiveUnlist,
} from './sync/hyperbee/hive-unlist';

export { isHiveUnlistFrame, type SignedHiveUnlist } from './sync/hyperbee/hive-unlist';

// Re-export the topic derivation so capability probes (e.g. the p2p-perf-tier3
// announce-volume forward hook's `hiveDirectoryReady`) can detect the substrate
// by importing from one place.
export { deriveDirectoryTopic, deriveInviteTopic } from './sync/hyperbee/derive-hive-topic';
export type { SignedHiveAnnounce, HiveVisibility } from './sync/hyperbee/hive-announce';

/** A hive discovered on the directory topic (verified), as listed to UI surfaces. */
export interface DiscoveredHive {
  hiveId: string;
  title: string;
  description: string;
  ownerGithubLogin: string;
  ownerGithubUserId: number;
  ownerDevicePubkey: string;
  /**
   * Raw 32-byte base64 Ed25519 HIVE-identity pubkey — the cross-Hive DIAL ADDRESS
   * (cross-hive-boundary-2026-06-08 P-006). Present only when the announcing Hive
   * carried its identity; absent ⇒ the Hive is browseable but not cross-Hive-addressable.
   */
  hivePubkey?: string;
  /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
  memberTopics: string[];
  /** Full join links per member harness, when the hive carries them (one-click join). */
  memberLinks?: string[];
  /** Member upstream repos, encoded `<owner>/<repo>[#<id>]` (hive-announce.ts) —
   *  the repo→Hive binding signal a paste-a-URL lookup matches against (P-003). */
  memberRepos?: string[];
  visibility: HiveVisibility;
  /** Epoch-ms the hive was created (from the announce). */
  createdAt: number;
  /** Epoch-ms the most recent accepted announce was built (LWW ordering key). */
  announcedTs: number;
  /** Epoch-ms we last accepted an announce for it (local freshness / GC). */
  lastSeenMs: number;
  /** Channel-2 GitHub attestation verified (always true for a listed hive). */
  attested: true;
}

/** A hive THIS peer owns + announces. */
export interface LocalHiveDescriptor {
  hiveId: string;
  title: string;
  description: string;
  /**
   * The workspace this hive lives in — the key the announce-build enricher
   * (P-004 hardening) derives fresh pubkey/memberRepos/memberLinks against.
   * Absent ⇒ the descriptor announces exactly as registered (legacy behavior).
   */
  workspaceId?: string;
  memberTopics: string[];
  /** Full join links per member harness (one-click join), when known. */
  memberLinks?: string[];
  /** Member upstream repos, encoded `<owner>/<repo>[#<id>]` — derived fresh at
   *  publish time (deriveHiveMemberRepoRefs), like hivePubkey. */
  memberRepos?: string[];
  visibility: HiveVisibility;
  createdAt: number;
  ownerGithubLogin: string;
  ownerGithubUserId: number;
  ownerDevicePubkey: string;
  /**
   * The Hive's own Ed25519 identity pubkey (raw-32-byte base64), carried on the
   * announce so peers can dial this Hive for cross-Hive (P-006). Set by the publish
   * path from the `hives.public_key` column; absent for a hive with no minted identity.
   */
  hivePubkey?: string;
  attestationGistId: string;
  /** Required for `invite` visibility — the secret whose topic invitees join. */
  inviteSecret?: string;
}

/** Why an inbound announce was rejected (never rendered). */
export type IngestReject =
  | 'bad-signature-or-stale'
  | 'unattested'
  | 'superseded'
  | 'muted'
  /** P-005: dropped by a withdrawal tombstone with ts ≥ this announce's. */
  | 'tombstoned';

/** Why an inbound UNLIST was rejected (P-005). */
export type UnlistReject = 'bad-signature-or-stale' | 'unknown-hive' | 'not-owner';

export interface IngestResult {
  accepted: boolean;
  reason?: IngestReject;
}

/** Injected IO seams — production wires these at boot; tests pass fakes. */
export interface HiveDirectoryDeps {
  /** Sign bytes with the local device key (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign(bytes: Buffer): Promise<Buffer>;
  /** Channel-2 attestation check (prod: wraps attest.verifyAttestation(...).valid). */
  verifyAttestation(args: {
    attestationGistId: string;
    devicePubkey: string;
    githubUserId: number;
  }): Promise<boolean>;
  /** Broadcast a signed frame onto a topic (prod: swarm send to the topic's peers). */
  broadcast(topicHex: string, frame: SignedHiveAnnounce): Promise<void>;
  /** Load the cached discovered set (prod: PG). Optional — omit for in-memory only. */
  loadCache?(): Promise<DiscoveredHive[]>;
  /** Persist the discovered set (prod: PG). Optional. */
  saveCache?(hives: DiscoveredHive[]): Promise<void>;
  /** P-005: load the withdrawal tombstones (hiveId → unlist ts). Optional —
   *  omit for in-memory-only tombstones (a reboot could resurrect a dropped
   *  hive from the offline cache until its TTL). */
  loadTombstones?(): Promise<Record<string, number>>;
  /** P-005: persist the tombstones. Optional. */
  saveTombstones?(tombstones: Record<string, number>): Promise<void>;
  /**
   * Announce-BUILD-time descriptor enrichment (hardening P-004/D-004): called
   * on every frame build so the timer reannounce + fresh-pair snapshots carry
   * the registry as of NOW (members added between publishes included). MUST be
   * best-effort — a throw/reject falls back to the registered descriptor.
   * Prod: hive-descriptor-enrich.enrichLocalHiveDescriptor.
   */
  enrichDescriptor?(desc: LocalHiveDescriptor): Promise<LocalHiveDescriptor>;
  /** Clock seam for deterministic tests. */
  now?(): number;
}

/** How long an un-refreshed discovered hive stays listed before GC (default 7d). */
export const DISCOVERED_HIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class HiveDirectory {
  private readonly discovered = new Map<string, DiscoveredHive>();
  private readonly owned = new Map<string, LocalHiveDescriptor>();
  private readonly muted = new Set<string>();
  /** P-005: withdrawal tombstones — hiveId → the unlist frame's ts. An
   *  announce with ts ≤ this stays dropped; a newer one relists + clears. */
  private readonly tombstones = new Map<string, number>();
  private reannounceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: HiveDirectoryDeps) {}

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Hydrate the in-memory set from the PG cache (offline listing before the swarm reconnects). */
  async hydrateFromCache(): Promise<number> {
    // P-005: tombstones hydrate FIRST so a withdrawn hive in the offline cache
    // cannot resurrect across a reboot.
    if (this.deps.loadTombstones) {
      const ts = await this.deps.loadTombstones().catch(() => ({}) as Record<string, number>);
      for (const [id, t] of Object.entries(ts)) {
        const prev = this.tombstones.get(id);
        if (prev === undefined || t > prev) this.tombstones.set(id, t);
      }
    }
    if (!this.deps.loadCache) return this.discovered.size;
    const cached = await this.deps.loadCache().catch(() => [] as DiscoveredHive[]);
    for (const h of cached) {
      if (this.muted.has(h.hiveId)) continue;
      const tomb = this.tombstones.get(h.hiveId);
      if (tomb !== undefined && h.announcedTs <= tomb) continue; // withdrawn
      this.discovered.set(h.hiveId, h);
    }
    return this.discovered.size;
  }

  /**
   * Ingest an inbound announce: verify signature + freshness (channel-1), then
   * the GitHub attestation (channel-2). Only a frame passing BOTH is rendered
   * (D-001 verified-only). LWW by `ts` — an older announce never clobbers a newer
   * record for the same hive. A muted hive is dropped. Best-effort cache persist.
   */
  async ingestAnnounce(frame: SignedHiveAnnounce): Promise<IngestResult> {
    const nowMs = this.nowMs();
    if (!verifyHiveAnnounce(frame, { nowMs })) {
      return { accepted: false, reason: 'bad-signature-or-stale' };
    }
    if (this.muted.has(frame.hive_id)) {
      return { accepted: false, reason: 'muted' };
    }
    // LWW: ignore an announce that is not newer than what we already hold.
    const existing = this.discovered.get(frame.hive_id);
    if (existing && frame.ts <= existing.announcedTs) {
      return { accepted: false, reason: 'superseded' };
    }
    // P-005 tombstone: a withdrawn hive stays dropped for announces at or
    // before the withdrawal watermark (replay-resistance); a genuinely NEWER
    // signed announce relists (re-publish after withdraw) and clears it.
    const tomb = this.tombstones.get(frame.hive_id);
    if (tomb !== undefined) {
      if (frame.ts <= tomb) return { accepted: false, reason: 'tombstoned' };
      this.tombstones.delete(frame.hive_id);
      await this.persistTombstones();
    }
    const attested = await this.deps
      .verifyAttestation({
        attestationGistId: frame.attestation_gist_id,
        devicePubkey: frame.owner_device_pubkey,
        githubUserId: frame.owner_github_user_id,
      })
      .catch(() => false);
    if (!attested) {
      return { accepted: false, reason: 'unattested' };
    }
    this.discovered.set(frame.hive_id, {
      hiveId: frame.hive_id,
      title: frame.title,
      description: frame.description,
      ownerGithubLogin: frame.owner_github_login,
      ownerGithubUserId: frame.owner_github_user_id,
      ownerDevicePubkey: frame.owner_device_pubkey,
      ...(frame.hive_pubkey ? { hivePubkey: frame.hive_pubkey } : {}),
      memberTopics: [...frame.member_topics],
      ...(frame.member_links ? { memberLinks: [...frame.member_links] } : {}),
      ...(frame.member_repos ? { memberRepos: [...frame.member_repos] } : {}),
      visibility: frame.visibility,
      createdAt: frame.created_at,
      announcedTs: frame.ts,
      lastSeenMs: nowMs,
      attested: true,
    });
    await this.persist();
    return { accepted: true };
  }

  /**
   * The browse list: every verified, un-muted, un-expired discovered hive, newest
   * announce first. This is what the operator endpoint (P-005) serves to the UIs.
   */
  listDiscoveredHives(opts: { includeExpired?: boolean } = {}): DiscoveredHive[] {
    const nowMs = this.nowMs();
    const out: DiscoveredHive[] = [];
    for (const h of this.discovered.values()) {
      if (this.muted.has(h.hiveId)) continue;
      if (!opts.includeExpired && nowMs - h.lastSeenMs > DISCOVERED_HIVE_TTL_MS) continue;
      out.push(h);
    }
    return out.sort((a, b) => b.announcedTs - a.announcedTs);
  }

  /**
   * P-005 — ingest an inbound WITHDRAWAL tombstone. Trust rule (D-005): the
   * frame's signature must verify AND its pubkey must equal the LISTED
   * record's owner_device_pubkey (no listing → nothing to authenticate
   * against → rejected). On accept: drop the record, remember the watermark,
   * persist both.
   */
  async ingestUnlist(frame: SignedHiveUnlist): Promise<{ accepted: boolean; reason?: UnlistReject }> {
    const nowMs = this.nowMs();
    if (!verifyHiveUnlist(frame, { nowMs })) {
      return { accepted: false, reason: 'bad-signature-or-stale' };
    }
    const listed = this.discovered.get(frame.hive_id);
    if (!listed) return { accepted: false, reason: 'unknown-hive' };
    if (listed.ownerDevicePubkey !== frame.owner_device_pubkey) {
      return { accepted: false, reason: 'not-owner' };
    }
    this.discovered.delete(frame.hive_id);
    const prev = this.tombstones.get(frame.hive_id);
    if (prev === undefined || frame.ts > prev) this.tombstones.set(frame.hive_id, frame.ts);
    await this.persist();
    await this.persistTombstones();
    return { accepted: true };
  }

  /**
   * P-005 — owner side: broadcast a signed unlist for an owned hive on its
   * announce topic(s), then unregister it (stop re-announcing). Returns the
   * frame, or null when the hive is unknown/private (a private hive never
   * announced — there is nothing to withdraw on the wire).
   */
  async unlistLocalHive(hiveId: string): Promise<SignedHiveUnlist | null> {
    const desc = this.owned.get(hiveId);
    if (!desc) return null;
    const topic = this.topicForLocalHive(desc); // null = private, never on the wire
    if (!topic) {
      this.owned.delete(hiveId);
      return null;
    }
    const frame = await buildHiveUnlist(
      {
        kind: HIVE_UNLIST_KIND,
        hive_id: hiveId,
        owner_device_pubkey: desc.ownerDevicePubkey,
        ts: this.nowMs(),
      },
      this.deps.sign,
    );
    await this.deps
      .broadcast(hiveTopicAsHex(topic), frame as unknown as SignedHiveAnnounce)
      .catch(() => {});
    this.owned.delete(hiveId);
    return frame;
  }

  private async persistTombstones(): Promise<void> {
    if (!this.deps.saveTombstones) return;
    await this.deps.saveTombstones(Object.fromEntries(this.tombstones)).catch(() => {});
  }

  /** Locally hide a hive from the browse list (D-001 — no global moderation). */
  mute(hiveId: string): void {
    this.muted.add(hiveId);
  }
  unmute(hiveId: string): void {
    this.muted.delete(hiveId);
  }
  isMuted(hiveId: string): boolean {
    return this.muted.has(hiveId);
  }

  /** Register a hive THIS peer owns so it can be (re-)announced. */
  registerLocalHive(desc: LocalHiveDescriptor): void {
    this.owned.set(desc.hiveId, desc);
  }
  unregisterLocalHive(hiveId: string): void {
    this.owned.delete(hiveId);
  }

  /** The topic a given visibility announces on (null = never announces). */
  topicForLocalHive(desc: LocalHiveDescriptor): Buffer | null {
    if (desc.visibility === 'public') return deriveDirectoryTopic();
    if (desc.visibility === 'invite') {
      if (!desc.inviteSecret) {
        throw new Error(`hive ${desc.hiveId} is invite-visibility but has no inviteSecret`);
      }
      return deriveInviteTopic(desc.inviteSecret);
    }
    return null; // private — never announces
  }

  /**
   * Build + broadcast a signed announce for one owned hive. Returns the frame, or
   * null when the hive is `private` (never announces) or unknown. Re-announce on a
   * timer (`startReannounce`) AND call this directly when a hive's metadata
   * changes (P-004 create/edit) so the directory converges promptly.
   */
  /** Build (sign, do NOT broadcast) the announce frame for one owned hive, or
   *  null when private/unknown. Shared by announceLocalHive + buildOwnedAnnounces. */
  private async buildAnnounceFor(descIn: LocalHiveDescriptor): Promise<SignedHiveAnnounce | null> {
    if (!this.topicForLocalHive(descIn)) return null; // private
    // P-004 (hardening): re-derive pubkey/memberRepos/memberLinks at BUILD
    // time so every announce is fresh; failure → announce as registered.
    const desc = this.deps.enrichDescriptor
      ? await this.deps.enrichDescriptor(descIn).catch(() => descIn)
      : descIn;
    const body: HiveAnnounceBody = {
      hive_id: desc.hiveId,
      title: desc.title,
      description: desc.description,
      owner_github_login: desc.ownerGithubLogin,
      owner_github_user_id: desc.ownerGithubUserId,
      owner_device_pubkey: desc.ownerDevicePubkey,
      ...(desc.hivePubkey ? { hive_pubkey: desc.hivePubkey } : {}),
      attestation_gist_id: desc.attestationGistId,
      member_topics: [...desc.memberTopics],
      ...(desc.memberLinks ? { member_links: [...desc.memberLinks] } : {}),
      ...(desc.memberRepos ? { member_repos: [...desc.memberRepos] } : {}),
      visibility: desc.visibility,
      created_at: desc.createdAt,
      ts: this.nowMs(),
    };
    return buildHiveAnnounce(body, this.deps.sign);
  }

  async announceLocalHive(hiveId: string): Promise<SignedHiveAnnounce | null> {
    const desc = this.owned.get(hiveId);
    if (!desc) return null;
    const topic = this.topicForLocalHive(desc);
    if (!topic) return null; // private
    const frame = await this.buildAnnounceFor(desc);
    if (!frame) return null;
    await this.deps.broadcast(hiveTopicAsHex(topic), frame);
    return frame;
  }

  /**
   * Build signed announce frames for owned NON-private hives (no broadcast). The
   * directory-swarm sends these to a freshly-paired peer (`getOwnAnnounces`) so a
   * newly-connected peer learns our hives immediately, without waiting for the
   * re-announce timer.
   *
   * `topicHex` SCOPES the result to the hives that announce on THAT topic — so a
   * peer paired on the GLOBAL topic only ever receives PUBLIC hives, and an
   * invite-topic peer only the invite hive(s) for that secret. Without it (the
   * default) every non-private owned hive is returned. The topic-scoping is what
   * keeps an invite hive from leaking onto the global directory.
   */
  async buildOwnedAnnounces(opts: { topicHex?: string } = {}): Promise<SignedHiveAnnounce[]> {
    const out: SignedHiveAnnounce[] = [];
    for (const desc of this.owned.values()) {
      const topic = this.topicForLocalHive(desc); // null for private
      if (!topic) continue;
      if (opts.topicHex && hiveTopicAsHex(topic) !== opts.topicHex) continue;
      const frame = await this.buildAnnounceFor(desc).catch(() => null);
      if (frame) out.push(frame);
    }
    return out;
  }

  /** Re-announce every owned non-private hive (the timer body). Returns the count broadcast. */
  async reannounceAll(): Promise<number> {
    let n = 0;
    for (const hiveId of this.owned.keys()) {
      const frame = await this.announceLocalHive(hiveId).catch(() => null);
      if (frame) n += 1;
    }
    return n;
  }

  /** Start the re-announce timer (prod: boot wiring). Returns a stop fn. Idempotent. */
  startReannounce(intervalMs: number): () => void {
    this.stopReannounce();
    this.reannounceTimer = setInterval(() => {
      void this.reannounceAll();
    }, intervalMs);
    // Don't keep the process alive solely for re-announce.
    this.reannounceTimer.unref?.();
    return () => this.stopReannounce();
  }
  stopReannounce(): void {
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
  }

  /** GC discovered hives whose last announce is older than the TTL. Returns evicted count. */
  gcExpired(): number {
    const nowMs = this.nowMs();
    let evicted = 0;
    for (const [id, h] of this.discovered) {
      if (nowMs - h.lastSeenMs > DISCOVERED_HIVE_TTL_MS) {
        this.discovered.delete(id);
        evicted += 1;
      }
    }
    // P-005: tombstones age out with the same TTL — after that, the listing
    // would have TTL'd anyway, so the watermark has done its job.
    for (const [id, ts] of this.tombstones) {
      if (nowMs - ts > DISCOVERED_HIVE_TTL_MS) this.tombstones.delete(id);
    }
    return evicted;
  }

  private async persist(): Promise<void> {
    if (!this.deps.saveCache) return;
    await this.deps.saveCache([...this.discovered.values()]).catch(() => {});
  }
}

/**
 * Capability probe used by the p2p-perf-tier3 announce-volume forward hook
 * (and any other surface gating on "does the directory substrate exist yet").
 * Returns true now that P-001..P-003 have shipped — the topic + announce +
 * directory service are all present.
 */
export function hiveDirectoryReady(): boolean {
  return typeof deriveDirectoryTopic === 'function';
}
