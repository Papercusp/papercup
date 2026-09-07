/**
 * tool-contract-repair-2026-09-05 P-006 — the plans-family argument-contract
 * repairs, pinned so the class cannot silently return.
 *
 * Every assertion below traces to a filed `invalid_args` report: a caller
 * guessed a name a reasonable person would guess, the strict arg surface
 * refused it (correctly — the loudness is the feature), and the missing ALIAS
 * was the defect. Because each repair is one optional field plus one `??`
 * chain, it is exactly the kind of thing a later refactor drops without
 * noticing; these tests are what makes that drop fail loudly instead of
 * re-filing itself as a fresh cluster.
 *
 * Schema-only (no DB): `tool.args` is the same schema the dispatcher validates
 * every live call against, so a `safeParse` here exercises what a real call
 * hits. Where a repair also changes what the HANDLER reads, the pure
 * resolution helper is asserted directly beside it.
 */
import { describe, it, expect } from 'vitest';

import itemsTool from './items';
import getTool from './get';
import getSpecsTool from './get-specs';
import searchTool, { normalizePlansSearchArgs, MAX_LIMIT, LIMIT_DESCRIPTION } from './search';
import addItemTool, { resolveItemText, itemTextOrUndefined } from './add-item';
import newTool from './new';

/** Parse and fail loudly with the real zod message when a repair regresses. */
function parseOk(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown; data?: unknown } }, args: unknown) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`expected these args to parse but they were refused: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data as Record<string, unknown>;
}


describe('plans:items — exact-item selector aliases (EI-21669556283807249, EI-21382868747036184, EI-21856673460402354)', () => {
  // Every one of these was filed as invalid_args AFTER `item`/`ids` already
  // landed: the caller wanted one thing (select exact P-NNN ids from one plan)
  // and there is no second meaning any of these names could carry here.
  const aliases: Array<[string, unknown]> = [
    ['itemIds', ['P-006']],
    ['item', 'P-006'],
    ['ids', ['P-006']],
    ['itemId', 'P-006'],
    ['items', ['P-006']],
    ['item_ids', ['P-006']],
    ['item_id', 'P-006'],
  ];

  for (const [key, value] of aliases) {
    it(`accepts \`${key}\` as an exact-item selector`, () => {
      parseOk(itemsTool.args, { slug: 'a-plan-2026-09-05', [key]: value });
    });
  }

  it('still requires a slug for EVERY alias spelling — cross-plan item selection stays refused', () => {
    for (const [key, value] of aliases) {
      const parsed = itemsTool.args.safeParse({ [key]: value });
      expect(parsed.success, `${key} without slug must be refused`).toBe(false);
    }
  });

  it('still refuses a genuinely unknown key — the aliases widen the contract, they do not soften it', () => {
    expect(itemsTool.args.safeParse({ slug: 'a-plan-2026-09-05', itemIdz: ['P-006'] }).success).toBe(false);
  });

  it('still refuses a malformed item id through an alias', () => {
    expect(itemsTool.args.safeParse({ slug: 'a-plan-2026-09-05', itemId: 'not-an-id' }).success).toBe(false);
  });

  it('names the alias spellings in the tool description so the next caller does not have to guess', () => {
    for (const key of ['ids', 'itemId', 'items', 'item_ids']) {
      expect(itemsTool.description).toContain(key);
    }
  });
});

describe('plans:get — `decisionIds` aliases `decisions` (EI-21158047068641416)', () => {
  it('accepts the plural `decisionIds`', () => {
    parseOk(getTool.args, { slug: 'a-plan-2026-09-05', decisionIds: ['D-039', 'D-040'] });
  });

  it('keeps the canonical `decisions` and the singular `decisionId` working', () => {
    parseOk(getTool.args, { slug: 'a-plan-2026-09-05', decisions: ['D-039'] });
    parseOk(getTool.args, { slug: 'a-plan-2026-09-05', decisionId: 'D-039' });
  });

  it('documents the precedence on the alias itself', () => {
    expect(getTool.args.shape.decisionIds.description).toMatch(/`decisions` wins/i);
  });

  it('still requires slug or slugs — D-NNN ids are plan-local', () => {
    expect(getTool.args.safeParse({ decisionIds: ['D-039'] }).success).toBe(false);
  });

  // EI-22056792132086608 — plans:items spells the same selector `itemIds`, so a
  // caller moving between the two tools writes it here.
  it('accepts `itemIds` as an alias for its own `items` selector', () => {
    parseOk(getTool.args, { slug: 'a-plan-2026-09-05', itemIds: ['P-006'] });
    parseOk(getTool.args, { slug: 'a-plan-2026-09-05', items: ['P-006'] });
    expect(getTool.args.shape.itemIds.description).toMatch(/`items` wins/i);
  });
});

describe('plans:get-specs — singular plan-item aliases (EI-21722550422531809)', () => {
  it('accepts `itemId` and `planItemId`', () => {
    parseOk(getSpecsTool.args, { slug: 'a-plan-2026-09-05', itemId: 'P-006' });
    parseOk(getSpecsTool.args, { slug: 'a-plan-2026-09-05', planItemId: 'P-006' });
  });

  it('keeps the canonical `planItemIds` working and still refuses a malformed id', () => {
    parseOk(getSpecsTool.args, { slug: 'a-plan-2026-09-05', planItemIds: ['P-006'] });
    expect(getSpecsTool.args.safeParse({ slug: 'a-plan-2026-09-05', itemId: 'P6' }).success).toBe(false);
  });
});

describe('plans:get-specs — canonical clause access for the gym judge (EI-22548266898865228)', () => {
  it('admits judge so acceptance grading can read the authoritative clauses', () => {
    expect(getSpecsTool.agentRoles).toContain('judge');
  });
});

describe('plans:search — a single-string `scope` (EI-21166014275674822)', () => {
  it('widens a bare string into the one-element list', () => {
    const parsed = parseOk(searchTool.args, { query: 'contract repair', scope: 'items' });
    expect(parsed.scope).toEqual(['items']);
  });

  it('leaves an array `scope` untouched', () => {
    const parsed = parseOk(searchTool.args, { query: 'contract repair', scope: ['items', 'now'] });
    expect(parsed.scope).toEqual(['items', 'now']);
  });

  it('still rejects an unknown scope NAME — only the container shape was widened', () => {
    expect(searchTool.args.safeParse({ query: 'x', scope: 'nonesuch' }).success).toBe(false);
    expect(searchTool.args.safeParse({ query: 'x', scope: ['nonesuch'] }).success).toBe(false);
  });

  it('keeps the pre-existing `q` alias working, alone and beside a string scope', () => {
    expect(parseOk(searchTool.args, { q: 'contract repair' }).query).toBe('contract repair');
    const both = parseOk(searchTool.args, { q: 'contract repair', scope: 'prose' });
    expect(both.query).toBe('contract repair');
    expect(both.scope).toEqual(['prose']);
  });

  it('normalizePlansSearchArgs is a pure widener — non-objects and untouched args pass through', () => {
    expect(normalizePlansSearchArgs('nope')).toBe('nope');
    const untouched = { query: 'x', scope: ['items'] };
    expect(normalizePlansSearchArgs(untouched)).toBe(untouched);
  });

  // EI-21253383007098268: read-only call, arbitrary cap, nothing destructive
  // downstream — the plan's CLAMP-vs-REJECT rule puts this on the clamp side.
  it('CLAMPS an over-large limit instead of refusing the call, and states the cap', () => {
    parseOk(searchTool.args, { query: 'x', limit: 500 });
    // plans:search wraps its object in a preprocess, so the object shape sits
    // one level in — reach it explicitly rather than reading `.shape` off the
    // effect and silently asserting on `undefined`.
    expect(MAX_LIMIT).toBe(50);
    expect(LIMIT_DESCRIPTION).toMatch(/capped at 50/i);
    expect(LIMIT_DESCRIPTION).toMatch(/clamped/i);
  });

  it('still refuses a limit that is not a positive integer — only the CEILING was relaxed', () => {
    expect(searchTool.args.safeParse({ query: 'x', limit: 0 }).success).toBe(false);
    expect(searchTool.args.safeParse({ query: 'x', limit: 2.5 }).success).toBe(false);
  });

  it('an explicit `query` still wins over `q`', () => {
    expect(parseOk(searchTool.args, { q: 'alias', query: 'canonical' }).query).toBe('canonical');
  });
});

describe('plans:add-item — `title`/`body` alias `text`, but not both at once', () => {
  const base = { slug: 'a-plan-2026-09-05', phase: 'Phase — now', importance: 'normal' };

  it('accepts `title` alone and `body` alone', () => {
    parseOk(addItemTool.args, { ...base, title: 'do the thing' });
    parseOk(addItemTool.args, { ...base, body: 'do the thing' });
  });

  it('REFUSES `title` + `body` together rather than guessing a separator', () => {
    const parsed = addItemTool.args.safeParse({ ...base, title: 'a title', body: 'a body' });
    expect(parsed.success).toBe(false);
    // The refusal must name the fix, not just the rule.
    expect(JSON.stringify(parsed.error)).toMatch(/combine them into `text`/i);
  });

  it('an explicit `text` wins over both aliases and is never ambiguous', () => {
    expect(resolveItemText({ text: 'canonical', title: 'a', body: 'b' })).toEqual({ ok: true, text: 'canonical' });
    parseOk(addItemTool.args, { ...base, text: 'canonical', title: 'a', body: 'b' });
  });

  it('resolves the aliases the same way inside the bulk `items:[…]` form', () => {
    parseOk(addItemTool.args, { slug: base.slug, phase: base.phase, importance: 'normal', items: [{ title: 'one' }] });
    expect(
      addItemTool.args.safeParse({
        slug: base.slug,
        phase: base.phase,
        importance: 'normal',
        items: [{ title: 'one', body: 'two' }],
      }).success,
    ).toBe(false);
  });

  it('still refuses an item with no text under ANY spelling', () => {
    expect(addItemTool.args.safeParse(base).success).toBe(false);
    expect(itemTextOrUndefined({})).toBeUndefined();
    expect(itemTextOrUndefined({ title: 'a', body: 'b' })).toBeUndefined();
  });

  it('still requires phase and importance — the aliases did not loosen the other required fields', () => {
    expect(addItemTool.args.safeParse({ slug: base.slug, title: 'x', importance: 'normal' }).success).toBe(false);
    expect(addItemTool.args.safeParse({ slug: base.slug, phase: base.phase, title: 'x' }).success).toBe(false);
  });
});

describe('plans:new — `goal` aliases `rationale`', () => {
  const base = { slug: 'a-new-plan', title: 'A new plan' };

  it('accepts `goal`', () => {
    parseOk(newTool.args, { ...base, goal: 'why this plan exists' });
  });

  it('keeps `rationale` canonical and says so on the alias', () => {
    parseOk(newTool.args, { ...base, rationale: 'why this plan exists' });
    expect(newTool.args.shape.goal.description).toMatch(/`rationale` wins/i);
  });

  it('points `goal` away from the plan BODY, which is a different argument', () => {
    expect(newTool.args.shape.goal.description).toMatch(/`content`/);
  });
});

describe('plans:items — `plan` as an alias for `slug` (EI-22387676408573400)', () => {
  // Filed as invalid_args by a caller narrowing a read to one plan. On a tool
  // named plans:items there is no second thing `plan` could select, so the
  // guess was reasonable and the refusal was the defect.
  it('accepts `plan` and resolves it to slug', () => {
    const parsed = parseOk(itemsTool.args, { harness: 'papercusp', plan: 'some-plan' });
    expect(parsed.slug).toBe('some-plan');
    expect(parsed.plan).toBeUndefined();
  });

  // The rename must happen BEFORE parse, not in the handler: the cross-plan
  // `.refine` reads args.slug, so a handler-side alias would still reject an
  // exact item selection that DID name its plan — and it would fail as
  // "itemIds requires an exact plan slug", the confusing message the alias
  // exists to remove. This is the assertion that pins WHERE the fix lives.
  it('satisfies the itemIds-requires-a-slug refine when the plan came in as `plan`', () => {
    const parsed = parseOk(itemsTool.args, {
      harness: 'papercusp',
      plan: 'some-plan',
      itemIds: ['P-006'],
    });
    expect(parsed.slug).toBe('some-plan');
  });

  it('lets an explicit `slug` win and drops the duplicate `plan`', () => {
    const parsed = parseOk(itemsTool.args, {
      harness: 'papercusp',
      slug: 'wins',
      plan: 'loses',
    });
    expect(parsed.slug).toBe('wins');
    expect(parsed.plan).toBeUndefined();
  });

  // Falsifiability control: an alias must not make the strict surface
  // permissive. The loudness on a genuinely unknown key is the feature.
  it('still refuses an unrelated unknown key', () => {
    expect(itemsTool.args.safeParse({ harness: 'papercusp', planSlug: 'x' }).success).toBe(false);
  });
});
