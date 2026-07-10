/**
 * db:txn-timeouts — read/set/reset the per-workspace transaction timeouts at runtime
 * (live-configurability-audit-2026-06-20 P-020).
 *
 * Every state-mutating tool runs through @papercusp/locks' inWorkspaceTxn, which SETs a per-txn
 * lock_timeout (pg_advisory_xact_lock wait cap) + statement_timeout — baked at 5s/5s. Those decide
 * whether a same-workspace contention wait or a slow statement is killed (PG 55P03 / 57014 →
 * WorkspaceContendedError). This makes them settable live: mid-incident, raise lockTimeoutMs to ride
 * out same-workspace contention, or raise statementTimeoutMs to let a legitimately-slow mutation
 * finish — without a deploy through the very txn path you're tuning. Merged over the baked defaults;
 * an empty override (or the kill-switch flag OFF) is byte-identical. Audited + one-call-revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  TXN_TIMEOUTS_DEFAULTS,
  txnTimeoutsConfig,
  readTxnTimeoutsOverride,
  setTxnTimeoutsOverride,
  setTxnTimeoutsOverrideFull,
  resetTxnTimeoutsOverride,
  type TxnTimeoutsOverride,
} from '../../txn-timeouts-config';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'db:txn-timeouts',
  profile: 'engineer',
  description:
    "Read/set/reset runtime PG timeouts. (1) per-workspace inWorkspaceTxn lockTimeoutMs / statementTimeoutMs over the baked 5s/5s defaults — mid-incident raise lockTimeoutMs to ride out same-workspace contention or statementTimeoutMs to let a slow mutation finish. (2) adminPoolStatementTimeoutMs (WI-832) — a DEFAULT statement_timeout for NEW org pool connections that bounds the whole interactive admin-pool write class at the source; 0 = OFF (today's behavior). Empty override / kill-switch off (papercusp-txn-timeouts-config) = byte-identical (5s/5s + no pool default). set/reset audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'State-mutating tools are failing with workspace_contended (PG lock_timeout 55P03 / statement_timeout 57014) under same-workspace contention, and you need to widen the window for the incident — raise lockTimeoutMs and/or statementTimeoutMs. get to inspect the effective timeouts + override.',
    notWhen: 'Not for the DEPLOY-migration lock_timeout (db:migrate-policy), nor for the BOOT migration timeout (env/code). This only sizes the per-workspace inWorkspaceTxn lock_timeout/statement_timeout.',
    chaining: 'config:list-overrides shows the active txn-timeouts override; config:reset-overrides reverts it. The kill-switch papercusp-txn-timeouts-config (default ON) forces the baked 5s/5s defaults when OFF.',
    seeAlso: [
      'db:migrate-policy (deploy-migration lock_timeout)',
      'dev:pg_active_queries (queries hitting the timeout)',
      'config:list-overrides (active txn-timeouts override)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      // z.coerce so a numeric arg that arrives JSON-stringified ("30000") from an MCP
      // client with a stale/loosely-typed schema still validates (proven real for the
      // WI-832 field during a rolling deploy when the advertised schema lagged the handler).
      lockTimeoutMs: z.coerce.number().int().min(1000).max(120_000).optional(),
      statementTimeoutMs: z.coerce.number().int().min(1000).max(600_000).optional(),
      // WI-832: default statement_timeout (ms) for NEW org POOL connections — bounds the
      // whole interactive admin-pool write class at the source. 0 = OFF (unset GUC = the
      // admin pool stays deliberately unbounded). OWNER-GATED to a non-zero value live:
      // migrations share this pool and opt out per-txn (SET LOCAL statement_timeout=0); a
      // too-small value would kill long migrations. Distinct from statementTimeoutMs (the
      // per-workspace inWorkspaceTxn cap).
      adminPoolStatementTimeoutMs: z.coerce.number().int().min(0).max(600_000).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('reset'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return json({ effective: txnTimeoutsConfig(), defaults: TXN_TIMEOUTS_DEFAULTS, override: await readTxnTimeoutsOverride() });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('db:txn-timeouts requires operator, architect, or mug role');
    }

    const patch: TxnTimeoutsOverride =
      args.op === 'set'
        ? {
            ...(args.lockTimeoutMs !== undefined ? { lockTimeoutMs: args.lockTimeoutMs } : {}),
            ...(args.statementTimeoutMs !== undefined ? { statementTimeoutMs: args.statementTimeoutMs } : {}),
            ...(args.adminPoolStatementTimeoutMs !== undefined ? { adminPoolStatementTimeoutMs: args.adminPoolStatementTimeoutMs } : {}),
          }
        : {};
    if (args.op === 'set' && Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of lockTimeoutMs / statementTimeoutMs / adminPoolStatementTimeoutMs (or use op:reset)');
    }

    const outcome = await runControlMutation<TxnTimeoutsOverride>(
      {
        action: 'db:txn-timeouts',
        subject: 'txn-timeouts',
        actor: `role:${ctx.role}`,
        capturePrev: () => readTxnTimeoutsOverride(),
        apply: async () => {
          if (args.op === 'reset') {
            await resetTxnTimeoutsOverride();
            return {};
          }
          return setTxnTimeoutsOverride(patch);
        },
        revertTo: (prev) => setTxnTimeoutsOverrideFull(prev),
        verify: async () => {
          const cur = await readTxnTimeoutsOverride();
          if (args.op === 'reset') {
            const ok = Object.keys(cur).length === 0;
            return { ok, detail: ok ? undefined : 'override not cleared' };
          }
          const ok = (Object.keys(patch) as (keyof TxnTimeoutsOverride)[]).every((k) => cur[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'override did not persist' };
        },
        describe: (prev) => ({ op: args.op, proposed: patch, had: prev }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
      effective: txnTimeoutsConfig(),
    });
  },
});
