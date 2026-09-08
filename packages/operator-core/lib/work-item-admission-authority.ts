/** Transport-authenticated identity for original-item recovery. No saved grants or bearers. */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { lookupByMcpName, papercuspGateBypass, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { DEFAULT_DISPATCH_STACK, runDispatchStack, withReplacedStep } from '@papercusp/tooldef';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { readSuperuserToken } from './superuser-token';
import { synthesizeDispatchPrincipal } from './endpoint-route/routes/transport/role-principal-caps';
import { runWithWorkspaceIfConcrete } from './workspace-als';
import type { AdmissionRecoveryScope } from './work-item-admission-recovery';

export const admissionAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('superuser'), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('signed-spawn'), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.string().min(1), expiresAtSec: z.number().finite().nonnegative(),
  }).strict(),
]);
export type AdmissionRecoveryAuthority = z.infer<typeof admissionAuthoritySchema>;
/** Private context field set ONLY at successful transport authentication. Never a tool arg. */
export type AdmissionAuthorityContext = { admissionRecoveryAuthority?: AdmissionRecoveryAuthority };
export const admissionCredentialDigest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

export class AdmissionAuthorityRefused extends Error {}

/**
 * Renew the ORIGINAL authenticated credential, then rebuild CURRENT grants. A role
 * label in presence, isSuperuser alone, and a saved gateBypass are not credentials.
 * Power-user/PI and legacy requests have no renewable proof here and fail closed.
 */
export async function admissionReplayContext(
  sql: Sql, scope: AdmissionRecoveryScope, caller: string, value: unknown,
): Promise<UnifiedToolContext> {
  const parsed = admissionAuthoritySchema.safeParse(value);
  if (!parsed.success) throw new AdmissionAuthorityRefused('authenticated recovery binding missing; retry this same item through its authenticated dispatch door');
  const authority = parsed.data;
  const isSuperuser = authority.kind === 'superuser';
  if (isSuperuser) {
    const token = readSuperuserToken();
    if (!token || admissionCredentialDigest(token) !== authority.credentialSha256) {
      throw new AdmissionAuthorityRefused('original superuser credential was revoked or rotated');
    }
  } else {
    if (authority.expiresAtSec !== 0 && authority.expiresAtSec < Math.floor(Date.now() / 1000)) {
      throw new AdmissionAuthorityRefused('original signed-spawn credential expired');
    }
    const [key] = await sql<{ value_b64: string }[]>`
      SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'`;
    if (!key || admissionCredentialDigest(decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key')) !== authority.credentialSha256) {
      throw new AdmissionAuthorityRefused('original signed-spawn credential was revoked or rotated');
    }
  }
  return {
    workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, uiClientId: caller,
    role: authority.role as UnifiedToolContext['role'], isSuperuser, sigVerifiedSpawn: !isSuperuser,
    principal: await synthesizeDispatchPrincipal(sql, {
      workspaceId: scope.workspaceId, role: authority.role, isSuperuser, sigVerifiedSpawn: !isSuperuser,
    }),
    // Recompute today's policy; never deserialize a stored bypass or capability list.
    gateBypass: papercuspGateBypass({ isSuperuser, isPowerUser: false, role: authority.role }),
    transport: 'in_process', runId: `admission-authority:${randomUUID()}`,
    signal: new AbortController().signal, log: () => {}, emit: () => {}, progress: () => {},
  };
}

/** All canonical gates, no tool handler. Preflight is NOT an invocation/completion receipt. */
export async function authorizeAdmissionReplay(
  sql: Sql, scope: AdmissionRecoveryScope,
  request: { caller: string; target: string; authority?: AdmissionRecoveryAuthority; note?: string; body?: string },
): Promise<void> {
  const ctx = await admissionReplayContext(sql, scope, request.caller, request.authority);
  const { PROJECTED_DEPS } = await import('./projected-tool-deps');
  // Background hosts need the same definitions as the public dispatch, not a
  // synthetic "permission tool" whose declarations can drift from the real tools.
  await import('./agent-tools/coordination/tools/dispatch');
  await import('./agent-tools/work_items/claim');
  const stack = withReplacedStep(DEFAULT_DISPATCH_STACK, 'invoke', async () => ({
    ok: true, result: { content: [] },
  }));
  for (const [name, input] of [
    ['coord:dispatch', {
      to: request.target, harness: scope.harnessSlug, workItemIds: [scope.workItemId],
      note: request.note ?? `Resume original work item ${scope.workItemId}`,
      ...(request.body !== undefined ? { body: request.body } : {}), resumeAdmission: true,
    }],
    ['work_items:claim', { row: `${scope.workItemId},${request.target},${scope.harnessSlug}` }],
  ] as const) {
    const tool = lookupByMcpName(name);
    if (!tool) throw new AdmissionAuthorityRefused(`canonical ${name} definition unavailable`);
    const verdict = await runWithWorkspaceIfConcrete(scope.workspaceId, () =>
      runDispatchStack(tool, name, input, ctx, {
        ...PROJECTED_DEPS,
        // Preserve authorization auditing, but do not mint success telemetry,
        // fire post-invoke reactions or mark a no-handler probe as real work.
        onDispatchStart: undefined, recordInvocation: undefined, postInvoke: undefined,
      }, stack));
    if (!verdict.ok) throw new AdmissionAuthorityRefused(`${name}: ${verdict.error?.message ?? 'current authority denied'}`);
  }
}
