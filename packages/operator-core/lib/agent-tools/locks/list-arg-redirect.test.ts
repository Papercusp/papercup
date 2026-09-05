/**
 * list-arg-redirect.test.ts — EI-20206183390542424 (+ its independent re-filing
 * EI-22367587259064593).
 *
 * Measured in harness_shared.tool_invocations, all rejected with a bare
 * unrecognized-key error: `paths` 48 calls / 37 distinct agents, `mine` 18/17,
 * `harness` 12/12, `workspace` 11/10.
 *
 * What makes this tool the sharp case: its description, `when` AND `chaining` each
 * already say "omit workspace/harness" — three times in always-on prose — and 22
 * agents passed them anyway. Always-on guidance is read while CHOOSING a tool, not
 * while repairing a rejected call, so it cannot reach a caller who has already
 * guessed. argRedirects is the only channel on the FAILURE path.
 *
 * `paths` is the largest cluster and a genuine PLANE confusion rather than a typo:
 * locks:list is the resource plane, locks:queue is the file plane.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/list-arg-redirect.test.ts
 */
import { describe, it, expect } from 'vitest';
import listTool from './list';

/**
 * The exact predicate the guard enforces, extracted so a deliberately-wrong CONTROL
 * can be run through the SAME assertions. `list.ts` is a module this file imports, so
 * the falsifiability tier prescribed by CLAUDE.md is a permanent in-file control
 * rather than a mutation of the shared tree (which git-sync can commit mid-probe).
 */
function assertPathsRedirect(redirect: unknown): void {
  // A corrective CALL, not a plain string: the remedy is to switch tools (planes),
  // so a rename note would strand the caller on the wrong surface.
  expect(typeof redirect).toBe('object');
  const r = redirect as { tool?: string; args?: Record<string, unknown>; note?: string };

  expect(r.tool).toBe('locks:queue');
  // The corrective call must be runnable as printed — an array, matching queue's shape.
  expect(Array.isArray(r.args?.paths)).toBe(true);
  // Load-bearing: it must explain WHY this tool cannot answer, or the caller reads a
  // bare tool-switch as arbitrary and retries here with another spelling.
  expect(r.note ?? '').toMatch(/summary|plane/i);
}

describe('locks:list guidance.argRedirects', () => {
  it('routes a caller passing `paths` to the file plane (locks:queue)', () => {
    assertPathsRedirect(listTool.guidance?.argRedirects?.paths);
  });

  it('control: the same predicate REJECTS a missing or half-written redirect', () => {
    // Falsifiability. Without this, the assertion above is not evidence the redirect
    // is present and complete — a predicate that accepted anything would satisfy it.
    expect(() => assertPathsRedirect(undefined)).toThrow();

    // A plain-string redirect: names the right tool but gives no runnable call, the
    // half-fix most likely written by someone shortening this declaration.
    expect(() => assertPathsRedirect('use locks:queue { paths: [...] } instead')).toThrow();

    // A corrective call whose args carry a SCALAR path — it would be rejected again
    // by locks:queue's own schema, sending the caller round a second time.
    expect(() =>
      assertPathsRedirect({ tool: 'locks:queue', args: { paths: 'a/b.ts' }, note: 'file plane summary' }),
    ).toThrow();

    // Right tool, right shape, but no reason — leaves the plane distinction untaught.
    expect(() => assertPathsRedirect({ tool: 'locks:queue', args: { paths: ['a/b.ts'] } })).toThrow();
  });

  it('tells callers passing `workspace`/`harness`/`mine` to drop the key, and what to use', () => {
    // These three are DROPs, not renames: none has a counterpart on this surface.
    expect(listTool.guidance?.argRedirects?.workspace).toMatch(/workspace-global|ambient/i);
    expect(listTool.guidance?.argRedirects?.harness).toMatch(/workspace-global|NOT harness-scoped/i);
    // `mine` must name the field that actually answers it, or dropping it loses the ask.
    expect(listTool.guidance?.argRedirects?.mine).toMatch(/holders/);
  });

  it('does NOT accept the redirected keys as real args — they must stay redirects', () => {
    // Guards the failure mode where someone "fixes" the rejection by adding the key to
    // the schema, which would put a second, silently-diverging file plane on this tool.
    expect(listTool.args.safeParse({ paths: ['a/b.ts'] }).success).toBe(false);
    expect(listTool.args.safeParse({ workspace: 'papercusp-workspace' }).success).toBe(false);
    expect(listTool.args.safeParse({ harness: 'papercusp' }).success).toBe(false);
    expect(listTool.args.safeParse({ mine: true }).success).toBe(false);
  });

  it('calibration: the documented narrowing args really do parse', () => {
    // Without this the rejections above are not evidence about those keys specifically
    // — a schema that rejected everything would satisfy them just as well.
    expect(listTool.args.safeParse({ resource: 'git-sync:papercusp' }).success).toBe(true);
    expect(listTool.args.safeParse({ q: 'git-sync', limit: 20 }).success).toBe(true);
  });
});
