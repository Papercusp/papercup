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
 * ── ADDED by plan tool-contract-repair-2026-09-05, D-004 (WI-2145930, P-008) ──
 *
 * These four redirects have been correct in CONTENT the whole time. Three of them
 * nonetheless rendered as the WRONG SENTENCE, and nothing failed. `install_slug` was
 * authored
 *
 *   'this tool spells that `installSlug` (camelCase) — RENAME the key rather than …'
 *
 * and `splitLocalSchemaTarget` tests only the text BEFORE the first ` — ` against its
 * path regex. A prose head fails it, the redirect classifies CROSS-TOOL, and the caller
 * saw "`install_slug` is not an arg of this tool — it is written by this tool spells
 * that `installSlug` (camelCase)" — a caller who used the wrong key on the RIGHT tool,
 * told some other tool owns their data. Same misattribution EI-21119949290826530 fixed
 * for bare targets and EI-22179796827760943 re-reported, reintroduced one authoring
 * style at a time. Both styles are live in-tree, so "copy the nearest neighbour" is not
 * a safe rule, and the presence-only assertions this file originally carried
 * (`toMatch(/installSlug/)`) passed on the broken form — the misattributing target
 * contains the word too.
 *
 * `workspace` moved the other way, to the corrective-call (object) form, because a
 * workspace id has NO local destination to be relocated onto: the scope is ambient, so
 * the honest remedy is the same tool with the key gone, which is exactly what
 * `{ tool: 'routines:list', args: {} }` renders. The original test asserted the string
 * form; its predicate is preserved below, reading the note off either shape, and its
 * falsifiability controls still reject every half-fix they were written to reject.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/routines/list-arg-redirect.test.ts
 */
import { describe, it, expect } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import listTool from './list';

type ArgRedirect = string | { tool: string; args?: Record<string, unknown>; note?: string };

/** `.refine()` etc. wrap a ZodObject in ZodEffects, so `.shape` can be one or more
 *  `_def` hops down. Walk rather than assume today's depth, and THROW when no object
 *  shape is reachable — a guard that inspected nothing must be an error, not a pass. */
function declaredKeys(): string[] {
  let node: unknown = (listTool as unknown as { args: unknown }).args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape);
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    node = def?.schema ?? def?.innerType;
  }
  throw new Error("could not read an object shape from routines:list's args schema");
}

const redirects = ((listTool as unknown as { guidance?: { argRedirects?: Record<string, ArgRedirect> } })
  .guidance?.argRedirects ?? {}) as Record<string, ArgRedirect>;

/**
 * The exact predicate the guard enforces, extracted so a deliberately-wrong CONTROL
 * can be run through the SAME assertions. `list.ts` is a module this file imports, so
 * the falsifiability tier prescribed by CLAUDE.md is a permanent in-file control
 * rather than a mutation of the shared tree (which git-sync can commit mid-probe).
 */
function assertWorkspaceRedirect(redirect: unknown): void {
  // A corrective CALL, not a bare string: the remedy is to drop the key and re-call
  // THIS tool, and only the object form renders that. A string here would classify
  // cross-tool (no declared key can head it — the scope is ambient) and misattribute.
  expect(redirect).toBeTruthy();
  expect(typeof redirect).toBe('object');
  expect(redirect).toMatchObject({ tool: 'routines:list', args: {} });
  const note = (redirect as { note?: string }).note ?? '';

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
    assertWorkspaceRedirect(redirects.workspace);
  });

  it('control: the same predicate REJECTS a missing or half-written redirect', () => {
    // Falsifiability. Without this, the assertion above is not evidence that the
    // redirect is present and complete — a predicate that accepted anything would
    // satisfy it identically.
    expect(() => assertWorkspaceRedirect(undefined)).toThrow();

    // The half-fix most likely to be written by someone shortening this: it restates
    // the rejection without saying where the scope actually comes from.
    expect(() =>
      assertWorkspaceRedirect({
        tool: 'routines:list',
        args: {},
        note: 'this tool has no `workspace` arg — drop the key.',
      }),
    ).toThrow();

    // Explains the ambient scope but strands the caller who genuinely wanted to narrow.
    expect(() =>
      assertWorkspaceRedirect({
        tool: 'routines:list',
        args: {},
        note: 'the workspace is read ambiently from your session scope, so drop the key.',
      }),
    ).toThrow();

    // And the regression this file was extended for: reverting to the string form.
    // It would still CONTAIN both words and still read fine in source — it just
    // renders as a cross-tool misattribution.
    expect(() =>
      assertWorkspaceRedirect(
        'this tool has NO `workspace` arg — the scope is ambient; narrow with `installSlug`.',
      ),
    ).toThrow();
  });

  it('redirects the snake_case and near-miss spellings to their real args', () => {
    // The file's own comment warns that a per-field fix here "guarantees a fourth
    // instance", so the measured rename family is covered alongside `workspace`.
    expect(redirects.install_slug).toMatch(/installSlug/);
    expect(redirects.slug).toMatch(/installSlug/);
    expect(redirects.routine).toMatch(/name/);
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

describe('routines:list argRedirects RENDER as same-tool relocations (D-004)', () => {
  const declared = declaredKeys();

  it.each([
    ['install_slug', 'installSlug'],
    ['slug', 'installSlug'],
    ['routine', 'name'],
  ])('%s splits to the declared key `%s`, not a cross-tool misattribution', (key, destination) => {
    const target = redirects[key];
    expect(typeof target, `${key} must be the string (relocation) form`).toBe('string');

    const split = splitLocalSchemaTarget(target as string, declared);
    // A null split IS the defect — the redirect still "exists" and still mentions the
    // right key, it just points the caller away from the tool they are correctly on.
    // This is the assertion the `toMatch(/installSlug/)` pair above cannot make.
    expect(split, `routines:list.${key} must be authored as \`${destination} — explanation\``).not.toBeNull();
    expect(split?.path).toBe(destination);

    // The destination must be real: a redirect to a key the schema does not declare
    // would split cleanly and still send the caller to a second rejection.
    expect(declared).toContain(destination);
    // The teaching has to survive the split — it renders after the key, outside the
    // backticks, and it is the half that says what dropping the key silently costs.
    expect(split?.note.length ?? 0).toBeGreaterThan(40);
  });

  it('control: the PREVIOUS authoring style fails this predicate', () => {
    // The exact string that shipped, so the guard is demonstrably falsifiable in the
    // direction that actually occurred rather than only against nonsense.
    const shipped =
      'this tool spells that `installSlug` (camelCase) — RENAME the key rather than dropping it, or the filter is silently lost and you read every install. `harness` is its accepted compatibility alias.';
    expect(shipped).toMatch(/installSlug/); // the old assertion passes on it …
    expect(splitLocalSchemaTarget(shipped, declared)).toBeNull(); // … and the new one does not.
  });

  it('every redirected key is genuinely UNDECLARED, so no redirect is a stale lie', () => {
    // The drift events/await-arg-redirects.test.ts measured: `after_generation` became a
    // real key 22h after being filed as rejected. A redirect for a key that now works
    // misdirects silently, so pin disjointness rather than trusting the schema to hold.
    for (const key of Object.keys(redirects)) {
      expect(declared, `routines:list declares \`${key}\` — delete its redirect`).not.toContain(key);
    }
  });
});
