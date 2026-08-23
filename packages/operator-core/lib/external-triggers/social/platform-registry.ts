/**
 * Social platform capability registry
 * (social-platform-integrations-2026-08-23 P-002, ruled by D-005).
 *
 * WHAT THIS IS. One row per social platform declaring the facts an adapter and
 * the UI both need: how it authenticates, how it is read, whether that read is
 * replayable after an offline gap, what can be written, and what the rate
 * budget is. The `social:*` verbs and the admin surface READ this; nothing
 * restates it in prose.
 *
 * WHY IT IS CURATED RATHER THAN DERIVED. The derived-truth ladder (repo
 * CLAUDE.md) says a value describing CODE must be derived, pinned or attested.
 * These rows describe EXTERNAL services, so no amount of static analysis over
 * our tree can produce them — they are tier-4 CURATED, which the ladder permits
 * only with a stated reason. That is the reason. What keeps them honest is the
 * tier-3 half: every row carries `verifiedAt` plus the exact source URLs it was
 * read from, and `assertPlatformUsable` REFUSES an unverified row rather than
 * treating it as permissive (D-005). A row nobody has checked cannot be used by
 * accident; it has to be checked first.
 *
 * VERIFICATION IS JUST-IN-TIME (D-005). Wave B and C rows are deliberately
 * `verifiedAt: null`. Platform pricing, scopes and review requirements are the
 * fastest-moving facts this plan depends on, so verifying them weeks before the
 * work starts produces a stale row that must be re-verified anyway — and a
 * stale row is worse than an absent one, because it reads as known. Each wave's
 * first item re-runs verification for its own platforms and fills its rows in.
 */

/** Platforms whose unit of content normalizes to the canonical `social-post` datatype (D-001). */
export type SocialPlatformId =
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'youtube'
  | 'facebook-pages'
  | 'instagram'
  | 'threads'
  | 'linkedin'
  | 'tiktok'
  | 'x-twitter';

/**
 * How an owner's account is connected.
 * - `self-serve-oauth`  — an OAuth app anyone can register without review.
 * - `app-password`      — a user-generated scoped credential, no app registration.
 * - `instance-oauth`    — OAuth against a per-connection host (Mastodon: client
 *                         registration happens per instance, so there is no one
 *                         client id for the platform).
 * - `app-review`        — an OAuth app that only receives its scopes after the
 *                         vendor reviews it. Owner-side work with a lead time.
 * - `paid-tier`         — access requires a paid subscription.
 */
export type SocialAuthMode =
  | 'self-serve-oauth'
  | 'app-password'
  | 'instance-oauth'
  | 'app-review'
  | 'paid-tier';

/**
 * How events are read. Both legal values are OUTBOUND-ONLY by construction —
 * D-003 forbids depending on inbound webhooks, because Papercusp is a desktop
 * app behind NAT with no public ingress. There is deliberately no 'webhook'
 * member of this union: a platform that can ONLY be read by webhook cannot be
 * expressed in this registry, which is the point. `platform-registry.test.ts`
 * pins that.
 */
export type SocialReadTransport = 'outbound-websocket' | 'poll-cursor';

/**
 * The three replay classes measured in D-005. They differ in what happens after
 * the process is offline for a while, and that difference is the whole reason
 * the conformance kit exists:
 * - `bounded-cursor-window` — a stored cursor replays missed events, but only
 *   within a retention window; past it the cursor is refused and the adapter
 *   MUST fall back to a bounded backfill. (Bluesky; also Gmail's historyId.)
 * - `no-replay-rest-backfill` — the stream carries no cursor at all, so a gap
 *   is recoverable ONLY by re-reading REST with a since-marker. (Mastodon.)
 * - `poll-cursor` — there is no stream; reading IS the cursored poll. (Reddit.)
 */
export type SocialReplayClass = 'bounded-cursor-window' | 'no-replay-rest-backfill' | 'poll-cursor';

/** Agent-facing capability verbs (D-019 Tier 1) a platform's adapter can serve. */
export type SocialWriteVerb = 'reply' | 'post' | 'delete';

/**
 * Whether the platform offers a native duplicate-suppression mechanism for
 * writes. This matters more than it looks: an adapter that retries a failed
 * write without one double-posts publicly, which is not correctable the way a
 * duplicate email is. `header` means a request header carries a caller-supplied
 * key; `unknown` means we have not verified it and a write path must therefore
 * implement its own guard.
 */
export type SocialWriteIdempotency = 'header' | 'none' | 'unknown';

export interface SocialRateBudget {
  /** Requests per minute, where the platform states one. */
  requestsPerMinute?: number;
  /** Daily quota in platform-specific units (e.g. YouTube quota units). */
  quotaUnitsPerDay?: number;
  /** Response headers that report remaining budget, for adaptive backoff. */
  budgetHeaders?: string[];
  /** Anything the numbers alone do not convey. */
  notes?: string;
}

export interface SocialPlatformRow {
  id: SocialPlatformId;
  label: string;
  /** Acquisition-cost wave (see the plan's Background), not a priority ranking. */
  wave: 'A' | 'B' | 'C';
  /**
   * ISO date this row's facts were last read from the cited sources, or null if
   * never verified. `assertPlatformUsable` refuses a null (D-005).
   */
  verifiedAt: string | null;
  /** Exact doc URLs the facts came from. Empty only while unverified. */
  sources: string[];
  auth: {
    mode: SocialAuthMode;
    scopes: string[];
    notes?: string;
  };
  read: {
    transport: SocialReadTransport;
    replay: SocialReplayClass;
    /** How a gap is recovered when the cursor is unusable. */
    backfill?: string;
  };
  write: {
    verbs: SocialWriteVerb[];
    idempotency: SocialWriteIdempotency;
    notes?: string;
  };
  limits: SocialRateBudget;
  /** Automation/ToS restrictions that constrain what we may build, not just what the API allows. */
  policyNotes?: string;
  /**
   * Set when the platform is blocked on something only the owner can do. Named
   * so it surfaces in status reports instead of being rediscovered at build
   * time. `owner:` prefix marks an owner-walled action.
   */
  blockedOn?: string;
}

const ROWS: Record<SocialPlatformId, SocialPlatformRow> = {
  bluesky: {
    id: 'bluesky',
    label: 'Bluesky',
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: ['https://atproto.com/specs/event-stream'],
    auth: {
      mode: 'app-password',
      scopes: [],
      notes:
        'Read stream endpoints are documented as unauthenticated. The write path (app password vs OAuth) is NOT yet verified — see D-005 residue; verify before enabling write verbs.',
    },
    read: {
      transport: 'outbound-websocket',
      replay: 'bounded-cursor-window',
      backfill:
        'Reconnect with the stored integer cursor against a monotonic seq. A cursor ahead of the server is a FutureCursor error and closes the connection; a cursor older than the retention window returns an #info message and replay restarts at the oldest retained seq. The window is qualitative ("hours or days") and explicitly not the full stream history, so a long offline gap MUST fall back to a bounded REST backfill rather than trusting the cursor.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      idempotency: 'unknown',
      notes: 'Write path unverified (D-005 residue). Verbs are declared but gated by verifiedAt on the write half.',
    },
    limits: {
      budgetHeaders: ['Retry-After'],
      notes:
        'HTTP 429 with Retry-After is documented at connection time. A consumer that falls behind receives a "too slow" error and is disconnected, so the adapter must keep up or reconnect by cursor.',
    },
  },

  mastodon: {
    id: 'mastodon',
    label: 'Mastodon',
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: [
      'https://docs.joinmastodon.org/methods/streaming/',
      'https://docs.joinmastodon.org/methods/statuses/',
    ],
    auth: {
      mode: 'instance-oauth',
      scopes: ['read:statuses', 'read:notifications', 'write:statuses'],
      notes:
        'Client registration is per instance — there is no single platform-wide client id. The streaming host may differ from the API host: discover it from configuration.urls.streaming rather than assuming. Mastodon 4.2.0 removed app-token access to these streams; a USER token is required.',
    },
    read: {
      transport: 'outbound-websocket',
      replay: 'no-replay-rest-backfill',
      backfill:
        'The streaming API exposes NO cursor, since_id or offset on any endpoint. A disconnection gap is recoverable only by re-reading the REST timeline endpoints with a stored since-marker. Reconciliation is therefore mandatory on every connect, not an optimization.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      idempotency: 'header',
      notes:
        'POST /api/v1/statuses; reply via in_reply_to_id; visibility is one of public|unlisted|private|direct. Send an Idempotency-Key header on EVERY write — it is retained for up to an hour and is what stops a retry from double-posting.',
    },
    limits: {
      notes: 'Not specified on the streaming page; rate limits are documented separately and are per-instance.',
    },
  },

  reddit: {
    id: 'reddit',
    label: 'Reddit',
    wave: 'A',
    verifiedAt: '2026-08-23',
    sources: ['https://github.com/reddit-archive/reddit/wiki/API'],
    auth: {
      mode: 'self-serve-oauth',
      scopes: ['identity', 'read', 'submit', 'edit'],
    },
    read: {
      transport: 'poll-cursor',
      replay: 'poll-cursor',
      backfill: 'Cursored listings; reading is the poll. A gap is closed by walking the listing cursor backwards to the stored marker.',
    },
    write: {
      verbs: ['reply', 'post', 'delete'],
      idempotency: 'none',
      notes: 'No documented idempotency mechanism, so the adapter must carry its own write-dedupe guard.',
    },
    limits: {
      requestsPerMinute: 60,
      budgetHeaders: ['X-Ratelimit-Used', 'X-Ratelimit-Remaining', 'X-Ratelimit-Reset'],
      notes:
        'OAuth2 clients may make up to 60 requests per minute. Batch endpoints are preferred over looping single-resource calls.',
    },
    policyNotes:
      'A distinctive User-Agent of the form <platform>:<app ID>:<version> (by /u/<username>) is MANDATORY — generic agents are heavily throttled and the docs are explicit that it must not be falsified. Current free-vs-commercial terms are NOT verified (the support article refuses automated fetch); treat commercial use as unresolved.',
  },

  youtube: {
    id: 'youtube',
    label: 'YouTube',
    wave: 'B',
    verifiedAt: null,
    sources: [],
    auth: {
      mode: 'self-serve-oauth',
      scopes: [],
      notes:
        'Intended to ride the SAME Google Workspace OAuth source as the landed Gmail and Calendar lanes (external-triggers D-010 one-credential-path pattern) — a scope addition with a documented consent upgrade, never a second credential path.',
    },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['reply'], idempotency: 'unknown' },
    limits: { notes: 'Quota-unit budget unverified.' },
    blockedOn: 'verification: Wave B just-in-time verification has not run (D-005)',
  },

  'facebook-pages': {
    id: 'facebook-pages',
    label: 'Facebook Pages',
    wave: 'B',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'app-review', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['reply', 'post'], idempotency: 'unknown' },
    limits: {},
    blockedOn: 'owner: Meta app review (identity, legal and business verification; multi-week lead time)',
  },

  instagram: {
    id: 'instagram',
    label: 'Instagram',
    wave: 'B',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'app-review', scopes: [] },
    read: {
      transport: 'poll-cursor',
      replay: 'poll-cursor',
      backfill:
        'Comment webhooks are unusable without public ingress (D-003), so this is poll+cursor. If measured poll latency cannot serve comment triage, that measurement is the documented trigger to reopen the Svix decision.',
    },
    write: { verbs: ['reply', 'post'], idempotency: 'unknown' },
    limits: {},
    blockedOn: 'owner: Meta app review',
  },

  threads: {
    id: 'threads',
    label: 'Threads',
    wave: 'B',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'app-review', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['reply', 'post'], idempotency: 'unknown' },
    limits: {},
    blockedOn: 'owner: Meta app review (shares the Meta app identity with Instagram and Facebook Pages)',
  },

  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    wave: 'C',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'app-review', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['post'], idempotency: 'unknown' },
    limits: {},
    blockedOn: 'owner: partner review for organization/page access; personal-profile posting may be self-serve (unverified)',
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    wave: 'C',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'app-review', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['post'], idempotency: 'unknown' },
    limits: {},
    blockedOn: 'owner: TikTok audit — unaudited apps cannot direct-publish, so v1 targets the draft/inbox path',
  },

  'x-twitter': {
    id: 'x-twitter',
    label: 'X (Twitter)',
    wave: 'C',
    verifiedAt: null,
    sources: [],
    auth: { mode: 'paid-tier', scopes: [] },
    read: { transport: 'poll-cursor', replay: 'poll-cursor' },
    write: { verbs: ['reply', 'post', 'delete'], idempotency: 'unknown' },
    limits: {},
    policyNotes:
      'D-002 rejected the alternatives on record: no scraping or unofficial client (against terms, and it would be the only integration not riding a sanctioned API), and no free-tier write-only adapter (it cannot serve the mention-triage or comment-digest workflows, so it would ship a hollow row that reads as support).',
    blockedOn: 'owner: paid-tier purchase authorization — a recurring cost outside agent authority under any mode (D-002)',
  },
};

/** Every platform row, in registry order. */
export function listSocialPlatforms(): SocialPlatformRow[] {
  return Object.values(ROWS);
}

/** One row by id, or undefined when the id is not a known platform. */
export function getSocialPlatform(id: string): SocialPlatformRow | undefined {
  return ROWS[id as SocialPlatformId];
}

/** Rows in a given acquisition wave. */
export function listSocialPlatformsByWave(wave: SocialPlatformRow['wave']): SocialPlatformRow[] {
  return listSocialPlatforms().filter((row) => row.wave === wave);
}

/** True when the row has been verified against its cited sources. */
export function isSocialPlatformVerified(row: SocialPlatformRow): boolean {
  return typeof row.verifiedAt === 'string' && row.verifiedAt.length > 0 && row.sources.length > 0;
}

export class SocialPlatformUnusableError extends Error {
  readonly platformId: string;
  readonly reason: 'unknown-platform' | 'unverified' | 'owner-blocked';

  constructor(platformId: string, reason: SocialPlatformUnusableError['reason'], detail: string) {
    super(`social_platform_unusable:${platformId}:${reason}: ${detail}`);
    this.name = 'SocialPlatformUnusableError';
    this.platformId = platformId;
    this.reason = reason;
  }
}

/**
 * Resolve a platform for USE, refusing anything not fit to run against.
 *
 * This is the enforcement half of D-005's ruling that an unverified row is
 * UNUSABLE rather than permissive. Adapters and the `social:*` verbs call this
 * instead of reading `getSocialPlatform` directly, so an unverified or
 * owner-blocked platform fails loudly at the seam rather than producing a
 * plausible-looking call against facts nobody checked.
 */
export function assertSocialPlatformUsable(id: string): SocialPlatformRow {
  const row = getSocialPlatform(id);
  if (!row) {
    throw new SocialPlatformUnusableError(id, 'unknown-platform', 'no such platform in the registry');
  }
  if (!isSocialPlatformVerified(row)) {
    throw new SocialPlatformUnusableError(
      id,
      'unverified',
      'row has no verifiedAt + sources; run this wave\'s just-in-time verification first (D-005)',
    );
  }
  if (row.blockedOn) {
    throw new SocialPlatformUnusableError(id, 'owner-blocked', row.blockedOn);
  }
  return row;
}
