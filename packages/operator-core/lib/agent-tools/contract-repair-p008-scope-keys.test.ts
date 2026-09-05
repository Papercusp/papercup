/**
 * contract-repair-p008-scope-keys.test.ts — plan tool-contract-repair-2026-09-05,
 * P-008 harness/scope-key cluster (WI-2145930).
 *
 * ONE shape, filed against seven different tools: a caller forwards the scope they are
 * holding — `harness`, `workspace`, `fleet`, `plan`, `work_item`, `installSlug` — to a
 * tool that declares no such selector. The bare Zod rejection names the accepted keys
 * and stops, which reads as "this tool cannot be scoped at all"; the measured next moves
 * were to drop the semantics (retry with `sha` only), to hand-write SQL, or to file the
 * refusal as schema/doc DRIFT. The remedy is `argRedirects`, which is the only surface
 * on the FAILURE path — where the caller is actually holding the rejected key — and
 * which costs nothing against the per-tool prompt-weight budget (D-002).
 *
 * WHAT THIS FILE PINS, and why each assertion is not ceremony:
 *
 *  1. DISJOINTNESS — every redirected key must still be UNDECLARED. A redirect is
 *     code-describing metadata about the schema beside it (derived-truth ladder rung 2),
 *     and events/await-arg-redirects.test.ts already measured this drifting the wrong
 *     way: `after_generation` became a real key 22 hours after being filed as rejected.
 *     A redirect for a key that now works actively misdirects, and nothing else fails.
 *
 *  2. THE RENDER, not the presence (D-004). A target authored as prose-then-key still
 *     "exists", but `splitLocalSchemaTarget` tests only the text BEFORE the first ` — `
 *     against the path regex, so a prose head classifies CROSS-TOOL and renders
 *     "`x` is not an arg of this tool — it is written by <the whole sentence>" — telling
 *     a caller who used the wrong key on the RIGHT tool that some other tool owns their
 *     data. Both authoring styles are live in-tree, so copying a neighbour is not safe;
 *     a presence-only assertion passes on a mis-authored target.
 *
 *  3. THE ZERO-KEY FLOOR. `db:check_drift` and `fleet:list` declare `z.object({})`, and
 *     `unknownArgHint` early-returns '' on `keys.length === 0` — so for those two a
 *     string target could never render AT ALL, whatever its shape. The corrective-call
 *     (object) form is mandatory there because it routes through
 *     buildCorrectedCall/correctedCallHint instead, which has no such floor. The
 *     zero-key assertions below are what make that reasoning falsifiable: if either tool
 *     ever gains a declared key, the constraint changes and this file says so.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/contract-repair-p008-scope-keys.test.ts
 */
import { describe, expect, it } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';

import checkDriftTool from './db/check_drift';
import fleetListTool from './fleet_registry/list';
import getClaimSpecTool from './scheduler/get_claim_spec';
import runningTool from './scheduler/running';
import pipelinePositionTool from './dev/pipeline_position';
import factsListTool from './facts/list';
import loopEndTool from './loop/end';
import { gitSyncAwaitTool } from './events/sugar';

type ArgRedirect = string | { tool: string; args?: Record<string, unknown>; note?: string };
type ToolLike = {
  args: unknown;
  guidance?: { argRedirects?: Record<string, ArgRedirect> };
};

/**
 * D-008: `.refine()`/`.superRefine()`/`.preprocess()` wrap a ZodObject in ZodEffects, so
 * `.shape` is UNDEFINED on those tools and any `shape`-based assertion passes vacuously
 * (`scheduler:get_claim_spec` and `dev:pipeline_position` are both in that state here —
 * get_claim_spec via a top-level `.refine`). Walk the effect chain, and THROW rather
 * than return [] when no object shape is reachable: a guard that inspected nothing must
 * be an error, never a pass.
 */
function declaredKeys(tool: ToolLike, label: string): string[] {
  let node: unknown = tool.args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape);
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    node = def?.schema ?? def?.innerType;
  }
  throw new Error(`could not read an object shape from ${label}'s args schema`);
}

function redirects(tool: ToolLike): Record<string, ArgRedirect> {
  return tool.guidance?.argRedirects ?? {};
}

/** Every redirected key must be one the schema genuinely refuses (assertion 1). */
function expectRedirectsStayRedirects(tool: ToolLike, label: string, keys: readonly string[]) {
  const declared = declaredKeys(tool, label);
  for (const key of keys) {
    expect(redirects(tool), `${label} must declare an argRedirect for \`${key}\``).toHaveProperty(key);
    expect(declared, `${label} declares \`${key}\` — the redirect is now a lie, delete it`).not.toContain(key);
  }
}

/** A corrective-call redirect: object form, naming a tool and concrete args (assertion 3). */
function expectCorrectiveCall(
  tool: ToolLike,
  label: string,
  key: string,
  expected: { tool: string; args: Record<string, unknown> },
) {
  const redirect = redirects(tool)[key];
  expect(typeof redirect, `${label}.${key} must be the object (corrective-call) form`).toBe('object');
  expect(redirect).toMatchObject(expected);
  const note = (redirect as { note?: string }).note ?? '';
  expect(note.length, `${label}.${key} must carry a note — the call alone does not say WHY`).toBeGreaterThan(40);
  return note;
}

/** A same-tool relocation: `declaredKey — explanation`, split-verified (assertion 2). */
function expectLocalRename(tool: ToolLike, label: string, key: string, destination: string) {
  const target = redirects(tool)[key];
  expect(typeof target, `${label}.${key} must be the string (same-tool relocation) form`).toBe('string');
  const split = splitLocalSchemaTarget(target as string, declaredKeys(tool, label));
  // A null split IS the D-004 defect: it renders as a cross-tool misattribution.
  expect(split, `${label}.${key} must be authored as \`${destination} — explanation\``).not.toBeNull();
  expect(split?.path).toBe(destination);
  expect(split?.note.length, `${label}.${key} note must explain, not just rename`).toBeGreaterThan(40);
  return split as { path: string; note: string };
}

describe('P-008 zero-key tools use the corrective-call form (the string form cannot render)', () => {
  it('db:check_drift declares NO args, so `harness`/`workspace` need object redirects', () => {
    // The premise of the object form. If this ever becomes non-empty the constraint is
    // gone and the redirects below should be reconsidered as `declaredKey — …` strings.
    expect(declaredKeys(checkDriftTool as ToolLike, 'db:check_drift')).toEqual([]);
    expectRedirectsStayRedirects(checkDriftTool as ToolLike, 'db:check_drift', ['harness', 'workspace']);

    const harnessNote = expectCorrectiveCall(checkDriftTool as ToolLike, 'db:check_drift', 'harness', {
      tool: 'db:check_drift',
      args: {},
    });
    // The load-bearing half: not "wrong key" but "there is nothing here to scope",
    // plus where the narrowing the caller wanted actually lives (in the RESULT).
    expect(harnessNote).toMatch(/operator-global/i);
    expect(harnessNote).toMatch(/missing_canonical/);

    const workspaceNote = expectCorrectiveCall(checkDriftTool as ToolLike, 'db:check_drift', 'workspace', {
      tool: 'db:check_drift',
      args: {},
    });
    expect(workspaceNote).toMatch(/per-DATABASE/i);
  });

  it('fleet:list declares NO args and says the workspace is resolved ambiently', () => {
    expect(declaredKeys(fleetListTool as ToolLike, 'fleet:list')).toEqual([]);
    expectRedirectsStayRedirects(fleetListTool as ToolLike, 'fleet:list', ['workspace', 'harness']);

    const workspaceNote = expectCorrectiveCall(fleetListTool as ToolLike, 'fleet:list', 'workspace', {
      tool: 'fleet:list',
      args: {},
    });
    // "Unrecognized key" reads as "cannot be scoped"; the correction is that it is
    // ALREADY scoped, and that no cross-workspace listing exists to go looking for.
    expect(workspaceNote).toMatch(/ambient/i);
    expect(workspaceNote).toMatch(/no cross-workspace fleet listing/i);

    const harnessNote = expectCorrectiveCall(fleetListTool as ToolLike, 'fleet:list', 'harness', {
      tool: 'fleet:list',
      args: {},
    });
    expect(harnessNote).toContain('fleet:status');
  });
});

describe('P-008 scheduler scope keys', () => {
  it('scheduler:get_claim_spec redirects `harness` AND names the get/set asymmetry', () => {
    expectRedirectsStayRedirects(getClaimSpecTool as ToolLike, 'scheduler:get_claim_spec', [
      'harness',
      'planSlug',
    ]);
    const note = expectCorrectiveCall(
      getClaimSpecTool as ToolLike,
      'scheduler:get_claim_spec',
      'harness',
      { tool: 'scheduler:get_claim_spec', args: { fleet: '<fleet-slug>' } },
    );
    // The half a plain "not accepted here" would destroy: the WRITE verb of the same
    // chain does take `harness`, so a caller who generalises the refusal re-steers the
    // wrong partition on the next call.
    expect(note).toContain('scheduler:set_claim_spec');
    expect(note).toMatch(/inverted|does take|DOES take/i);
  });

  it('scheduler:running sends `fleet`/`plan` to fleet:assignments, the fleet-scoped roster', () => {
    expectRedirectsStayRedirects(scopedRunning(), 'scheduler:running', ['fleet', 'plan']);
    // It DOES declare harness/cup — that is why the redirects point elsewhere rather
    // than renaming: a fleet slug is not a harness slug and would be rejected again.
    expect(declaredKeys(scopedRunning(), 'scheduler:running')).toEqual(
      expect.arrayContaining(['harness', 'cup']),
    );

    const fleetNote = expectCorrectiveCall(scopedRunning(), 'scheduler:running', 'fleet', {
      tool: 'fleet:assignments',
      args: { fleet: '<fleet-slug>' },
    });
    expect(fleetNote).toMatch(/fleet_slug/);
    const planNote = expectCorrectiveCall(scopedRunning(), 'scheduler:running', 'plan', {
      tool: 'fleet:assignments',
      args: { plan: '<plan-slug>' },
    });
    expect(planNote).toContain('plans:items');
  });

  function scopedRunning(): ToolLike {
    return runningTool as ToolLike;
  }
});

describe('P-008 dev:pipeline_position — a FILE probe handed a work-item / a scope', () => {
  const label = 'dev:pipeline_position';

  it('keeps `work_item`, `workItem`, `harness`, `workspace` undeclared', () => {
    expectRedirectsStayRedirects(pipelinePositionTool as ToolLike, label, [
      'work_item',
      'workItem',
      'harness',
      'workspace',
    ]);
    expect(declaredKeys(pipelinePositionTool as ToolLike, label)).toEqual(
      expect.arrayContaining(['path', 'sha', 'marker']),
    );
  });

  it('translates a work-item to a PATH, and warns off the sha-only retry that was filed', () => {
    const note = expectCorrectiveCall(pipelinePositionTool as ToolLike, label, 'work_item', {
      tool: 'dev:pipeline_position',
      args: {
        path: '<a repo-relative file the work-item changed>',
        marker: '<a literal string that change introduced>',
      },
    });
    // EI-21052251222436407 is the measured failure this sentence exists to prevent:
    // "work_item rejected, retrying sha only" — which silently answers a weaker question.
    expect(note).toMatch(/not fall back to `sha`|Do NOT fall back/i);
    expect(note).toMatch(/newest commit/i);
    expect(note).toContain('work_items:get');
  });

  it('tells a `harness` caller the repo comes from the path, and flags the sibling-checkout case', () => {
    const note = expectCorrectiveCall(pipelinePositionTool as ToolLike, label, 'harness', {
      tool: 'dev:pipeline_position',
      args: { path: '<repo-relative path>' },
    });
    expect(note).toContain('harnessMismatch');
  });
});

describe('P-008 git-sync:await — installSlug is the same scope under another verb', () => {
  const label = 'git-sync:await';

  it('declares `harness`, so the redirects are same-tool RENAMES that split cleanly (D-004)', () => {
    expect(declaredKeys(gitSyncAwaitTool as unknown as ToolLike, label)).toContain('harness');
    expectRedirectsStayRedirects(gitSyncAwaitTool as unknown as ToolLike, label, [
      'installSlug',
      'install_slug',
      'workspace',
    ]);
    for (const key of ['installSlug', 'install_slug', 'workspace']) {
      expectLocalRename(gitSyncAwaitTool as unknown as ToolLike, label, key, 'harness');
    }
  });

  it('says WHY dropping the key is not a safe fallback, which is what made it a re-filed defect', () => {
    const split = expectLocalRename(
      gitSyncAwaitTool as unknown as ToolLike,
      label,
      'installSlug',
      'harness',
    );
    // Both filings read the refusal as schema/doc drift because nothing said the two
    // spellings are one scope across two verbs.
    expect(split.note).toContain('routines:list');
    // And dropping it does not fail loudly — it either refuses (no sha) or waits on the
    // GLOBAL commit event, which looks like success and wakes on someone else's commit.
    expect(split.note).toMatch(/RENAME/);
    expect(split.note).toMatch(/global/i);
  });
});

describe('P-008 value-level filings: no argRedirect can ever reach them', () => {
  it('facts:list has no `plan` scope, and its describe() names where plan-scoped state lives', () => {
    // The mechanism, asserted rather than asserted-about: `scope` IS declared, so the
    // failure is an invalid ENUM VALUE, and invalidInputCorrections only runs over
    // UNRECOGNIZED KEYS. A redirect authored here would never fire — hence the describe().
    expect(declaredKeys(factsListTool as ToolLike, 'facts:list')).toContain('scope');
    expect(redirects(factsListTool as ToolLike)).not.toHaveProperty('scope');
    expect(
      (factsListTool as { args: { safeParse(v: unknown): { success: boolean } } }).args.safeParse({
        scope: 'plan',
      }).success,
    ).toBe(false);

    const scopeField = (
      factsListTool as unknown as { args: { shape: Record<string, { description?: string }> } }
    ).args.shape.scope;
    const description = scopeField?.description ?? '';
    expect(description, 'facts:list.scope must carry the teaching — it is the only surface a value-level rejection shows').not.toBe('');
    expect(description).toMatch(/NO `plan` scope/);
    expect(description).toContain('plans:add-decision');
    // And the substitutes, so the caller is not left with only a prohibition.
    expect(description).toMatch(/work_item/);
  });
});

describe('P-008 already-remediated rows stay remediated', () => {
  it('loop:end still ACCEPTS `harness` (accepted-and-ignored), so its filing must not be re-opened', () => {
    // EI-21350030865368266 filed `harness` as rejected. It is a declared, deliberately
    // inert compatibility arg — this pins that, so a "tidy up the unused key" cleanup
    // re-breaks the filing loudly instead of silently.
    expect(declaredKeys(loopEndTool as ToolLike, 'loop:end')).toContain('harness');
    expect(
      (loopEndTool as { args: { safeParse(v: unknown): { success: boolean } } }).args.safeParse({
        harness: 'papercusp',
      }).success,
    ).toBe(true);
  });
});
