/**
 * omp:config — read or update the local `omp` CLI's config tree.
 *
 *   - { op: 'get' }                              → full settings tree
 *   - { op: 'set', key, value }                  → set one knob
 *   - { op: 'unset', key }                       → unset one knob
 *
 * Writes invoke the `omp` CLI subprocess via the underlying lib.
 * Operator-only for writes; reads are any role (config introspection
 * is useful for any agent debugging behavior).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readOmpConfig, setOmpConfig, unsetOmpConfig } from '../../omp-config';

export default defineTool({
  name: 'omp:config',
  profile: 'engineer',
  guidance: {
    when: 'Read or set an OMP CLI config key (model, paths, env tweaks). Used during installation / first-run flows.',
    notWhen: 'For OPERATOR runtime preferences (voice, scanner), use `operator:preferences`. omp:config is the CLI tool\'s config.',
  },
  description: 'Read or update the local omp CLI config tree (get / set { key, value } / unset { key }).',
  capability: 'omp:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    // `value` is a typed union (not z.unknown()) so the tool's JSON Schema is
    // valid for STRICT function-calling backends (OpenAI rejects an untyped
    // empty/anyOf-without-type schema: "anyOf must contain schemas with a
    // specified type"). omp config knobs are primitives (model id, path, flag).
    z.object({
      op: z.literal('set'),
      key: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
    z.object({ op: z.literal('unset'), key: z.string().min(1) }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const sections = await readOmpConfig();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sections }) }] };
    }
    if (ctx.role !== 'operator') {
      throw new Error(`omp:config ${args.op} requires operator role`);
    }
    if (args.op === 'set') {
      const result = await setOmpConfig(args.key, args.value);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, raw: result.raw }) }] };
    }
    await unsetOmpConfig(args.key);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, unset: true, key: args.key }) }] };
  },
});
