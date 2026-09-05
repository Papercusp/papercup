/**
 * queue-arg-redirect.test.ts — EI-20206554322712742.
 *
 * `locks:queue` filters on `paths` (an ARRAY); a caller inspecting ONE file reached
 * for the intuitive scalar `path` and got a bare Zod unrecognized-key rejection.
 * The filed item called this a "prompt/schema mismatch", but no prompt pairs `path`
 * with locks:queue — every prompt in the tree writes `locks:queue { paths: [...] }`,
 * so there is nothing for a doc edit to repair. The guess is instead a reasonable
 * generalisation from a REAL sibling signature: locks:acquire_granular genuinely
 * takes a scalar `path`. Same borrowed-shape family as `mode` on locks:acquire
 * (EI-21988514956470475) and `coordination_domain` (EI-21104703429792156), and the
 * caller who needs the correction is on the FAILURE path, which only `argRedirects`
 * reaches.
 *
 * Pins the redirect so a future edit cannot drop it silently. The RENDERING of
 * argRedirects into the rejection message is covered generically by tooldef's
 * strict-args.test.ts ("unknownArgHint argRedirects"); this pins THIS tool's
 * declaration, matching locks/acquire-arg-redirect.test.ts.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/queue-arg-redirect.test.ts
 */
import { describe, it, expect } from 'vitest';
import queueTool from './queue';

/**
 * The exact predicate the guard enforces, extracted so a deliberately-wrong CONTROL
 * can be run through the SAME assertions. `queue.ts` is a module this file imports,
 * so the falsifiability tier prescribed by CLAUDE.md is a permanent in-file control
 * rather than a mutation of the shared tree (which git-sync can commit mid-probe).
 */
function assertPathRedirect(redirect: unknown): void {
  // A plain string, not a corrective call: the remedy is to rename the key, not to
  // switch tools — the caller already picked the right one (acquire's `reason`
  // redirect is the same rename shape).
  expect(typeof redirect).toBe('string');
  const note = redirect as string;

  expect(note).toMatch(/paths/);
  expect(note).toMatch(/rename/i);

  // The load-bearing correction, and what makes this a rename rather than a drop:
  // dropping the key does NOT error, it silently widens a one-file question into an
  // unfiltered workspace-wide read that returns rows and so reads as success.
  expect(note).toMatch(/silently widen|widens/i);

  // And where a singular `path` genuinely does live, so the caller who really wanted
  // that tool is not left inferring the capability is absent.
  expect(note).toContain('locks:acquire_granular');

  // The adjacent trap a caller hits next: the empty array fails closed.
  expect(note).toMatch(/paths:\s*\[\]/);
}

describe('locks:queue guidance.argRedirects', () => {
  it('tells a caller passing `path` to RENAME it to the `paths` array', () => {
    assertPathRedirect(queueTool.guidance?.argRedirects?.path);
  });

  it('control: the same predicate REJECTS a missing or half-written redirect', () => {
    // Falsifiability. Without this, the assertions above are not evidence that the
    // redirect is present and complete — a predicate that accepted anything would
    // satisfy them identically.
    expect(() => assertPathRedirect(undefined)).toThrow();

    // A redirect that names the rename but drops the silent-widening consequence —
    // the half-fix most likely to be written by someone shortening this string.
    expect(() => assertPathRedirect('rename `path` to `paths` and pass an array')).toThrow();

    // A redirect that explains the widening but strands the caller who actually
    // wanted the scalar-`path` sibling.
    expect(() =>
      assertPathRedirect(
        'rename to `paths`: dropping it silently widens the read to every row. paths: [] matches nothing.',
      ),
    ).toThrow();
  });

  it('does NOT accept `path` as a real arg — the redirect must stay a redirect', () => {
    // Guards the failure mode where someone "fixes" the rejection by adding the key to
    // the schema, which would leave two spellings of one filter silently diverging.
    const parsed = queueTool.args.safeParse({
      path: 'packages/operator-core/lib/agent-tools/locks/queue.ts',
    });
    expect(parsed.success).toBe(false);
  });

  it('calibration: the documented `paths` array form really does parse', () => {
    // Without this the rejection above is not evidence about `path` specifically — a
    // schema that rejected everything would satisfy it just as well.
    const parsed = queueTool.args.safeParse({
      paths: ['packages/operator-core/lib/agent-tools/locks/queue.ts'],
    });
    expect(parsed.success).toBe(true);
  });
});
