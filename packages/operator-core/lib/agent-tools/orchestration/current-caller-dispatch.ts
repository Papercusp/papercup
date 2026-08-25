/**
 * The one current-caller dispatch wrapper for recipe-script execution.
 *
 * Inline code:run, saved-recipe replay, and future durable execution must all
 * enter this wrapper before the real projected-tool dispatcher. It reproduces
 * the workspace/principal/transaction binding of a direct MCP call for every
 * nested dispatch and forces lossless in-process result semantics. A recipe
 * carries source and revision metadata only; no author privilege reaches here.
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
import {
  boundWorkspaceTx,
  type UnifiedToolContext,
  type WrapDispatch,
} from '@papercusp/agent-mcp';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import {
  dispatchNeedsTx,
  effectiveDispatchWorkspace,
  synthesizeDispatchPrincipal,
} from '../../endpoint-route/routes/transport/role-principal-caps';

/**
 * Rebind one nested orchestration call exactly as a direct MCP dispatch would.
 *
 * The common concrete-workspace path reuses an already-correct outer
 * transaction. Unscoped-superuser workspace hops, cross-workspace tools, and
 * transaction-free tools receive the same per-call binding they get outside a
 * recipe script. Every path gets code-mode, full-payload, transport-cap-exempt
 * semantics because intermediate values stay inside the script runtime.
 */
export const bindCurrentCallerDispatch: WrapDispatch = async (tool, _toolName, args, ctx, next) => {
  const spawnCtxLike = {
    workspaceId: ctx.workspaceId ?? '',
    role: ctx.role ?? '',
    isSuperuser: ctx.isSuperuser,
  };
  const effectiveWs = effectiveDispatchWorkspace(spawnCtxLike, args);

  const baseCtx: UnifiedToolContext = {
    ...ctx,
    contextTier: undefined,
    transportCapExempt: true,
    codeMode: true,
  };

  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const callCtx: UnifiedToolContext = {
      ...baseCtx,
      workspaceId: effectiveWs,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, { ...spawnCtxLike, workspaceId: effectiveWs }),
    };
    return runWithWorkspaceIfConcrete(effectiveWs, () => next(callCtx));
  }

  const outerTx = boundWorkspaceTx(ctx);
  if (
    tool.needsWorkspaceTx === true &&
    effectiveWs === spawnCtxLike.workspaceId &&
    outerTx !== undefined
  ) {
    return next({ ...baseCtx, tx: outerTx });
  }

  const callSpawnCtx = { ...spawnCtxLike, workspaceId: effectiveWs };
  if (!dispatchNeedsTx(callSpawnCtx)) {
    return runWithWorkspaceIfConcrete(effectiveWs, () => next({ ...baseCtx, workspaceId: effectiveWs }));
  }

  if (tool.needsWorkspaceTx !== true) {
    return runWithWorkspaceIfConcrete(effectiveWs, () =>
      withWorkspace(effectiveWs, async (tx) => {
        const principal = await synthesizeDispatchPrincipal(tx, callSpawnCtx);
        return next({ ...baseCtx, workspaceId: effectiveWs, tx: undefined, principal });
      }),
    );
  }

  return runWithWorkspaceIfConcrete(effectiveWs, () =>
    withWorkspace(effectiveWs, async (tx) => {
      const callCtx: UnifiedToolContext = {
        ...baseCtx,
        workspaceId: effectiveWs,
        tx,
        principal: await synthesizeDispatchPrincipal(tx, callSpawnCtx),
      };
      return next(callCtx);
    }),
  );
};
