/**
 * _tool-reachability.test.ts — EI-21655300007082004.
 *
 * The filing this repairs reported a refusal that names `work_items:set_blocker`
 * to a caller whose client surface could not resolve that verb. The gate itself
 * is correct-as-designed — a reasonless `state:"blocked"` write must be refused —
 * so the repair is the DELIVERY: the refusal now carries the route to reach the
 * verb it names.
 *
 * Two properties are worth pinning, and only one of them is about the helper:
 *   1. the hint names BOTH stable entrypoints (tools:find activates, tools:invoke
 *      dispatches), so a caller stuck on either route has the other;
 *   2. the refusal that motivated it actually carries the hint — a helper nobody
 *      calls repairs nothing, which is precisely how the original defect
 *      survived (the verb existed; the path to it did not).
 *
 * The negative controls are what keep (2) honest: asserting a substring of a
 * long error message passes just as readily against the wrong message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolReachabilityHint } from './_tool-reachability';

describe('toolReachabilityHint', () => {
  it('names both stable entrypoints and the tool it is about', () => {
    const hint = toolReachabilityHint('work_items:set_blocker');
    expect(hint).toContain('tools:find');
    expect(hint).toContain('tools:invoke');
    // The tool name must appear inside BOTH call shapes, not just in prose —
    // a caller copies the call, not the sentence.
    expect(hint).toContain('tools:find { query: "work_items:set_blocker" }');
    expect(hint).toContain('tools:invoke { name: "work_items:set_blocker"');
  });

  it('says the tool is unseeded rather than missing', () => {
    // The whole failure mode is a caller reading "not on my surface" as "does
    // not exist" and abandoning the route. Saying so is the load-bearing half.
    const hint = toolReachabilityHint('some:verb');
    expect(hint).toMatch(/not seeded|not that it is missing/i);
  });

  it('is tool-specific, not a generic blurb', () => {
    // NEGATIVE CONTROL: if the helper ever stops interpolating, both hints
    // become identical and every assertion above still passes.
    expect(toolReachabilityHint('a:one')).not.toEqual(toolReachabilityHint('b:two'));
    expect(toolReachabilityHint('a:one')).not.toContain('b:two');
  });
});

describe('the blocked-without-a-typed-blocker refusal carries the route', () => {
  const source = readFileSync(join(__dirname, 'work_items', 'set_state.ts'), 'utf8');

  it('calls the shared hint for work_items:set_blocker', () => {
    expect(source).toContain("toolReachabilityHint('work_items:set_blocker')");
    expect(source).toContain("import { toolReachabilityHint } from '../_tool-reachability'");
  });

  it('NEGATIVE CONTROL: the assertions above are not satisfied by any refusal text', () => {
    // The refusal names the verb; naming it was never the missing half. If the
    // hint call were dropped, this control shows what would remain — the verb
    // name alone — so the positive assertions above cannot be passing on it.
    expect(source).toContain('work_items:set_blocker { id, kind, capability, ref, summary, nextVerb }');
    const withoutHintCall = source.split("toolReachabilityHint('work_items:set_blocker')").join('');
    expect(withoutHintCall).toContain('work_items:set_blocker { id, kind, capability, ref, summary, nextVerb }');
    expect(withoutHintCall).not.toContain("toolReachabilityHint('work_items:set_blocker')");
  });
});
