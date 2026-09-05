/**
 * scope-args-contract.test.ts — the scheduler spec-addressing trio's SCOPE-ARG matrix,
 * derived from the live zod schemas rather than restated in prose (EI-20185841251188914).
 *
 * THE DEFECT THIS PINS. `scheduler:get_claim_spec` rejects `harness`, while its write
 * counterpart `scheduler:set_claim_spec` requires it for some cohorts — and the write
 * rejects `workspace`, which the read accepts. The two disagree on BOTH scope keys, in
 * OPPOSITE directions, on exactly the sequence get_claim_spec's own `chaining` guidance
 * tells you to run: get (confirm) → set (re-steer) → get (confirm). An agent who copies a
 * scope key from one call into the next is refused, and until now nothing said so except
 * the refusal itself: the caller who needs the warning is the one reading a SIBLING tool,
 * who has no reason to expect a difference.
 *
 * WHY THE ASYMMETRY IS CORRECT AND MUST NOT BE "FIXED" BY ACCEPTING THE KEY. `harness` on
 * set_claim_spec is a WRITE-TIME ADMISSION PREVIEW for a fixed WI-/EI- cohort, not a lane
 * selector (see its own .describe()); a read has nothing to preview. Accepting it on
 * get_claim_spec as an ignored alias would reintroduce precisely the EI-10883 hazard the
 * strict-args rail exists to prevent — an undeclared arg returning ok:true while quietly
 * doing something else. So the fix is DISCOVERABILITY, and this test is what keeps the
 * discoverability honest.
 *
 * WHY A TEST AND NOT JUST THE GUIDANCE. Per CLAUDE.md's derive/pin/attest ladder, a
 * sentence that DESCRIBES another module's arg schema is code-describing metadata and will
 * drift. Rung 2 (PIN) is exactly this: the prose stays, and a build-time divergence check
 * fails when the schema moves under it. Change an arg below and this test tells you which
 * seeAlso line is now a lie.
 *
 * WHERE THE PROSE LIVES, AND WHY IT IS IN `seeAlso`. The per-tool prompt-weight budget
 * (P-011, tool-guidance-budget.ts) counts description + guidance.when/notWhen/chaining but
 * NOT seeAlso. get_claim_spec sits at ~1408 of its 1500-char budget, so the same sentence
 * in `when` is refused at edit time and would red the fleet's green-checkpoint gate. The
 * cross-references therefore live in seeAlso, which is also where a caller comparing two
 * sibling tools actually looks.
 */
import { describe, expect, it } from 'vitest';
import getClaimSpec from './get_claim_spec';
import setClaimSpec from './set_claim_spec';
import previewSpecDelta from './preview_spec_delta';

/** Every scope-ish key any member of the family declares, so a NEW one shows up as a diff
 *  rather than being silently ignored by a hardcoded per-tool list. */
const SCOPE_KEYS = ['cupId', 'ownerId', 'fleet', 'harness', 'workspace', 'planSlug'] as const;

type ToolLike = { name: string; args?: unknown; guidance?: { seeAlso?: string[] } };

/**
 * `.refine()` wraps a ZodObject in a ZodEffects, so `.shape` is one or more `_def` hops
 * down. Walk rather than assume a depth: get_claim_spec is refined today and the others
 * are not, and that is free to change.
 */
function argKeys(tool: ToolLike): string[] {
  let node: unknown = tool.args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape).sort();
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    node = def?.schema ?? def?.innerType;
  }
  throw new Error(`could not read an object shape from ${tool.name}'s args schema`);
}

const scopeArgs = (tool: ToolLike) => SCOPE_KEYS.filter((k) => argKeys(tool).includes(k));

describe('scheduler spec-addressing trio — scope-arg matrix (EI-20185841251188914)', () => {
  // The matrix is asserted EXACTLY, not with individual toContain checks: the point is to
  // catch an arg being ADDED as loudly as one being removed, since either one falsifies a
  // seeAlso line below.
  it('declares exactly the scope args each tool is documented to accept', () => {
    expect({
      [getClaimSpec.name]: scopeArgs(getClaimSpec as ToolLike),
      [setClaimSpec.name]: scopeArgs(setClaimSpec as ToolLike),
      [previewSpecDelta.name]: scopeArgs(previewSpecDelta as ToolLike),
    }).toEqual({
      'scheduler:get_claim_spec': ['cupId', 'fleet', 'workspace'],
      'scheduler:set_claim_spec': ['cupId', 'fleet', 'harness'],
      'scheduler:preview_spec_delta': ['cupId', 'fleet', 'harness', 'workspace'],
    });
  });

  // The two asymmetries stated as PROPERTIES rather than as a repeat of the literal above,
  // so the failure message names the defect instead of a diff the reader has to interpret.
  it('the get→set→get chain disagrees on both scope keys, in opposite directions', () => {
    const read = scopeArgs(getClaimSpec as ToolLike);
    const write = scopeArgs(setClaimSpec as ToolLike);
    expect(read.includes('harness')).toBe(false);
    expect(write.includes('harness')).toBe(true);
    expect(read.includes('workspace')).toBe(true);
    expect(write.includes('workspace')).toBe(false);
  });

  it('preview_spec_delta is the superset of both — so a key valid there is not valid on either', () => {
    const preview = scopeArgs(previewSpecDelta as ToolLike);
    for (const k of [...scopeArgs(getClaimSpec as ToolLike), ...scopeArgs(setClaimSpec as ToolLike)]) {
      expect(preview).toContain(k);
    }
  });
});

describe('the matrix is DOCUMENTED on every member, not just on the one that rejects the key', () => {
  // A caller learns the distinction only if it is stated where they are already reading.
  // These assertions are what stop the cross-references being dropped in a later trim while
  // the schemas keep disagreeing — the exact state this item was filed about.
  const seeAlso = (tool: ToolLike) => (tool.guidance?.seeAlso ?? []).join('\n');

  it('get_claim_spec points at both siblings and names the mirror', () => {
    const text = seeAlso(getClaimSpec as ToolLike);
    expect(text).toContain('scheduler:set_claim_spec');
    expect(text).toContain('scheduler:preview_spec_delta');
    expect(text).toMatch(/harness/);
    expect(text).toMatch(/workspace/);
  });

  it('set_claim_spec points back at the read side and names the mirror', () => {
    const text = seeAlso(setClaimSpec as ToolLike);
    expect(text).toContain('scheduler:get_claim_spec');
    expect(text).toContain('scheduler:preview_spec_delta');
    expect(text).toMatch(/harness/);
    expect(text).toMatch(/workspace/);
  });

  it('preview_spec_delta names what its two neighbours each lack', () => {
    const text = seeAlso(previewSpecDelta as ToolLike);
    expect(text).toContain('scheduler:get_claim_spec');
    expect(text).toContain('scheduler:set_claim_spec');
    expect(text).toMatch(/harness/);
    expect(text).toMatch(/workspace/);
  });
});
