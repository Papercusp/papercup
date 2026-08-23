/**
 * LinkedIn write-adapter tests (P-021).
 *
 * The suite is organised around the three ways this adapter can hurt someone,
 * because they are not the usual ones:
 *  1. Publishing a DUPLICATE post by following LinkedIn's own retry advice.
 *  2. Claiming a reply capability the self-serve grant does not include.
 *  3. Silently widening a narrow visibility request on the owner's real
 *     professional identity.
 * Everything else here is ordinary coverage.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OutboundContext } from '../../capability-verbs/resolve';
import type { SocialDeleteRequest, SocialPostRequest } from '../../capability-verbs/social';
import {
  createLinkedInWriteAdapter,
  linkedinVisibility,
  LinkedInWriteRefused,
  LinkedInWriteUnconfirmed,
} from './linkedin-write-adapter';
import {
  assertLinkedInCredential,
  linkedinAuthorUrn,
  linkedinCreatedId,
  linkedinCreateRetryable,
  linkedinDeleteRetryable,
  linkedinEncodeUrn,
  linkedinTokenExpired,
  LINKEDIN_API_HOST,
  LINKEDIN_OAUTH_HOST,
  LINKEDIN_SCOPE_WRITE_MEMBER,
  type LinkedInCredential,
} from './linkedin-common';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

function credential(overrides: Partial<LinkedInCredential> = {}): LinkedInCredential {
  return {
    accessToken: 'token-abc',
    memberId: 'A8xe03Qt10',
    scopes: ['openid', 'profile', LINKEDIN_SCOPE_WRITE_MEMBER],
    ...overrides,
  };
}

/** A Response stand-in carrying real Headers so casing is exercised, not mocked away. */
function response(
  status: number,
  init: { headers?: Record<string, string>; body?: string } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async () => init.body ?? '',
  } as unknown as Response;
}

function adapterWith(fetchImpl: typeof globalThis.fetch, cred: LinkedInCredential = credential()) {
  return createLinkedInWriteAdapter({ credential: cred, fetch: fetchImpl, now: () => NOW });
}

const CONTEXT = {} as OutboundContext;

function postRequest(overrides: Partial<SocialPostRequest> = {}): SocialPostRequest {
  return {
    destination: 'me',
    text: 'Hello from Papercusp',
    visibility: 'public',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

describe('linkedin write adapter', () => {
  describe('the reply capability it deliberately does not have', () => {
    it('exposes NO reply method, so a reply is a platform limitation and not an adapter defect', () => {
      // THE load-bearing assertion of this file. LinkedIn's self-serve grant is
      // w_member_social, whose own description says "Post, comment and like" —
      // but the Comments API declares w_member_social_feed, which is not
      // self-serve. If someone later adds a reply method on the strength of
      // that description, this fails and points them at the citation.
      const adapter = adapterWith(vi.fn());
      expect(adapter.reply).toBeUndefined();
    });

    it('still implements the two verbs the grant does cover', () => {
      const adapter = adapterWith(vi.fn());
      expect(typeof adapter.post).toBe('function');
      expect(typeof adapter.delete).toBe('function');
    });
  });

  describe('create: the duplicate-post hazard', () => {
    it('refuses to treat ANY status as auto-retryable, including the ones LinkedIn says to retry', () => {
      // The vendor's error table says of 409: "A write conflict occurred.
      // Retry the request." 500 and 503 carry the same advice. Post creation
      // has no idempotency key, so following it publishes a second post.
      for (const status of [409, 500, 503, 429, 400, 403]) {
        expect(linkedinCreateRetryable(status), `status ${status}`).toBe(false);
      }
    });

    it('reports a 409 as UNCONFIRMED rather than failed, because the post may exist', async () => {
      const fetchImpl = vi.fn(async () => response(409, { body: 'CONFLICT' }));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);

      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toBeInstanceOf(LinkedInWriteUnconfirmed);
      // Exactly one call — the adapter must not have retried internally.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports a 5xx as UNCONFIRMED, since it may have published before failing to say so', async () => {
      const fetchImpl = vi.fn(async () => response(503));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toBeInstanceOf(LinkedInWriteUnconfirmed);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports a transport failure as UNCONFIRMED, never as a clean failure', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('socket hang up');
      });
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toBeInstanceOf(LinkedInWriteUnconfirmed);
    });

    it('reports a 201 WITHOUT an id header as UNCONFIRMED — there is no read scope to check with', async () => {
      const fetchImpl = vi.fn(async () => response(201));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toBeInstanceOf(LinkedInWriteUnconfirmed);
    });

    it('treats a 429 as a clean REFUSAL — the call was rejected, so nothing was published', async () => {
      const fetchImpl = vi.fn(async () => response(429));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      // Distinct from the ambiguous cases above: a throttled request never
      // reached the publish path, so it is safe to call this a failure.
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toBeInstanceOf(LinkedInWriteRefused);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('create: the happy path and its request shape', () => {
    it('posts one call to /rest/posts with the versioned headers and returns the issued urn', async () => {
      const fetchImpl = vi.fn(async () =>
        response(201, { headers: { 'x-restli-id': 'urn:li:share:6844785523593134080' } }),
      );
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);

      const outcome = await adapter.post!(postRequest(), CONTEXT);

      expect(outcome.externalId).toBe('urn:li:share:6844785523593134080');
      expect(outcome.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080/');

      // ONE call: LinkedIn is not a container+publish platform like Threads.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://${LINKEDIN_API_HOST}/rest/posts`);
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
      expect(headers['LinkedIn-Version']).toMatch(/^\d{6}$/);

      const body = JSON.parse(init.body as string);
      expect(body.author).toBe('urn:li:person:A8xe03Qt10');
      expect(body.commentary).toBe('Hello from Papercusp');
      expect(body.lifecycleState).toBe('PUBLISHED');
    });

    it('sends text-only with no media field — LinkedIn is text-primary (D-032)', async () => {
      const fetchImpl = vi.fn(async () => response(201, { headers: { 'x-restli-id': 'urn:li:share:1' } }));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await adapter.post!(postRequest(), CONTEXT);
      const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      // The Instagram inheritance that would be wrong: no media assertion, and
      // no empty `content` key inviting one.
      expect(body).not.toHaveProperty('content');
    });

    it('finds the id header whatever case LinkedIn spells it in', () => {
      // LinkedIn's own docs disagree with themselves: the consumer page says
      // `X-RestLi-Id`, the versioned page says `x-restli-id`.
      expect(linkedinCreatedId(new Headers({ 'X-RestLi-Id': 'urn:li:share:1' }))).toBe('urn:li:share:1');
      expect(linkedinCreatedId(new Headers({ 'x-restli-id': 'urn:li:ugcPost:2' }))).toBe('urn:li:ugcPost:2');
      expect(linkedinCreatedId(new Headers({}))).toBeNull();
    });
  });

  describe('visibility: refusing rather than approximating', () => {
    it('maps the two audiences LinkedIn actually has', () => {
      expect(linkedinVisibility('public')).toBe('PUBLIC');
      expect(linkedinVisibility('followers')).toBe('CONNECTIONS');
    });

    it('REFUSES a visibility with no LinkedIn equivalent instead of widening it', () => {
      // Silently promoting 'direct' to PUBLIC would broadcast to the owner's
      // real professional network something explicitly asked to stay narrow.
      expect(() => linkedinVisibility('direct')).toThrow(LinkedInWriteRefused);
      expect(() => linkedinVisibility('unlisted')).toThrow(LinkedInWriteRefused);
    });

    it('refuses before spending a request from the 150/day member budget', async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await expect(adapter.post!(postRequest({ visibility: 'direct' }), CONTEXT)).rejects.toThrow(
        LinkedInWriteRefused,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('delete: idempotent, and honest about what 204 proves', () => {
    function deleteRequest(postUrn = 'urn:li:share:6844785523593134080'): SocialDeleteRequest {
      return {
        ref: { platform: 'linkedin', destination: 'me', id: postUrn } as unknown as SocialDeleteRequest['ref'],
        target: { platform: 'linkedin', postUrn },
        idempotencyKey: 'del-1',
      };
    }

    it('reports deleted:true on 204 but does NOT claim the post existed beforehand', async () => {
      const fetchImpl = vi.fn(async () => response(204));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      const outcome = await adapter.delete!(deleteRequest(), CONTEXT);
      expect(outcome.deleted).toBe(true);
      // An already-deleted post ALSO returns 204, so the detail must say so
      // rather than letting a caller read this as "I removed it".
      expect(outcome.detail).toMatch(/already-deleted|idempotent/i);
    });

    it('reports deleted:false on 404 as a first-class outcome, not a failure', async () => {
      const fetchImpl = vi.fn(async () => response(404));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      const outcome = await adapter.delete!(deleteRequest(), CONTEXT);
      expect(outcome.deleted).toBe(false);
    });

    it('DOES allow delete retries, unlike create — the asymmetry is the vendor\'s', () => {
      // "Post deletions are idempotent." A retried delete cannot produce a
      // second visible artefact, so the transient classes are safe here.
      expect(linkedinDeleteRetryable(500)).toBe(true);
      expect(linkedinDeleteRetryable(503)).toBe(true);
      // …but never retry INTO a throttle.
      expect(linkedinDeleteRetryable(429)).toBe(false);
    });

    it('percent-encodes the urn so rest.li cannot parse it as routing structure', async () => {
      const fetchImpl = vi.fn(async () => response(204));
      const adapter = adapterWith(fetchImpl as unknown as typeof globalThis.fetch);
      await adapter.delete!(deleteRequest('urn:li:share:123'), CONTEXT);
      const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('urn%3Ali%3Ashare%3A123');
      expect(url).not.toContain('urn:li:share:123');
    });

    it('escapes the parentheses and commas a composite urn carries', () => {
      // encodeURIComponent alone leaves ( ) unescaped, and every comment urn is
      // composite — the exact shape a future reply/delete-a-comment path needs.
      const encoded = linkedinEncodeUrn('urn:li:comment:(urn:li:activity:1,2)');
      expect(encoded).not.toContain('(');
      expect(encoded).not.toContain(')');
      expect(encoded).toContain('%28');
      expect(encoded).toContain('%29');
    });
  });

  describe('credential preflight', () => {
    it('refuses a token missing w_member_social before any network call', async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWith(
        fetchImpl as unknown as typeof globalThis.fetch,
        credential({ scopes: ['openid', 'profile'] }),
      );
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toThrow(/scope-missing/);
      // A 403 would be indistinguishable from other causes AND would still cost
      // one of the 150 daily member requests.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses an EXPIRED token as a re-authorisation request, not a transient error', async () => {
      const fetchImpl = vi.fn();
      const adapter = adapterWith(
        fetchImpl as unknown as typeof globalThis.fetch,
        credential({ expiresAtMs: NOW - 1 }),
      );
      // Programmatic refresh is partner-only, so retrying can never help.
      await expect(adapter.post!(postRequest(), CONTEXT)).rejects.toThrow(/token-expired/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('treats a token expiring in the future as usable', () => {
      expect(linkedinTokenExpired(credential({ expiresAtMs: NOW + 1000 }), NOW)).toBe(false);
      expect(linkedinTokenExpired(credential({ expiresAtMs: NOW }), NOW)).toBe(true);
      // No expiry recorded is not the same as expired.
      expect(linkedinTokenExpired(credential(), NOW)).toBe(false);
    });

    it('accepts a valid credential', () => {
      expect(() => assertLinkedInCredential(credential())).not.toThrow();
    });
  });

  describe('author urn construction', () => {
    it('builds a person urn from a bare member id', () => {
      expect(linkedinAuthorUrn('A8xe03Qt10')).toBe('urn:li:person:A8xe03Qt10');
    });

    it('does not double the prefix when handed something already a urn', () => {
      // Produces INVALID_URN_ID at LinkedIn — a confusing error for a trivial cause.
      expect(linkedinAuthorUrn('urn:li:person:A8xe03Qt10')).toBe('urn:li:person:A8xe03Qt10');
    });
  });

  describe('host split', () => {
    it('keeps the OAuth host distinct from the API host', () => {
      // Most platforms here serve both from one host, so assuming that for
      // LinkedIn silently breaks token exchange. Verified against the published
      // OIDC discovery document, which names both in one object.
      expect(LINKEDIN_OAUTH_HOST).toBe('www.linkedin.com');
      expect(LINKEDIN_API_HOST).toBe('api.linkedin.com');
      expect(LINKEDIN_OAUTH_HOST).not.toBe(LINKEDIN_API_HOST);
    });
  });
});
