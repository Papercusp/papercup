/**
 * social-guidance-routes.test.ts — P-010 of
 * social-platform-integrations-2026-08-23.
 *
 * The `social:*` family's guidance is DENSE with cross-references: it routes to
 * sibling verbs (social:search → social:read → social:reply), out to other
 * families (personal:search, mail:reply, chat:post, memory:search), and names
 * fields another module returns (`confirmToken`, `replyable.allowed`). Every one
 * of those is a second copy of a truth some other file owns — the
 * derived-truth-ladder's "code-describing metadata WILL drift" class — and the
 * drift is SILENT: prose pointing at a tool that no longer exists still reads
 * like confident, authoritative guidance.
 *
 * This is rung 2 (PIN): the prose stays hand-written because it is genuine
 * judgment, but a build-time check fails the moment it stops describing reality.
 *
 * WHY IT EXISTS — a real defect, not a hypothetical. social:read returned the
 * field `deleteToken` while social:delete took an arg named `confirmToken` AND
 * its guidance told the agent to pass "the confirmToken that social:read
 * returns" — a field that did not exist under that name. Both tools were
 * individually correct and internally consistent; they landed in separate plan
 * items (P-007, P-008), so per-tool authorship could not have caught it. Only
 * reading the family as a family surfaced it. That is precisely the failure mode
 * P-010 names: "the measured failure mode in this repo is routing, not
 * capability."
 */
import { describe, it, expect } from 'vitest';
import { listAllProjectedTools, type ProjectedTool } from '@papercusp/tooldef';
import '../index'; // side-effect: register the full real tool catalog
import type { SocialPostView } from '../../capability-verbs/social-read';
import socialDelete from './delete';

/**
 * A ProjectedTool has no `name`: the registry is keyed by name and the
 * agent-facing one lives on the MCP exposure. Same accessor `namedToolWeights()`
 * uses in tool-guidance-budget.ts — one precedent, not two.
 */
function toolName(tool: ProjectedTool): string | undefined {
  return tool.expose?.mcp?.name;
}

/** Every string in a tool's guidance that an agent actually reads. */
function guidanceStrings(tool: {
  description?: string;
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
}): string[] {
  const g = tool.guidance ?? {};
  const perRole = Object.values(g.byRole ?? {}).flatMap((r) => [r.when, r.notWhen, r.chaining]);
  return [tool.description, g.when, g.notWhen, g.chaining, ...perRole].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
}

/**
 * `family:verb` tokens. Deliberately permissive, then filtered by family below —
 * prose legitimately contains colon-shaped things that are NOT tools
 * ("reddit:r/rust" as an example destination, "replyable.allowed:false" as a
 * field reading), and treating those as broken routes would make the check
 * fire on correct guidance.
 */
const TOOL_REF = /\b([a-z][a-z_-]*):([a-z][a-z_.-]*)\b/g;

function citedToolRefs(text: string): string[] {
  return [...text.matchAll(TOOL_REF)].map((m) => `${m[1]}:${m[2]}`);
}

/**
 * The actual judgement, factored out so the CONTROLS below exercise THIS code
 * rather than a reimplementation of it. A control that re-derives the logic it
 * is meant to falsify proves only that the copy works.
 */
function brokenRoutes(
  texts: readonly string[],
  names: ReadonlySet<string>,
  families: ReadonlySet<string>,
): string[] {
  const broken: string[] = [];
  for (const text of texts) {
    for (const ref of citedToolRefs(text)) {
      // Only judge references from a family that really exists. An unknown
      // family is prose (a platform name, a field reading), not a typo'd tool.
      if (!families.has(ref.split(':')[0]!)) continue;
      if (!names.has(ref)) broken.push(ref);
    }
  }
  return broken;
}

describe('social:* guidance routes (P-010 pin)', () => {
  const all = listAllProjectedTools();
  const names = new Set(all.map(toolName).filter((n): n is string => typeof n === 'string'));
  const families = new Set([...names].map((n) => n.split(':')[0]!));
  const social = all.filter((t) => toolName(t)?.startsWith('social:') === true);

  it('loaded a real catalog with the whole social family in it', () => {
    // Mirrors the budget gate's floor: a partially-registered barrel yields ~40
    // tools, and every assertion below would then pass vacuously.
    expect(all.length).toBeGreaterThan(500);
    expect(social.map(toolName).sort()).toEqual([
      'social:delete',
      'social:post',
      'social:read',
      'social:reply',
      'social:search',
    ]);
  });

  it('every tool the family routes to actually exists in the live catalog', () => {
    const broken = social.flatMap((tool) =>
      brokenRoutes(guidanceStrings(tool), names, families).map((ref) => `${toolName(tool)} → ${ref}`),
    );
    expect(
      broken,
      broken.length === 0
        ? ''
        : `social:* guidance routes an agent to tool(s) that do not exist:\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CONTROL: the check actually catches a dead route, and tolerates prose that merely looks like one', () => {
    // Permanent broken-input controls (the mutation-probe discipline's
    // "module/logic you import" tier): they prove this guard CAN go red without
    // ever mutating the shared tree — no restore, no sweep race. Deleting them
    // leaves a guard that has never failed.
    expect(
      brokenRoutes(['first social:search, then mail:nosuchverb'], names, families),
      'a dead route inside a REAL family must be caught',
    ).toEqual(['mail:nosuchverb']);

    expect(
      brokenRoutes(['post to reddit:r/rust when replyable.allowed:false'], names, families),
      'colon-shaped prose from a non-catalog family must NOT be reported',
    ).toEqual([]);

    // Calibration: the same call over the REAL guidance returns nothing, so the
    // two controls above cannot be passing merely because everything is empty.
    expect(brokenRoutes(guidanceStrings(social[0]!), names, families)).toEqual([]);
  });

  it('POSITIVE CONTROL: the extractor really finds the cross-family routes', () => {
    // Without this, a regex that silently stopped matching would make the test
    // above pass by measuring NOTHING — an absence claim with no control, which
    // is the exact way this file could rot into a green that means nothing.
    const found = new Set(social.flatMap((t) => guidanceStrings(t).flatMap(citedToolRefs)));
    for (const expected of [
      'social:search',
      'social:read',
      'social:reply',
      'personal:search',
      'memory:search',
      'mail:reply',
      'mail:send',
      'chat:reply',
      'chat:post',
    ]) {
      expect(found, `extractor missed the known route ${expected}`).toContain(expected);
    }
  });

  it("social:read's minted field and social:delete's arg share ONE name", () => {
    // The agent's entire job with this value is to move it from social:read's
    // result into social:delete's arg. Same name ⇒ nothing to translate; a
    // rename on EITHER side reintroduces the original defect.
    //
    // Producer side is a TYPE-level pin: renaming SocialPostView.confirmToken
    // fails `npm run lint:tsc` (which covers operator-core) before this suite
    // even runs.
    const producerField: keyof SocialPostView = 'confirmToken';

    // Consumer side, at runtime: the zod arg schema must declare that same key.
    const shape = (socialDelete.args as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain(producerField);

    // ...and the guidance must keep telling the agent that name, since that is
    // what an agent acts on — the field and the arg can agree while the prose
    // names a third thing, which is how this started.
    const deleteTool = social.find((t) => toolName(t) === 'social:delete');
    expect(deleteTool, 'social:delete missing from catalog').toBeTruthy();
    expect(guidanceStrings(deleteTool!).join('\n')).toContain(producerField);
  });
});
