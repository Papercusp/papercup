/**
 * Property-based invariant for the Defguard `deviceUsername` slug sanitizer
 * (defguard-client.ts). Per CLAUDE.md §"Property-based tests", slug rewrites are
 * a named site — examples undercount the input space, and an unsafe char that
 * slips through one hand-picked deviceId becomes an injection into the Defguard
 * admin API path `/api/v1/user/<username>/…`.
 *
 * `deviceUsername` is module-private, so the slug is observed through the
 * smallest public surface that emits it: `revokeDefguardUser` issues a single
 * `DELETE /api/v1/user/<username>` — we capture that URL (fetch mocked) and pull
 * the username segment back out.
 *
 * Invariants over an ARBITRARY deviceId:
 *   1. The username is always `pcusp-<sanitized>` where `<sanitized>` contains
 *      ONLY [A-Za-z0-9-] — no `/`, `.`, space, `:`, unicode, etc. can leak into
 *      the request path. (`pcusp-` itself is safe; the `-` is allowed.)
 *   2. The sanitized tail is exactly the first 12 chars of the deviceId with
 *      every char outside [A-Za-z0-9-] removed — so it never *adds* chars and
 *      never lengthens beyond 12.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function okRes(): Response {
  return { ok: true, status: 200, text: async () => '' } as unknown as Response;
}

const ORIGINAL_TOKEN = process.env.DEFGUARD_API_TOKEN;
const ORIGINAL_URL = process.env.DEFGUARD_URL;

// Load the module once, with a token set + a fixed control URL, so revoke
// actually fetches and the URL is fully predictable.
let revokeDefguardUser: (deviceId: string) => Promise<void>;

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okRes());
  vi.stubGlobal('fetch', fetchMock);
  process.env.DEFGUARD_API_TOKEN = 'property-test-token';
  process.env.DEFGUARD_URL = 'https://mesh.test';
  delete process.env.DEFGUARD_CONTROL_URL;
  vi.resetModules();
  ({ revokeDefguardUser } = await import('./defguard-client'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (ORIGINAL_TOKEN === undefined) delete process.env.DEFGUARD_API_TOKEN;
  else process.env.DEFGUARD_API_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.DEFGUARD_URL;
  else process.env.DEFGUARD_URL = ORIGINAL_URL;
});

const BASE = 'https://mesh.test/api/v1/user/';

/** Pull the username segment out of the captured DELETE URL. */
function usernameFromLastCall(): string {
  const url = fetchMock.mock.calls.at(-1)?.[0] as string;
  expect(url.startsWith(BASE)).toBe(true);
  return url.slice(BASE.length);
}

describe('deviceUsername slug — properties (via revokeDefguardUser URL)', () => {
  it('always yields pcusp-<only [A-Za-z0-9-]> — no unsafe char leaks into the path', () => {
    return fc.assert(
      fc.asyncProperty(fc.string(), async (deviceId) => {
        fetchMock.mockClear();
        await revokeDefguardUser(deviceId);
        const username = usernameFromLastCall();
        // The whole username is pcusp- followed by safe chars only.
        expect(username).toMatch(/^pcusp-[A-Za-z0-9-]*$/);
      }),
      { numRuns: 400 },
    );
  });

  it('the sanitized tail equals first-12-chars with unsafe chars stripped (no added/extra chars)', () => {
    return fc.assert(
      fc.asyncProperty(fc.string(), async (deviceId) => {
        fetchMock.mockClear();
        await revokeDefguardUser(deviceId);
        const username = usernameFromLastCall();
        const tail = username.slice('pcusp-'.length);
        const expected = deviceId.slice(0, 12).replace(/[^a-zA-Z0-9-]/g, '');
        expect(tail).toBe(expected);
        // Sanitizing only removes — never lengthens past the 12-char window.
        expect(tail.length).toBeLessThanOrEqual(12);
      }),
      { numRuns: 400 },
    );
  });

  it('full unicode / punctuation deviceIds still produce a path-safe username', () => {
    return fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (deviceId) => {
        fetchMock.mockClear();
        await revokeDefguardUser(deviceId);
        const username = usernameFromLastCall();
        expect(username).toMatch(/^pcusp-[A-Za-z0-9-]*$/);
        // URL-encoding the username must be a no-op — it is already path-safe.
        expect(encodeURIComponent(username)).toBe(username);
      }),
      { numRuns: 300 },
    );
  });
});
