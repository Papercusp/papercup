/** Extend rubrics with suite authoring and reads; instances remain ordinary plans. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { ctxToPlanSourceOpts } from '../plans/_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { readSuiteDefinitionPage, writeRubricSuite, advanceRubricSuiteRun, readSuiteScorecardPage, SUITE_MAX_PAGE_SIZE, SUITE_RESULT_PAGE_BYTES } from '../../rubric-suites';

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
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/rubrics/suites.ts#<module>/handler:f162151dabc6d2031724:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const scope = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      // notify-classification: {"id":"packages/operator-core/lib/agent-tools/rubrics/suites.ts#<module>/handler/<callback>:433416c274e2a150f7b2:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      const result = args.op === 'get' ? await readSuiteDefinitionPage(args.suiteRef, { scope, limit: args.limit, cursor: args.cursor }) :
        await writeRubricSuite({ ...args, create: args.op === 'create' }, scope, ctx);
      return { data: result };
    });
  },
});

export const suiteScorecardTool = defineTool({
  name: 'rubrics:suite-scorecard',
  description: 'Read suite verdict with durable progress in the existing suite plan runs. Each call processes one history page. Follow next with the same suiteRef/harness until scanComplete. Pending scans are unknown/NO-GO. Finished scans verify the collected population before returning verdict/coverage and byte-bounded member details; follow next.runId/cursor for remaining details. page:true reads a member page without an aggregate verdict.',
  capability: 'coord:read', requirePrincipal: false, agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({ ...common, page: z.boolean().optional(), limit: z.number().int().positive().max(SUITE_MAX_PAGE_SIZE).optional(),
    runId: z.number().int().positive().safe().optional(), cursor: cursorSchema.optional() }).superRefine((args, ctx) => {
      if (args.page && args.runId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runId'], message: 'runId is for aggregate scans; omit page:true' });
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/rubrics/suites.ts#<module>/handler:c79819adb97d79302c9a:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      const scope = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
      const opts = { scope, runId: args.runId, cursor: args.cursor, limit: args.limit, byteLimit: SUITE_RESULT_PAGE_BYTES - 128 };
      // notify-classification: {"id":"packages/operator-core/lib/agent-tools/rubrics/suites.ts#<module>/handler/<callback>:bc99923b9e1d104f9c36:1","classification":"durable","reason":"Unresolved callback branches reach notification roots at this exact source site. No loss-tolerance or terminal-delivery proof is established; preserve the delivery requirement through wrappers. Delivery remains unverified.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      const result = args.page ? await readSuiteScorecardPage(args.suiteRef, opts) : await advanceRubricSuiteRun(args.suiteRef, opts);
      return { data: result };
    });
  },
});
