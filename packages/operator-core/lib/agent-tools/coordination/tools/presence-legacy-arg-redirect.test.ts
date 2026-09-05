/**
 * presence-legacy-arg-redirect.test.ts — EI-21482956761170053 / EI-21474470155153658.
 *
 * Two agents called `coord:presence` with `harness` (one alongside `include_stale` +
 * `limit`, the other alongside `ownerIds`) and got back only the generic key list plus a
 * string-distance guess of `scope`. That guess is worse than silence here: `scope` is an
 * enum of hive|workspace|all, so a caller who follows it sends `scope:'papercusp'` and
 * fails a SECOND time, on the enum. The remedy was already written down — the tool's
 * description names these keys as invalid — but a description is not on the failure the
 * agent is holding, the same lesson `code:run`'s clamp disclosure records.
 *
 * The generic rendering behaviour (an authored redirect outranks AND suppresses the
 * near-name guess) is already pinned in tooldef's strict-args.test.ts; it is deliberately
 * not re-tested here. What was unpinned is that coord:presence DECLARES a redirect for
 * every key its own description calls invalid — so the first test derives that key list
 * from the description itself rather than restating it, and prose and correction cannot
 * drift apart in either direction.
 */
import { describe, it, expect } from 'vitest';
import presenceTool from './presence';

/** The keys the tool's OWN description names as invalid, parsed rather than restated. */
function legacyKeysNamedInDescription(): string[] {
  const sentence = /Legacy ([^.]*?) keys are invalid/.exec(presenceTool.description ?? '');
  if (!sentence?.[1]) return [];
  return sentence[1]
    // The Oxford comma matters: splitting on `,\s*` alone consumes the comma in
    // ", and include_stale" and yields the token "and include_stale".
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

describe('coord:presence guidance.argRedirects', () => {
  it('POSITIVE CONTROL: the description still names a non-trivial legacy-key set', () => {
    // Without this, a description edit that drops or rewords the sentence would make the
    // drift guard below pass VACUOUSLY over an empty list — an absence claim manufactured
    // by an instrument that measured nothing.
    const keys = legacyKeysNamedInDescription();
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys).toContain('harness');
  });

  it('declares a redirect for every key its description calls invalid', () => {
    const redirects = presenceTool.guidance?.argRedirects ?? {};
    const missing = legacyKeysNamedInDescription().filter((key) => !(key in redirects));
    expect(missing).toEqual([]);
  });

  it('answers the measured `harness` rejection with `pot`, never the misleading `scope`', () => {
    const redirect = presenceTool.guidance?.argRedirects?.harness;
    expect(redirect).toEqual({
      tool: 'coord:presence',
      args: { pot: '<hive-slug>' },
      note: expect.stringContaining('scopes by HIVE'),
    });
    // The regression that made the original rejection actively harmful: `scope` must not
    // be offered as the destination for a harness slug it cannot accept.
    expect(JSON.stringify(redirect)).not.toContain('"scope"');
  });

  it('tells `include_stale` callers the dump was REMOVED, not renamed', () => {
    // The filing passed include_stale expecting a fuller roster. `owner`/`owners` is the
    // replacement (it returns ended rows for a NAMED agent); there is no whole-roster
    // stale expansion to redirect to, so the note has to say so rather than imply a rename.
    const redirect = presenceTool.guidance?.argRedirects?.include_stale;
    expect(redirect).toEqual({
      tool: 'coord:presence',
      args: { owner: '<agent-id>' },
      note: expect.stringContaining('REMOVED'),
    });
  });

  it('routes `includeEnded` callers to targeted lookups that already include ended rows', () => {
    const redirect = presenceTool.guidance?.argRedirects?.includeEnded;
    expect(redirect).toEqual({
      tool: 'coord:presence',
      args: { owner: '<agent-id>' },
      note: expect.stringContaining('already include ended rows'),
    });
  });

  it('routes the paging and cross-surface keys to the tools that own them', () => {
    const redirects = presenceTool.guidance?.argRedirects ?? {};
    expect(redirects.limit).toMatchObject({ tool: 'coord:roster' });
    expect(redirects.plan).toMatchObject({ tool: 'coord:roster' });
    expect(redirects.fleet).toMatchObject({ tool: 'fleet:assignments' });
    // Exact synonyms of a declared key use the terse string form ("pass it as `X` instead").
    expect(redirects.hive).toBe('pot');
    expect(redirects.agent).toBe('owner');
  });

  it('answers the `items` collection-key guess with the bounded `owners` selector', () => {
    // EI-21480522630558604 passed `items:[<ownerIds>]` for a bounded multi-owner lookup.
    // `items` is not a legacy coord:presence key, so the description-derived drift guard
    // above cannot reach it — it is a FOREIGN key borrowed from the work_items family,
    // and it needs its own pin.
    expect(presenceTool.guidance?.argRedirects?.items).toBe('owners');
  });

  it('POSITIVE CONTROL: `items` really is rejected and `owners` really is declared', () => {
    // Without this the assertion above could pass while pointing callers at a key that
    // does not exist (the second-rejection failure the `harness`/`scope` test pins), or
    // while `items` had quietly become valid and needed no redirect at all. Both halves
    // are checked through the tool's own parsed schema, never a substring of the rendered
    // arg summary — the plan's standing rule, and the check that caught a false ABSENT
    // reading of capability:read's `byte_limit`.
    expect(presenceTool.args.safeParse({ items: ['su-abc'] }).success).toBe(false);
    expect(presenceTool.args.safeParse({ owners: ['su-abc'] }).success).toBe(true);
  });
});
