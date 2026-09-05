/**
 * workspace:work_scope — read / set / clear the workspace WORK-SCOPE policy
 * (plan workspace-work-scope-policy-2026-09-04).
 *
 * The policy says which harnesses agents may be launched into or pull work from.
 * It is enforced at the chokepoints (agent launches, scheduler pulls / claims,
 * admission promotion, git-sync fixer dispatch, grading sweeps) — never at filing.
 * Absent ⇒ every harness allowed, byte-identical to before. set/clear are audited
 * + one-call-revertible through the control harness, exactly like pot:control_policy.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readWorkScopePolicy,
  setWorkScopePolicy,
  clearWorkScopePolicy,
  evaluateWorkScope,
  type WorkScopePolicy,
} from '../../work-scope-policy';
import { writePotControlPolicy } from '../../pot-control-policy';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const exceptionSchema = z
  .object({
    harness: z.string().min(1).max(120).optional(),
    plan: z.string().min(1).max(200).optional(),
    goal: z.string().min(1).max(200).optional(),
    workItem: z.string().min(1).max(120).optional(),
    reason: z.string().min(3).max(500),
  })
  .refine((e) => !!(e.harness || e.plan || e.goal || e.workItem), {
    message: 'an exception needs at least one of harness / plan / goal / workItem',
  });

export default defineTool({
  name: 'workspace:work_scope',
  profile: 'engineer',
  description:
    "Read or set the workspace WORK-SCOPE policy: which harnesses agents may be launched into / pull work from (e.g. allowHarnesses ['papercusp','papercusp/*']). Enforced at the chokepoints — launches, scheduler pulls/claims, admission promotion, git-sync fixer dispatch, grading sweeps — never at filing; out-of-scope work is parked, never deleted. Absent ⇒ everything allowed. set/clear are audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: "The owner wants agents confined to one project (\"only papercusp work right now\"): set { mode:'enforce', allowHarnesses:['papercusp','papercusp/*'] }. `check` answers whether one harness/plan/item would be admitted.",
    notWhen: 'To steer WHICH items inside an allowed harness a fleet pulls, use scheduler:set_claim_spec. To pause one pot entirely use pot:pause.',
    chaining: "config:list-overrides shows the active policy; the ledger on { op:'get' } shows the last denials.",
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('check'),
      harness: z.string().min(1).max(120),
      plan: z.string().min(1).max(200).optional(),
      goal: z.string().min(1).max(200).optional(),
      workItem: z.string().min(1).max(120).optional(),
    }),
    z.object({
      op: z.literal('set'),
      mode: z.enum(['enforce', 'off']).default('enforce'),
      allowHarnesses: z.array(z.string().min(1).max(120)).min(1).max(200),
      exceptions: z.array(exceptionSchema).max(200).optional(),
      reason: z.string().min(3).max(1000),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const policy = await readWorkScopePolicy();
      return json({
        ok: true,
        enforced: !!policy && policy.mode === 'enforce' && policy.allowHarnesses.length > 0,
        policy: policy
          ? { ...policy, ledger: undefined }
          : null,
        ledger: policy?.ledger ?? { entries: [], counts: { denied: 0, held: 0, rehomed: 0 } },
      });
    }
    if (args.op === 'check') {
      const policy = await readWorkScopePolicy();
      const verdict = evaluateWorkScope(
        { harness: args.harness, plan: args.plan ?? null, goal: args.goal ?? null, workItem: args.workItem ?? null },
        policy,
      );
      return json({ ok: true, verdict });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('workspace:work_scope set/clear requires operator, architect, or mug role');
    }
    const actor = `role:${ctx.role}`;
    if (args.op === 'clear') {
      const outcome = await runControlMutation<WorkScopePolicy | null>(
        {
          action: 'workspace:work_scope',
          subject: 'work-scope',
          actor,
          capturePrev: () => readWorkScopePolicy(),
          apply: async () => {
            await clearWorkScopePolicy();
            return null;
          },
          revertTo: async (prev) => {
            await writePotControlPolicy({ workScope: prev ?? undefined });
          },
          verify: async () => {
            const now = await readWorkScopePolicy();
            return { ok: now === null, detail: now === null ? undefined : 'policy still present after clear' };
          },
          describe: (prev) => ({ current: prev, patch: null }),
        },
        { dryRun: args.dryRun },
      );
      return json({ ok: true, op: 'clear', dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted, preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId });
    }

    const next = {
      mode: args.mode,
      allowHarnesses: args.allowHarnesses,
      exceptions: args.exceptions?.map((e) => ({ ...e, setBy: actor })),
      setBy: actor,
      reason: args.reason,
    };
    const outcome = await runControlMutation<WorkScopePolicy | null>(
      {
        action: 'workspace:work_scope',
        subject: 'work-scope',
        actor,
        capturePrev: () => readWorkScopePolicy(),
        apply: () => setWorkScopePolicy(next),
        revertTo: async (prev) => {
          await writePotControlPolicy({ workScope: prev ?? undefined });
        },
        verify: async (stored) => {
          const ok =
            !!stored &&
            stored.mode === next.mode &&
            stored.allowHarnesses.length === next.allowHarnesses.length &&
            stored.allowHarnesses.every((h, i) => h === next.allowHarnesses[i]!.trim());
          return { ok, detail: ok ? undefined : 'policy did not persist as written' };
        },
        describe: (prev) => ({ current: prev, patch: next }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true,
      op: 'set',
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
      policy: outcome.next ? { ...outcome.next, ledger: undefined } : null,
    });
  },
});
