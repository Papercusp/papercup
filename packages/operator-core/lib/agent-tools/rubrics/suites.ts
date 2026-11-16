/** Extend rubrics with suite authoring and reads; instances remain ordinary plans. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { ctxToPlanSourceOpts } from '../plans/_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { readSuiteDefinitionPage, writeRubricSuite, readSuiteScorecardResult, readSuiteScorecardPage, SUITE_MAX_PAGE_SIZE, SUITE_RESULT_PAGE_BYTES } from '../../rubric-suites';

const common = { suiteRef: z.string().min(1), harness: harnessArg };
const cursorSchema = z.object({ suiteRef: z.string().min(1), scopeKey: z.string(), version: z.number().int().positive(), offset: z.number().int().nonnegative(), comparisonTime: z.string().datetime({ offset: true }), sourceFingerprint: z.string().optional() });
export default defineTool({
  name: 'rubrics:suite',
  description: 'Create, edit or read a rubric suite, an ordinary rubric-suite plan record. The member array replaces membership atomically; omitted metadata stays unchanged. A rubric can belong to several suites. Read members with rubrics:list {suiteRef}.',
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ ...common, op: z.enum(['create', 'edit', 'get']), name: z.string().min(1).optional(),
    limit: z.number().int().positive().max(SUITE_MAX_PAGE_SIZE).optional(), cursor: cursorSchema.optional(),
    purpose: z.string().min(1).optional(), owner: z.string().min(1).optional(),
    members: z.array(z.object({ rubricRef: z.string().min(1) }).strict()).optional(),
    rescoreIntervalMs: z.number().int().positive().safe().nullable().optional(), expectedVersion: z.number().int().positive().optional() }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const scope = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      const result = args.op === 'get' ? await readSuiteDefinitionPage(args.suiteRef, { scope, limit: args.limit, cursor: args.cursor }) :
        await writeRubricSuite({ ...args, create: args.op === 'create' }, scope, ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
  },
});

export const suiteScorecardTool = defineTool({
  name: 'rubrics:suite-scorecard',
  description: 'Read suite verdict and coverage from the complete population; member details use bounded display pages. Follow next with the same suiteRef and harness to recover every member; persist the cursor on the existing run/checkpoint. complete is false while records remain. page:true reads only a member page without an aggregate verdict.',
  capability: 'coord:read', requirePrincipal: false, agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({ ...common, page: z.boolean().optional(), limit: z.number().int().positive().max(SUITE_MAX_PAGE_SIZE).optional(),
    cursor: cursorSchema.optional() }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const scope = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      const opts = { scope, cursor: args.cursor, limit: args.limit, byteLimit: SUITE_RESULT_PAGE_BYTES - 128 };
      const result = args.page ? await readSuiteScorecardPage(args.suiteRef, opts) : await readSuiteScorecardResult(args.suiteRef, opts);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    });
  },
});
