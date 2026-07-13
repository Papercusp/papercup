/**
 * EI-10996 recurrence guard — every registered tool's `args` must be representable
 * in JSON Schema, and a violation must NAME THE TOOL.
 *
 * WHY THIS EXISTS (the detector was the second bug, and the worse one):
 *
 * `z.toJSONSchema(tool.args)` runs with NO try/catch on the paths that SERVE the
 * tool catalog — `endpoint-route/routes/transport/_mcp-handler.ts` (HTTP MCP
 * tools/list) and `agent-mcp/src/server.ts`. So an args schema that cannot be
 * converted does not degrade ONE tool: it throws during schema-gen and takes out
 * `tools/list` for the WHOLE catalog. `work_items:comment` in particular is now in
 * the CORE SEED (EI-10946), so a bad schema there is a fleet-wide outage.
 *
 * The usual offender is a trailing zod `.transform()`, whose OUTPUT type JSON Schema
 * cannot express. (`.transform(...).pipe(<schema>)` IS fine — the pipe's output is
 * the piped schema — which is why `plans/list.ts` and `limits.ts` convert happily.
 * `.refine()` / `.superRefine()` / `z.preprocess()` are all fine too.) `limits.ts`
 * has stated this rule in prose for weeks; prose did not prevent it.
 *
 * WHAT WENT WRONG WITHOUT THIS GUARD: the EI-10897 `comment`-alias fix added
 * `.transform()` to work_items:comment's bulk item schema. The only signal was
 * `tools-md-sync.test.ts` dying at COLLECTION with:
 *
 *     Error: Transforms cannot be represented in JSON Schema
 *     Test Files 1 failed | Tests: no tests
 *
 * — no tool name, no file, nothing to grep. It reads like an unrelated zod/infra
 * break, and a peer's gate triage had already mis-attributed the red to something
 * else. This test converts each tool INDIVIDUALLY inside a try/catch, so the failure
 * message is the offending tool's NAME instead of an anonymous stack.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import '../agent-tools/index'; // side-effect: register the full real tool catalog
// EI-10996 (the guard's OWN bug — it was deleted as "red" when it was actually TELLING
// THE TRUTH): import getCatalog from THE SAME MODULE the tools register through
// (`@papercusp/agent-mcp`, which owns the `defineTool` they call), NOT straight from
// '@papercusp/tooldef'. Those two specifiers can resolve to DIFFERENT module instances
// under vitest — vite inlines the workspace source for an inlined importer while Node
// externalizes it for a node_modules one — and each instance has its OWN registry Map.
// Reading the wrong one, this guard saw 40 of ~590 tools and did not even contain
// work_items:comment: the very tool it was written for. Its `> 50` sentinel caught that
// (40 < 50) and went red — correctly. Import the catalog from the same place as
// defineTool and the two cannot diverge.
import { getCatalog } from '@papercusp/agent-mcp';

describe('tool args are JSON-Schema-representable (EI-10996)', () => {
  const catalog = getCatalog();

  // Guard the guard: if the side-effect import ever stops populating the catalog,
  // the per-tool loop below would iterate nothing and pass VACUOUSLY — a green test
  // asserting nothing is worse than no test (it actively buys false confidence).
  it('the registry loaded a real catalog — and the tools this guard exists for are IN it', () => {
    // A floor only the REAL catalog (~590 tools) can clear. The old `> 50` was low enough
    // that the wrong-instance read (40) merely LOOKED like a threshold quibble rather than
    // the "you are auditing the wrong registry" alarm it actually was.
    expect(catalog.length).toBeGreaterThan(400);

    // A count alone still cannot tell you the ONE tool you care about is present, so name
    // the canaries. work_items:comment is the tool whose bad schema caused EI-10996 — and
    // it is in the CORE SEED (EI-10946), which makes a transform there fleet-fatal.
    const names = new Set(catalog.map((t) => t.name));
    for (const canary of ['work_items:comment', 'work_items:create', 'work_items:list', 'coord:send']) {
      expect(names, `${canary} is missing — this guard is reading the WRONG registry instance`).toContain(canary);
    }
  });

  it('z.toJSONSchema() succeeds for EVERY registered tool — naming any offender', () => {
    const broken: string[] = [];

    for (const tool of catalog) {
      if (!tool.args) continue;
      try {
        // The exact call the MCP tools/list handlers make, unguarded, at serve time.
        (z as unknown as { toJSONSchema: (s: unknown) => unknown }).toJSONSchema(tool.args);
      } catch (err) {
        broken.push(`${tool.name} → ${(err as Error).message}`);
      }
    }

    expect(
      broken,
      broken.length === 0
        ? ''
        : `These tools' args cannot be converted to JSON Schema, which throws in the MCP ` +
          `tools/list handlers and breaks the ENTIRE catalog for every agent — not just these tools:\n` +
          `  ${broken.join('\n  ')}\n\n` +
          `The usual cause is a trailing zod \`.transform()\` in the args schema. Resolve/normalize ` +
          `the value HANDLER-side instead (see limits.ts, and work_items/comment.ts's \`commentText\`), ` +
          `or, if a transform is genuinely required, terminate it with \`.pipe(<schema>)\` so the ` +
          `output stays representable.`,
    ).toEqual([]);
  });

  // Self-test the DETECTOR. The loop above passes when the catalog is clean — which is
  // also exactly what it would do if `toJSONSchema` had quietly stopped throwing on
  // transforms (a zod upgrade, a config change), leaving the guard green and useless.
  // So pin the mechanism itself: a trailing transform MUST still throw, and a
  // `.pipe()`-terminated one MUST still convert.
  it('the detector really does catch a trailing .transform() (and still allows .pipe())', () => {
    const toJson = (s: unknown) => (z as unknown as { toJSONSchema: (s: unknown) => unknown }).toJSONSchema(s);

    // The exact shape that broke work_items:comment.
    const trailingTransform = z.object({ body: z.string().optional() }).transform((v) => ({ ...v, body: v.body ?? '' }));
    expect(() => toJson(trailingTransform)).toThrow(/transform/i);

    // The sanctioned escape hatch: the pipe's output IS representable (plans/list.ts).
    const pipedTransform = z
      .union([z.string(), z.array(z.string())])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .pipe(z.array(z.string()));
    expect(() => toJson(pipedTransform)).not.toThrow();

    // And a refinement — what the alias check now uses — is always fine.
    expect(() => toJson(z.object({ a: z.string() }).superRefine(() => {}))).not.toThrow();
  });
});
