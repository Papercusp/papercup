/**
 * Property-based tests for the self-rolled HS256 mobile device JWTs
 * (`signDeviceToken` / `verifyDeviceToken` in device-jwt.ts).
 *
 * Per CLAUDE.md §"Property-based tests": auth token validators are a named
 * site — examples undercount the input space, and a forgery that slips
 * through one hand-picked example is a security hole. Two invariants:
 *
 *   1. Round-trip: for ANY well-formed claims, sign→verify returns the same
 *      claims (sub / workspace_id / device_kind / user_email preserved).
 *   2. Unforgeability: ANY single-byte mutation of a valid token is rejected
 *      (verify returns null). The HMAC is computed over the *encoded*
 *      `header.payload` string, so touching the header or payload changes the
 *      MAC input and the recomputed sig no longer matches; touching the sig
 *      mismatches directly; turning a char into (or out of) a `.` breaks the
 *      3-part split. There is no single-byte edit that still verifies.
 *
 * The secret must be set BEFORE importing the module — getSecret() caches
 * `process.env.MOBILE_JWT_SECRET` on first use (and requires length >= 32).
 */
import fc from 'fast-check';
import { describe, expect, it, beforeAll } from 'vitest';

// 32+ chars so getSecret() accepts it instead of deriving a dev-random one.
beforeAll(() => {
  process.env.MOBILE_JWT_SECRET = 'property-test-secret-must-be-32+-chars-long';
});

const mod = await import('./device-jwt');
const { signDeviceToken, verifyDeviceToken } = mod;

// base64url alphabet — used to pick a guaranteed-different replacement byte
// so a "mutation" is always an actual change, never a no-op.
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('device-jwt — properties', () => {
  it('sign→verify round-trips arbitrary claims to the same values', () => {
    fc.assert(
      fc.property(
        fc.record({
          sub: fc.string(),
          workspace_id: fc.string(),
          // user_email is optional in DeviceClaims — exercise both present/absent.
          user_email: fc.option(fc.string(), { nil: undefined }),
        }),
        ({ sub, workspace_id, user_email }) => {
          const partial = {
            sub,
            workspace_id,
            device_kind: 'mobile' as const,
            ...(user_email === undefined ? {} : { user_email }),
          };
          const token = signDeviceToken(partial);
          const decoded = verifyDeviceToken(token);
          expect(decoded).not.toBeNull();
          expect(decoded?.sub).toBe(sub);
          expect(decoded?.workspace_id).toBe(workspace_id);
          expect(decoded?.device_kind).toBe('mobile');
          expect(decoded?.user_email).toBe(user_email);
          // exp is in the future for a freshly signed token.
          expect(decoded!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every single-byte mutation of a valid token is rejected (no forgery)', () => {
    fc.assert(
      fc.property(
        fc.record({ sub: fc.string(), workspace_id: fc.string() }),
        // Position picked relative to token length inside the predicate.
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        ({ sub, workspace_id }, posFraction) => {
          const token = signDeviceToken({
            sub,
            workspace_id,
            device_kind: 'mobile',
          });
          // Sanity: the unmutated token verifies.
          expect(verifyDeviceToken(token)).not.toBeNull();

          const i = Math.min(token.length - 1, Math.floor(posFraction * token.length));
          const orig = token[i];
          // Pick a replacement guaranteed different from the original char.
          let repl = B64URL[0];
          if (repl === orig) repl = B64URL[1];
          const mutated = token.slice(0, i) + repl + token.slice(i + 1);

          expect(mutated).not.toBe(token);
          // A single-byte edit must NEVER produce a token that verifies.
          expect(verifyDeviceToken(mutated)).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('flipping any one of the three segments invalidates the token', () => {
    // Targeted complement to the random-position test: explicitly mutate the
    // first byte of header, payload, and signature respectively.
    fc.assert(
      fc.property(fc.string(), fc.string(), (sub, workspace_id) => {
        const token = signDeviceToken({ sub, workspace_id, device_kind: 'mobile' });
        const [header, payload, sig] = token.split('.');
        const bump = (s: string) => (s[0] === B64URL[0] ? B64URL[1] : B64URL[0]) + s.slice(1);

        expect(verifyDeviceToken(`${bump(header)}.${payload}.${sig}`)).toBeNull();
        expect(verifyDeviceToken(`${header}.${bump(payload)}.${sig}`)).toBeNull();
        expect(verifyDeviceToken(`${header}.${payload}.${bump(sig)}`)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('truncating or extending the part count is rejected', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (sub, workspace_id) => {
        const token = signDeviceToken({ sub, workspace_id, device_kind: 'mobile' });
        const [header, payload, sig] = token.split('.');
        // 2 parts, 4 parts — both fail the `parts.length !== 3` guard.
        expect(verifyDeviceToken(`${header}.${payload}`)).toBeNull();
        expect(verifyDeviceToken(`${header}.${payload}.${sig}.${sig}`)).toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});
