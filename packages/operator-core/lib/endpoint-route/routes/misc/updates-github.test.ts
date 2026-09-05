/**
 * updates-github — the shared GitHub plumbing behind /updates/manifest,
 * /updates/download and /updates/rollback.
 *
 * WI-2144851 / security-boundary-remediation-and-usability-2026-09-04 P-007,
 * Workstream C ("verify signed updates/rollback failure cases").
 *
 * The source audit cites this file BY NAME as the credential-safe redirect
 * control: `fetchAssetResponse` deliberately uses `redirect: 'manual'` and
 * re-fetches the CDN Location WITHOUT the Authorization header, so the GitHub
 * token never leaves api.github.com. It was the only `updates-*` module in this
 * directory with no test file at all, and an uncovered control is exactly the
 * one a later "simplify to redirect: 'follow'" quietly removes.
 *
 * The failure cases below are the other half: this function documents
 * "Returns null when the asset is unreachable", and a Location header is
 * attacker-shaped input the moment api.github.com is not what we think it is.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// resolveGithubToken's two credential sources are the only reason this module
// pulls in PG/gh-CLI code. Stub them so importing the module under test cannot
// reach a real credential store; every test here drives the token explicitly.
vi.mock('../../../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'error' as const })),
}));
vi.mock('../../../credentials', () => ({
  readCredentials: vi.fn(async () => ({})),
}));

import {
  fetchAssetResponse,
  fetchAssetText,
  githubApiHeaders,
  releaseHostBase,
} from './updates-github';

const TOKEN = 'ghp_SECRET_must_never_reach_the_cdn';

type Call = { url: string; init: RequestInit | undefined };
const calls: Call[] = [];
/**
 * Responses the subject will receive, in order. A QUEUE the single fetch
 * implementation drains — deliberately not `mockResolvedValueOnce`, because a
 * queued once-value short-circuits the implementation, so the call would never
 * be recorded in `calls` and every "the bad target was never fetched"
 * assertion would pass vacuously.
 */
const queue: Response[] = [];
let mockFetch: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

/** Header lookup that is honest about HTTP header case-insensitivity. */
const headerNames = (init: RequestInit | undefined): string[] =>
  Object.keys((init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());

beforeEach(() => {
  calls.length = 0;
  queue.length = 0;
  mockFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    // Anything the test did not explicitly queue is a call we did not intend
    // to make; 500 keeps it from masquerading as a success.
    return queue.shift() ?? new Response('UNQUEUED', { status: 500 });
  });
  vi.stubGlobal('fetch', mockFetch);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
});

describe('fetchAssetResponse — the credential-safe redirect control', () => {
  it('authenticates to api.github.com but never forwards the token to the CDN', async () => {
    queue.push(
      redirectTo('https://objects.githubusercontent.com/asset?X-Amz-Signature=abc'),
      new Response('ARTIFACT_BYTES', { status: 200 }),
    );

    const res = await fetchAssetResponse(7, TOKEN);
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe('ARTIFACT_BYTES');
    expect(calls).toHaveLength(2);

    // Hop 1 — the API: authenticated, and the redirect deliberately NOT
    // auto-followed (that manual hop is the whole control).
    expect(calls[0].url).toContain('https://api.github.com/repos/');
    expect(calls[0].url).toContain('/releases/assets/7');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init?.redirect).toBe('manual');

    // Hop 2 — the pre-signed CDN URL. THIS is the audited property: S3 rejects
    // a request carrying both its query signature and an Authorization header,
    // and forwarding the token off api.github.com would hand our GitHub
    // credential to the CDN.
    expect(calls[1].url).toContain('objects.githubusercontent.com');
    expect(headerNames(calls[1].init)).not.toContain('authorization');
    // Belt and braces: the secret must not appear ANYWHERE in the CDN call,
    // whatever shape a future refactor gives the init object.
    expect(JSON.stringify(calls[1].init ?? {})).not.toContain(TOKEN);
  });

  it('CONTROL: a direct 200 is returned as-is, so the refusals below are not blanket', async () => {
    // Without this, an implementation that returned null for EVERYTHING would
    // pass every refusal case in the next block and look correct.
    queue.push(new Response('DIRECT_BYTES', { status: 200 }));

    const res = await fetchAssetResponse(7, TOKEN);
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe('DIRECT_BYTES');
    expect(calls).toHaveLength(1);
  });
});

describe('fetchAssetResponse — "Returns null when the asset is unreachable"', () => {
  it('refuses a relative Location instead of throwing', async () => {
    // RFC 9110 §10.2.2 permits a relative Location, and `fetch()` cannot parse
    // one: this threw `TypeError: Failed to parse URL from /elsewhere`,
    // contradicting this function's own documented contract. None of the three
    // call sites wraps it (updates-manifest.ts:546, updates-rollback.ts:335,
    // updates-download.ts:59), so the throw surfaced to the user as a 500 on
    // the update path rather than the honest "asset unreachable".
    queue.push(redirectTo('/elsewhere/on/the/api'));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
    expect(calls).toHaveLength(1); // the bad target was never fetched
  });

  it('refuses an unparseable Location instead of throwing', async () => {
    queue.push(redirectTo('not a url at all'));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('refuses an http:// redirect — release assets are https-only', async () => {
    // A plaintext downgrade for an artifact whose integrity we are about to
    // stake a signature check on.
    queue.push(redirectTo('http://objects.githubusercontent.com/asset'));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('refuses a file:// redirect — a Location must not reach the local disk', async () => {
    queue.push(redirectTo('file:///etc/passwd'));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null on a 3xx that carries no Location', async () => {
    queue.push(new Response(null, { status: 302 }));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null when the asset itself 404s', async () => {
    queue.push(new Response('Not Found', { status: 404 }));

    await expect(fetchAssetResponse(7, TOKEN)).resolves.toBeNull();
  });
});

describe('fetchAssetText', () => {
  it('returns the body of a reachable text asset', async () => {
    queue.push(new Response('SIGNATURE_CONTENT', { status: 200 }));

    await expect(fetchAssetText(7, TOKEN)).resolves.toBe('SIGNATURE_CONTENT');
  });

  it('returns null — never throws — when the asset is unreachable', async () => {
    // This is what lets updates-manifest/rollback treat a missing .sig as
    // "no signature" and refuse cleanly, instead of 500ing.
    queue.push(redirectTo('/relative'));

    await expect(fetchAssetText(7, TOKEN)).resolves.toBeNull();
  });

  it('returns null on a non-ok response rather than its error body', async () => {
    queue.push(new Response('Bad credentials', { status: 401 }));

    await expect(fetchAssetText(7, TOKEN)).resolves.toBeNull();
  });
});

describe('githubApiHeaders', () => {
  it('attaches the bearer token when there is one', () => {
    expect(githubApiHeaders(TOKEN)).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('omits Authorization entirely when there is no token', () => {
    // An empty-string Authorization header is not the same as no header —
    // it reads as a malformed credential rather than an anonymous request.
    expect(headerNames({ headers: githubApiHeaders(null) })).not.toContain('authorization');
  });
});

describe('releaseHostBase', () => {
  const prev = process.env.PAPERCUSP_RELEASE_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_RELEASE_HOST;
    else process.env.PAPERCUSP_RELEASE_HOST = prev;
  });

  it('is null when unconfigured, so callers fall back rather than build a bare-path URL', () => {
    delete process.env.PAPERCUSP_RELEASE_HOST;
    expect(releaseHostBase()).toBeNull();
  });

  it('strips trailing slashes so callers can concatenate a path safely', () => {
    process.env.PAPERCUSP_RELEASE_HOST = 'https://releases.papercuspai.com///';
    expect(releaseHostBase()).toBe('https://releases.papercuspai.com');
  });
});
