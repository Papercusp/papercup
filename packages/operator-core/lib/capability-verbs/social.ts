/**
 * Provider-neutral SOCIAL capability seam (D-019 Tier 1, plan item P-004).
 *
 * WHY THIS FILE EXISTS RATHER THAN A FOURTH COPY OF mail.ts.
 *
 * `mail.ts` and `chat.ts` each resolve a CONSTANT vault source — they literally
 * hardcode `doc.source !== 'gmail'` and `vaultSource: 'gmail'` — because their
 * canonical datatype has exactly one connected provider today. `social-post`
 * does not: Bluesky, Mastodon and Reddit are simultaneously connected, and D-001
 * bounds the family at ten platforms. So for social the platform is a VARIABLE.
 *
 * Where that variable comes from is the security-relevant part, and there is
 * exactly one admissible answer: it is DERIVED FROM THE POST BEING ACTED ON.
 * It is never a caller argument. Letting a caller name the platform separately
 * from the post would hand an injected payload the choice of which of the
 * owner's identities to speak as — a strictly worse failure than a misdirected
 * reply, because the wrong ACCOUNT is not correctable by a follow-up. The ref is
 * therefore a single opaque token carrying both halves, parsed here, and the
 * platform half is used to look up the credential rather than being trusted.
 *
 * Everything below the seam (lexicon shapes, MIME, fullnames, instance hosts)
 * belongs to the adapter, exactly as threading does for mail.
 */
import type postgres from 'postgres';
import {
  assertSocialPlatformUsable,
  assertSocialWriteAllowed,
  type SocialPlatformId,
  type SocialPlatformRow,
  type SocialWriteVerb,
} from '../external-triggers/social/platform-registry';
import { assertTrustedAddressee, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import {
  resolveCanonicalDocument,
  resolveOutboundContext,
  string,
  type CanonicalDocument,
  type OutboundContext,
} from './resolve';

/* -------------------------------------------------------------------------- */
/* Post references                                                            */
/* -------------------------------------------------------------------------- */

/** A canonical social post: which platform, and the platform's own id for it. */
export interface SocialPostRef {
  platform: SocialPlatformId;
  externalId: string;
}

/**
 * Parse `"<platform>:<externalId>"`.
 *
 * Split on the FIRST colon only. This is load-bearing rather than stylistic:
 * an AT-URI is itself full of colons (`at://did:plc:xyz/app.bsky.feed.post/3k`),
 * so splitting on the last colon, or on every colon, silently truncates real
 * Bluesky ids into something that looks like a valid id and resolves to nothing.
 */
/**
 * The shared first-colon split, factored so the two ref kinds below cannot
 * drift apart.
 *
 * This is the same reasoning as D-006 ruling (d) applied one level down: the
 * AT-URI rule is a single fact, and two hand-maintained copies of it would fail
 * in the worst available way — a post ref that parses correctly beside a
 * destination ref that truncates, or vice versa, with both looking valid.
 */
function splitPlatformToken(
  value: string,
  codes: { required: string; malformed: string; shape: string; tailName: string },
): { platform: string; tail: string } {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(codes.required);
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(
      `${codes.malformed}: expected "${codes.shape}", got ${JSON.stringify(raw.slice(0, 64))}`,
    );
  }
  const platform = raw.slice(0, separator).toLowerCase();
  const tail = raw.slice(separator + 1).trim();
  // DEFENCE IN DEPTH, currently unreachable — deliberately kept, and labelled
  // so nobody mistakes it for a live guard they can test. `raw` is trimmed
  // above, so its last character is non-whitespace; combined with the
  // `separator === raw.length - 1` rejection there is always at least one
  // non-whitespace character after the colon, and `tail` cannot be empty. A
  // trailing-colon token therefore refuses via the SHAPE message above, not
  // here. This branch exists only to keep the invariant local if the trim ever
  // moves. (The same branch was already unreachable in the P-005 original this
  // was factored from.)
  if (!tail) throw new Error(`${codes.malformed}: empty ${codes.tailName}`);
  return { platform, tail };
}

export function parseSocialPostRef(ref: string): SocialPostRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_post_ref_required',
    malformed: 'social_post_ref_malformed',
    shape: '<platform>:<id>',
    tailName: 'id',
  });
  // Validate through the registry so an unknown platform fails here, with the
  // registry's reason, rather than as a confusing vault miss further down.
  assertSocialPlatformUsable(platform);
  return { platform: platform as SocialPlatformId, externalId: tail };
}

export function formatSocialPostRef(ref: SocialPostRef): string {
  return `${ref.platform}:${ref.externalId}`;
}

/* -------------------------------------------------------------------------- */
/* Destination references (create-shaped)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a NEW post goes: which platform, and that platform's own name for the
 * community/page it is addressed to.
 */
export interface SocialDestinationRef {
  platform: SocialPlatformId;
  destination: string;
}

/**
 * Parse `"<platform>:<destination>"` for a create-shaped post.
 *
 * WHY THE PLATFORM RIDES INSIDE THE TOKEN RATHER THAN BESIDE IT. A reply
 * derives its platform from the stored parent (D-006 ruling a), which a create
 * has no equivalent of — so the caller unavoidably names the destination. That
 * does NOT license re-admitting a free-standing `platform` argument: a separate
 * argument could be varied INDEPENDENTLY of the destination, which is exactly
 * the failure D-006 forbids (choosing which of the owner's identities speaks).
 * Carried inside one opaque token, the platform half cannot disagree with the
 * destination half, and rail 2 below judges the token the caller actually named.
 *
 * Splits on the FIRST colon, via the shared splitter above, for the AT-URI
 * reason recorded in D-006.
 */
export function parseSocialDestinationRef(ref: string): SocialDestinationRef {
  const { platform, tail } = splitPlatformToken(ref, {
    required: 'social_destination_ref_required',
    malformed: 'social_destination_ref_malformed',
    shape: '<platform>:<destination>',
    tailName: 'destination',
  });
  assertSocialPlatformUsable(platform);
  return { platform: platform as SocialPlatformId, destination: tail };
}

export function formatSocialDestinationRef(ref: SocialDestinationRef): string {
  return `${ref.platform}:${ref.destination}`;
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provider-neutral audience ladder, ordered narrowest to widest.
 *
 * Platforms name these differently (Mastodon says `private` for followers-only;
 * Reddit has no per-post equivalent at all and inherits the subreddit's). The
 * ladder exists so the widening rail below is expressible once instead of per
 * adapter.
 */
export type SocialVisibility = 'direct' | 'followers' | 'unlisted' | 'public';

const VISIBILITY_RANK: Record<SocialVisibility, number> = {
  direct: 0,
  followers: 1,
  unlisted: 2,
  public: 3,
};

const VISIBILITY_ALIASES: Record<string, SocialVisibility> = {
  direct: 'direct',
  dm: 'direct',
  private: 'followers',
  followers: 'followers',
  'followers-only': 'followers',
  unlisted: 'unlisted',
  public: 'public',
};

/**
 * Normalize a platform-native visibility onto the neutral ladder.
 *
 * THREE distinct cases, and collapsing any two of them is a leak:
 *
 *  - ABSENT (null/undefined/blank) → `public`. The platform does not model
 *    per-post audience at all (Reddit, Bluesky today), and those posts really
 *    are public. Narrowing here would make every Reddit reply `direct`, which
 *    is not a safer reading — it is a meaningless one.
 *  - PRESENT BUT UNRECOGNIZED (a future platform's label) → `direct`. An
 *    audience we cannot interpret is not an invitation to guess, and `public`
 *    is the one guess that can leak.
 *  - MALFORMED (present but not a string at all) → `direct`. This is corrupt
 *    stored data, so it gets the narrow floor rather than the absent default.
 *
 * The middle and last cases were originally collapsed into the first by routing
 * through `string()`, which coerces a non-string to `''` and so made malformed
 * data indistinguishable from an absent field — reaching the `public` branch.
 * The control in social.test.ts caught it; that is what the controls are for.
 */
export function normalizeSocialVisibility(value: unknown): SocialVisibility {
  if (value === undefined || value === null) return 'public';
  if (typeof value !== 'string') return 'direct';
  const raw = value.trim().toLowerCase();
  if (!raw) return 'public';
  return VISIBILITY_ALIASES[raw] ?? 'direct';
}

export class SocialVisibilityWidened extends Error {
  readonly parent: SocialVisibility;
  readonly requested: SocialVisibility;
  constructor(parent: SocialVisibility, requested: SocialVisibility) {
    super(
      `social_reply_would_widen_visibility: parent is '${parent}' but the reply asked for '${requested}'. ` +
        `A reply never widens its parent's audience — re-send at '${parent}' or narrower.`,
    );
    this.name = 'SocialVisibilityWidened';
    this.parent = parent;
    this.requested = requested;
  }
}

/**
 * A reply may match its parent's audience or narrow it, never widen it.
 *
 * This rail has no equivalent in mail or chat, which is why it lives here: an
 * email reply reaches the same recipients by construction, and a Slack thread
 * reply inherits the channel. A social reply is different in kind — the parent
 * carries an independent audience setting, and replying `public` to a
 * followers-only post republishes its content, quoted, to everyone. That is a
 * disclosure the owner never authorized and cannot retract, and it is easy to
 * do by accident because `public` is every platform's default.
 */
export function resolveReplyVisibility(
  parent: SocialVisibility,
  requested?: SocialVisibility | null,
): SocialVisibility {
  if (!requested) return parent;
  if (VISIBILITY_RANK[requested] > VISIBILITY_RANK[parent]) {
    throw new SocialVisibilityWidened(parent, requested);
  }
  return requested;
}

/* -------------------------------------------------------------------------- */
/* Rail 1 — reply coordinates derived from the stored document alone          */
/* -------------------------------------------------------------------------- */

/**
 * Platform-native reply target, discriminated so each adapter receives exactly
 * the fields its API needs and cannot silently read a field meant for another.
 */
export type SocialReplyTarget =
  | {
      platform: 'bluesky';
      /** Thread root strong ref — atproto requires BOTH root and parent. */
      rootUri: string;
      rootCid: string;
      parentUri: string;
      parentCid: string;
    }
  | { platform: 'mastodon'; inReplyToId: string; instanceHost: string }
  | { platform: 'reddit'; parentFullname: string; subreddit: string };

export interface SocialReplyCoordinates {
  ref: SocialPostRef;
  target: SocialReplyTarget;
  /** The PARENT's audience. The reply may match or narrow it, never widen. */
  parentVisibility: SocialVisibility;
  /** Human-readable destination, echoed back so the caller reports where it went. */
  label: string;
}

/**
 * Derive every reply coordinate from the STORED document.
 *
 * Pure, and exported for the same reason `resolveMailReplyCoordinates` is: the
 * security claim is "these values come from the vault document, never from a
 * caller argument", and a function whose only input is the document makes that
 * claim mechanically checkable instead of merely asserted.
 */
export function resolveSocialReplyCoordinates(doc: CanonicalDocument): SocialReplyCoordinates {
  const platform = doc.source as SocialPlatformId;
  const row = assertSocialPlatformUsable(platform);
  const payload = doc.payload;
  const ref: SocialPostRef = { platform, externalId: doc.externalId };
  const parentVisibility = normalizeSocialVisibility(payload.visibility);

  switch (platform) {
    case 'bluesky': {
      const parentUri = string(payload.uri) || doc.externalId;
      const parentCid = string(payload.cid);
      // A reply to a root post IS the thread root, so root falls back to parent.
      const rootUri = string(payload.rootUri) || parentUri;
      const rootCid = string(payload.rootCid) || parentCid;
      if (!parentUri || !parentCid) {
        throw new Error(
          'social_reply_coordinates_missing:bluesky — atproto needs a strong ref (uri AND cid) for both parent and root',
        );
      }
      return {
        ref,
        target: { platform: 'bluesky', rootUri, rootCid, parentUri, parentCid },
        parentVisibility,
        label: `${row.label} · ${string(payload.authorHandle) || parentUri}`,
      };
    }

    case 'mastodon': {
      const inReplyToId = string(payload.statusId) || doc.externalId;
      const instanceHost = string(payload.instanceHost);
      if (!inReplyToId) throw new Error('social_reply_coordinates_missing:mastodon — no status id');
      if (!instanceHost) {
        // Mastodon has no single API host; the credential is per instance, so
        // an absent host is unrecoverable rather than defaultable.
        throw new Error(
          'social_reply_coordinates_missing:mastodon — no instanceHost on the stored status; Mastodon is federated, so there is no default host to fall back to',
        );
      }
      return {
        ref,
        target: { platform: 'mastodon', inReplyToId, instanceHost },
        parentVisibility,
        label: `${row.label} · ${instanceHost} · ${string(payload.authorHandle) || inReplyToId}`,
      };
    }

    case 'reddit': {
      const parentFullname = string(payload.fullname) || doc.externalId;
      const subreddit = string(payload.subreddit);
      if (!parentFullname || !/^t\d_/.test(parentFullname)) {
        throw new Error(
          `social_reply_coordinates_missing:reddit — expected a fullname like t3_abc123, got ${JSON.stringify(parentFullname.slice(0, 32))}`,
        );
      }
      return {
        ref,
        target: { platform: 'reddit', parentFullname, subreddit },
        parentVisibility,
        label: `${row.label} · ${subreddit ? `r/${subreddit}` : parentFullname}`,
      };
    }

    default:
      // Wave B/C platforms are refused by assertSocialPlatformUsable above
      // (unverified or owner-blocked), so reaching here means a row was
      // verified without its reply coordinates being taught to this seam.
      throw new Error(
        `social_reply_platform_unsupported:${platform} — the registry row is usable but this seam has no coordinate derivation for it yet`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolvedSocialPost {
  ref: SocialPostRef;
  row: SocialPlatformRow;
  doc: CanonicalDocument;
}

/**
 * Resolve a post ref to the stored document and its platform row.
 *
 * Scoped to (workspace, user) by `resolveCanonicalDocument`, so a caller cannot
 * address another principal's post by guessing an id.
 */
export async function resolveSocialPost(
  sql: postgres.Sql | postgres.TransactionSql,
  params: { workspaceId: string; userId: string; ref: string | SocialPostRef },
): Promise<ResolvedSocialPost> {
  const ref = typeof params.ref === 'string' ? parseSocialPostRef(params.ref) : params.ref;
  const row = assertSocialPlatformUsable(ref.platform);
  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: ref.platform,
    externalId: ref.externalId,
  });
  if (doc.source !== ref.platform) {
    // Defence in depth: the query already filters on source.
    throw new Error(`social_post_platform_mismatch:${ref.platform}:${doc.source}`);
  }
  return { ref, row, doc };
}

/**
 * Resolve the outbound credential for a social platform.
 *
 * The platform id doubles as the vault source name and the trigger-source kind
 * — deliberately, so there is no second mapping table to drift out of sync with
 * the registry (see `TRIGGER_KIND_BY_VAULT_SOURCE` in resolve.ts, which derives
 * its social entries from the registry rather than restating them).
 */
export async function resolveSocialOutboundContext(
  sql: postgres.Sql,
  params: { workspaceId: string; userId: string; platform: SocialPlatformId; verb: SocialWriteVerb },
): Promise<{ row: SocialPlatformRow; context: OutboundContext }> {
  const row = assertSocialWriteAllowed(params.platform, params.verb);
  const context = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: params.platform,
  });
  return { row, context };
}

/* -------------------------------------------------------------------------- */
/* Write adapters                                                             */
/* -------------------------------------------------------------------------- */

export interface SocialReplyRequest {
  target: SocialReplyTarget;
  text: string;
  visibility: SocialVisibility;
  /**
   * Stable key for the logical write, so an adapter on a platform with an
   * idempotency mechanism (Mastodon's Idempotency-Key) can pass it through and
   * one without (Reddit) can carry its own dedupe guard. Derived, never caller-
   * supplied — a caller-chosen key would let a retry be forced into a NEW post.
   */
  idempotencyKey: string;
}

export interface SocialReplyOutcome {
  /** Platform id of the created post. */
  externalId: string;
  /** Canonical ref for the created post, so the caller can address it later. */
  ref: string;
  url?: string;
}

/** A create-shaped write: new content, at a destination the caller named. */
export interface SocialPostRequest {
  destination: string;
  text: string;
  visibility: SocialVisibility;
  /** Derived, never caller-supplied — see `socialPostIdempotencyKey`. */
  idempotencyKey: string;
}

export type SocialPostOutcome = SocialReplyOutcome;

export interface SocialWriteAdapter {
  platform: SocialPlatformId;
  reply(request: SocialReplyRequest, context: OutboundContext): Promise<SocialReplyOutcome>;
  /**
   * Optional on purpose. The registry already declares per-platform write verbs
   * (`write.verbs`), and `assertSocialWriteAllowed` refuses a verb a platform
   * does not support BEFORE this lookup — so a missing `post` here means "the
   * adapter has not implemented a verb its platform does declare", which is a
   * distinct and separately-reported condition from "the platform cannot post".
   * Collapsing the two would report an unimplemented adapter as a platform
   * limitation, sending someone to verify a lexicon that was never the problem.
   */
  post?(request: SocialPostRequest, context: OutboundContext): Promise<SocialPostOutcome>;
}

const WRITE_ADAPTERS = new Map<SocialPlatformId, SocialWriteAdapter>();

/** Register a platform's write adapter (P-011..P-019 land these). */
export function registerSocialWriteAdapter(adapter: SocialWriteAdapter): void {
  WRITE_ADAPTERS.set(adapter.platform, adapter);
}

/** Test seam: drop a registration so a suite cannot leak into the next. */
export function unregisterSocialWriteAdapter(platform: SocialPlatformId): void {
  WRITE_ADAPTERS.delete(platform);
}

export function getSocialWriteAdapter(platform: SocialPlatformId): SocialWriteAdapter | undefined {
  return WRITE_ADAPTERS.get(platform);
}

/**
 * Derive the idempotency key for a reply.
 *
 * Deliberately a function of (parent, text) and NOT of wall-clock time: the
 * whole point is that a retry of the same logical reply produces the same key.
 * A timestamp would make every retry unique, which is precisely the double-post
 * the key exists to prevent — and Reddit documents no idempotency mechanism at
 * all, so its adapter has nothing else to dedupe on.
 */
export function socialReplyIdempotencyKey(ref: SocialPostRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialPostRef(ref)}${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Derive the idempotency key for a create-shaped post.
 *
 * Same (target, text) construction and the same deliberate absence of a
 * timestamp as the reply key above — a retry of the same logical write must
 * produce the same key, which a clock would defeat.
 *
 * The `-post-` infix is load-bearing rather than cosmetic. A post ref and a
 * destination ref are BOTH `"<platform>:<tail>"`, so a reply to `reddit:abc`
 * and a post addressed to `reddit:abc` carrying identical text would otherwise
 * be indistinguishable — and an adapter deduping on the key would silently drop
 * the second, genuinely different, write. The two key spaces are therefore
 * disjoint by construction, pinned by test.
 */
export function socialPostIdempotencyKey(ref: SocialDestinationRef, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${formatSocialDestinationRef(ref)}${text.trim()}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `pc-social-post-${hash.toString(16).padStart(8, '0')}`;
}

export interface SocialReplyResult extends SocialReplyOutcome {
  platform: SocialPlatformId;
  /** Echoed so the caller reports WHERE it went — it never chose. */
  inReplyTo: string;
  label: string;
  visibility: SocialVisibility;
}

/**
 * `social:reply` — D-020 rail 1 for social-post.
 *
 * The caller supplies TEXT ONLY plus an opaque post ref. Destination, account,
 * credential and audience are all resolved server-side from the stored
 * document. Executes rather than drafts, per D-004: the blast radius is the
 * existing thread, it is visible, and a follow-up can correct it.
 *
 * Order of the gates matters and is not arbitrary. The registry write gate runs
 * BEFORE the adapter lookup, so an unverified write path (Bluesky) is refused
 * even once its adapter exists — the gate is about whether we know how to call
 * the API correctly, which having written an adapter does not establish.
 */
export async function replyToCanonicalSocialPost(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    ref: string | SocialPostRef;
    text: string;
    visibility?: SocialVisibility | null;
  },
): Promise<SocialReplyResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_reply_text_required');
  if (text.length > 10_000) throw new Error('social_reply_text_too_long');

  const { ref, doc } = await resolveSocialPost(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    ref: params.ref,
  });
  const coordinates = resolveSocialReplyCoordinates(doc);
  const visibility = resolveReplyVisibility(coordinates.parentVisibility, params.visibility);

  const { context } = await resolveSocialOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    platform: ref.platform,
    verb: 'reply',
  });

  const adapter = getSocialWriteAdapter(ref.platform);
  if (!adapter) {
    throw new Error(
      `social_reply_adapter_missing:${ref.platform} — the platform's write path is verified but no adapter is registered yet`,
    );
  }

  const outcome = await adapter.reply(
    {
      target: coordinates.target,
      text,
      visibility,
      idempotencyKey: socialReplyIdempotencyKey(ref, text),
    },
    context,
  );

  return {
    ...outcome,
    platform: ref.platform,
    inReplyTo: formatSocialPostRef(ref),
    label: coordinates.label,
    visibility,
  };
}

/**
 * Rail 2 for social: a create-shaped destination the CALLER named.
 *
 * `social:post` targets an audience the agent supplies (a subreddit, a page, a
 * community), which is exactly the shape D-020 rail 2 governs. A destination
 * quoted inside an inbound post's body is refused for the same reason an
 * injected email address is: it carries the body-only signature.
 */
export async function assertTrustedSocialDestination(
  sql: postgres.Sql | postgres.TransactionSql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string;
    provenance: AddresseeProvenance;
  },
): Promise<AddresseeDecision> {
  const destination = string(params.destination);
  if (!destination) throw new Error('social_destination_required');
  return assertTrustedAddressee(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: destination,
    provenance: params.provenance,
  });
}

/* -------------------------------------------------------------------------- */
/* social:post — create-shaped publishing                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the caller is told BEFORE anything goes out.
 *
 * D-004 ruling (b) requires the resolved account and audience to be echoed back
 * before publish REGARDLESS OF THE FLAG, which is why this is a first-class
 * return value rather than a log line: with publishing withheld it is the whole
 * answer, and the owner's ratification decision is made against it.
 */
export interface SocialPostEcho {
  platform: SocialPlatformId;
  destination: string;
  destinationRef: string;
  visibility: SocialVisibility;
  /** WHICH of the owner's connected accounts would speak. */
  account: { sourceId: string; kind: string; credentialRef: string | null };
  /** Rail 2's verdict on the destination the caller named. */
  destinationStanding: AddresseeDecision['standing'];
  destinationProvenance: AddresseeDecision['provenance'];
  destinationVerified: boolean;
  idempotencyKey: string;
  characters: number;
}

export interface SocialPostResult {
  echo: SocialPostEcho;
  /** null iff publishing was withheld. */
  published: (SocialPostOutcome & { platform: SocialPlatformId }) | null;
  withheld: { reason: 'publish-flag-off'; detail: string } | null;
}

/**
 * `social:post` — D-020 rail 2 for social-post, gated by D-004 ruling (b).
 *
 * The ordering below is the security content of this function; every gate can
 * be individually present and the verb still be unsafe if they run out of
 * order.
 *
 *  1. PARSE. An unknown platform fails with the registry's reason before any
 *     vault or credential work happens.
 *  2. RAIL 2, before any credential is resolved. A destination the agent could
 *     only have read out of inbound message content is refused outright — and
 *     it is refused before the owner's credential is even looked up, so an
 *     injected destination never reaches a code path holding an identity.
 *  3. REGISTRY WRITE GATE, before the adapter lookup — same reasoning as
 *     `replyToCanonicalSocialPost`: having written an adapter is not evidence
 *     that we know how to call the API correctly.
 *  4. FLAG, last. It withholds the outbound call ONLY. Everything above it has
 *     already run, so the echo the owner ratifies against is the real
 *     resolution and not a prediction of one.
 *
 * The flag is read HERE rather than at the tool boundary, deliberately. A
 * `publish: boolean` parameter would put the publish authority in the caller's
 * hands, and the next caller to be written is the one that forgets — this way
 * there is exactly one decision point and no argument that can bypass it.
 */
export async function postToCanonicalSocialDestination(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    destination: string | SocialDestinationRef;
    text: string;
    visibility?: SocialVisibility | null;
    provenance: AddresseeProvenance;
  },
): Promise<SocialPostResult> {
  const text = params.text.trim();
  if (!text) throw new Error('social_post_text_required');
  if (text.length > 10_000) throw new Error('social_post_text_too_long');

  const ref =
    typeof params.destination === 'string'
      ? parseSocialDestinationRef(params.destination)
      : params.destination;

  // A create has no parent to inherit from, so the widening rail (D-006 ruling
  // c) has nothing to compare against and does not apply. An absent value
  // therefore lands on `public` for the reason recorded in
  // `normalizeSocialVisibility`: these posts genuinely are public, and
  // narrowing a create to `direct` would produce a DM, which is not a safer
  // reading of "post" but a different verb. A MALFORMED value still fails
  // closed to `direct` through the same normalizer.
  const visibility =
    params.visibility === undefined || params.visibility === null
      ? 'public'
      : normalizeSocialVisibility(params.visibility);

  const decision = await assertTrustedSocialDestination(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    destination: ref.destination,
    provenance: params.provenance,
  });

  const { context } = await resolveSocialOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    platform: ref.platform,
    verb: 'post',
  });

  const adapter = getSocialWriteAdapter(ref.platform);
  if (!adapter) {
    throw new Error(
      `social_post_adapter_missing:${ref.platform} — the platform's write path is verified but no adapter is registered yet`,
    );
  }
  if (typeof adapter.post !== 'function') {
    throw new Error(
      `social_post_adapter_verb_missing:${ref.platform} — the registry declares this platform can post, but its adapter implements only reply`,
    );
  }

  const echo: SocialPostEcho = {
    platform: ref.platform,
    destination: ref.destination,
    destinationRef: formatSocialDestinationRef(ref),
    visibility,
    account: {
      sourceId: context.source.id,
      kind: context.source.kind,
      credentialRef: context.source.credentialRef,
    },
    destinationStanding: decision.standing,
    destinationProvenance: decision.provenance,
    destinationVerified: decision.verified,
    idempotencyKey: socialPostIdempotencyKey(ref, text),
    characters: text.length,
  };

  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.SOCIAL_AUTO_PUBLISH, `social-post:${params.workspaceId}`);
  if (!enabled) {
    return {
      echo,
      published: null,
      withheld: {
        reason: 'publish-flag-off',
        detail:
          "publishing to the owner's public identity is withheld until the owner ratifies it (flag papercusp-social-auto-publish, default OFF per D-004(b)) — everything above the outbound call ran, so this echo is the real resolution. Flip it via /admin/features.",
      },
    };
  }

  const outcome = await adapter.post(
    {
      destination: ref.destination,
      text,
      visibility,
      idempotencyKey: echo.idempotencyKey,
    },
    context,
  );

  return { echo, published: { ...outcome, platform: ref.platform }, withheld: null };
}
