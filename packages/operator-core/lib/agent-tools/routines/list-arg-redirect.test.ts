/**
 * list-arg-redirect.test.ts — EI-20206183390542424 (+ its independent re-filing
 * EI-22367587259064593, three weeks later by a different agent).
 *
 * `routines:list` reads its workspace AMBIENTLY (activeWorkspaceId()), so a caller
 * reasoning from the catalog's workspace-scoped tools guesses a `workspace` parameter
 * that has no counterpart here and gets a bare unrecognized-key rejection.
 *
 * Measured in harness_shared.tool_invocations: 13 calls from 11 DISTINCT agents.
 * The rejection already names the accepted keys verbatim ("this tool accepts ONLY:
 * installSlug, harness, name, q, group, rollup") and they re-offend anyway — because
 * the key was never a typo. Naming the accepted keys cannot teach where the scope
 * comes from; only saying so can, and argRedirects is the only channel that reaches
 * the caller on the FAILURE path.
 *
 * Same borrowed-shape family as `mode` on locks:acquire (EI-21988514956470475) and
 * `path` on locks:queue (EI-20206554322712742); this pins THIS tool's declaration,
 * matching locks/queue-arg-redirect.test.ts.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/routines/list-arg-redirect.test.ts
 */
import { describe, it, expect } from 'vitest';
import listTool from './list';

/**
 * The exact predicate the guard enforces, extracted so a deliberately-wrong CONTROL
 * can be run through the SAME assertions. `list.ts` is a module this file imports, so
 * the falsifiability tier prescribed by CLAUDE.md is a permanent in-file control
 * rather than a mutation of the shared tree (which git-sync can commit mid-probe).
 */
function assertWorkspaceRedirect(redirect: unknown): void {
  // A plain string, not a corrective call: the remedy is to DROP the key, not to
  // switch tools — the caller already picked the right one.
  expect(typeof redirect).toBe('string');
  const note = redirect as string;

  // Load-bearing: it must say the scope is already ambient, not merely that the key
  // is wrong. "Unrecognized key" already conveys the latter and demonstrably does not
  // stop the retry.
  expect(note).toMatch(/ambient/i);
  // It must leave the caller with a way to narrow, or a dropped key reads as a lost
  // filter and the next guess is another undeclared one.
  expect(note).toMatch(/installSlug/);
}

describe('routines:list guidance.argRedirects', () => {
  it('tells a caller passing `workspace` that scope is ambient, and how to narrow', () => {
    assertWorkspaceRedirect(listTool.guidance?.argRedirects?.workspace);
  });

  it('control: the same predicate REJECTS a missing or half-written redirect', () => {
    // Falsifiability. Without this, the assertion above is not evidence that the
    // redirect is present and complete — a predicate that accepted anything would
    // satisfy it identically.
    expect(() => assertWorkspaceRedirect(undefined)).toThrow();

    // The half-fix most likely to be written by someone shortening this string: it
    // restates the rejection without saying where the scope actually comes from.
    expect(() => assertWorkspaceRedirect('this tool has no `workspace` arg — drop the key.')).toThrow();

    // Explains the ambient scope but strands the caller who genuinely wanted to narrow.
    expect(() =>
      assertWorkspaceRedirect('the workspace is read ambiently from your session scope, so drop the key.'),
    ).toThrow();
  });

  it('redirects the snake_case and near-miss spellings to their real args', () => {
    // The file's own comment warns that a per-field fix here "guarantees a fourth
    // instance", so the measured rename family is covered alongside `workspace`.
    expect(listTool.guidance?.argRedirects?.install_slug).toMatch(/installSlug/);
    expect(listTool.guidance?.argRedirects?.slug).toMatch(/installSlug/);
    expect(listTool.guidance?.argRedirects?.routine).toMatch(/name/);
  });

  it('does NOT accept `workspace` as a real arg — the redirect must stay a redirect', () => {
    // Guards the failure mode where someone "fixes" the rejection by adding the key to
    // the schema, which would advertise a cross-workspace read this tool cannot do.
    expect(listTool.args.safeParse({ workspace: 'papercusp-workspace' }).success).toBe(false);
  });

  it('calibration: the documented narrowing args really do parse', () => {
    // Without this the rejection above is not evidence about `workspace` specifically —
    // a schema that rejected everything would satisfy it just as well.
    expect(listTool.args.safeParse({ installSlug: 'papercusp' }).success).toBe(true);
    expect(listTool.args.safeParse({ limit: 10 }).success).toBe(true);
  });
});
