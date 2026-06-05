/**
 * blueprint:extend — author a CHILD blueprint that inherits from a parent (the
 * cheap, common path: most blueprints extend `coding`/`base`/`research`). The
 * agent supplies only the overrides; the tool merges them onto the parent,
 * validates the RESOLVED result, and returns the child's canonical YAML (the
 * small override file to persist). Pure — no file write, no harness creation.
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 / B1 / D-001 (inheritance so
 * agents don't author from zero / don't burn tokens).
 */
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAndValidate } from './_resolve';

export default defineTool({
  name: 'blueprint:extend',
  description:
    'Author a CHILD blueprint extending a parent (e.g. extend "coding"). You supply only the overrides; the tool merges onto the parent, validates the resolved result, and returns {ok, errors, warnings, yaml} — the small child override file for .papercusp/blueprint.yaml. The parent must be a built-in (coding/base/research).',
  guidance: {
    when: 'The usual way to make a new blueprint: inherit shared structure from a built-in and override only what differs (knobs, a few roles, a spine tweak). Cheap to author.',
    notWhen: 'Authoring a wholly new shape with no parent — blueprint:create. Extending a LOCAL/installed (non-built-in) parent — not yet supported by this tool (built-in parents only).',
    chaining: 'blueprint:extend { parent:"coding", overrides } → (inspect yaml) → harness:create { blueprint }.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe("The child blueprint's id"),
    parent: z.string().min(1).describe('Parent built-in blueprint id to extend (coding, base, research)'),
    overrides: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Fields to override/add on top of the parent (knobs, roles, spine.edges, …)'),
  }),
  async handler(args) {
    const child = { id: args.id, extends: args.parent, ...args.overrides };
    const r = resolveAndValidate(child);
    if (r.parseError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, parseError: r.parseError }) }] };
    }
    const yaml = stringifyYaml(child, { lineWidth: 100 });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: r.ok, errors: r.validation!.errors, warnings: r.validation!.warnings, yaml }),
        },
      ],
    };
  },
});
