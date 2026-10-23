import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { signSpawnParams, verifySpawnParams } from '../../spawn-signing';

type ChatParent = NonNullable<UnifiedToolContext['chatParent']>;
const ISSUER = 'converse-parent-v1';
const TTL_SEC = 30 * 60;
const KEYS = new Set(['harness', 'workspace', 'run', 'chat', 'exp', 'sig']);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const digest = (bearer: string) => createHash('sha256').update(bearer).digest('hex');
const validAuthority = (value: ChatParent['authority']) => value
  && (value.kind === 'system' || value.kind === 'pi') && identifier(value.principalId)
  && value.principalId.startsWith(`${value.kind}:`) && value.principalId.length > value.kind.length + 1
  && /^[a-f0-9]{64}$/.test(value.credentialSha256);

/** Reuse the spawn signer/key/rotation policy, in a separate signed envelope.
 * Neither SU nor PI mounts acquire a spawn role or a shared child run ID. */
export async function mintConverseChatBinding(
  parent: Omit<ChatParent, 'credentialSha256'>,
  bearer: string,
): Promise<string> {
  if (!bearer || ![parent.workspaceId, parent.conversationId, parent.turnId, parent.runId].every(identifier)
    || !validAuthority(parent.authority)) {
    throw new Error('invalid-chat-parent');
  }
  const params = new URLSearchParams({
    harness: ISSUER, workspace: parent.workspaceId, run: parent.runId,
    chat: JSON.stringify([parent.conversationId, parent.turnId, digest(bearer),
      parent.authority.kind, parent.authority.principalId, parent.authority.credentialSha256]),
  });
  await signSpawnParams(params, { ttlSec: TTL_SEC });
  return params.toString();
}

/** Authenticate the containing mount FIRST. This signature binds association
 * to that mount's current credential; it grants no capabilities. */
export async function verifyConverseChatBinding(
  token: string,
  authority: { workspaceId: string; bearer: string },
): Promise<ChatParent | null> {
  if (!token || token.length > 8192 || !authority.bearer) return null;
  const params = new URLSearchParams(token);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KEYS.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  if (seen.size !== KEYS.size || params.get('harness') !== ISSUER
    || params.get('workspace') !== authority.workspaceId || !identifier(params.get('run'))) return null;
  const exp = Number(params.get('exp'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + TTL_SEC) return null;
  if (!(await verifySpawnParams(new URL(`https://converse.invalid/?${params.toString()}`))).ok) return null;
  let payload: unknown;
  try { payload = JSON.parse(params.get('chat')!); } catch { return null; }
  if (!Array.isArray(payload) || payload.length !== 6 || !identifier(payload[0])
    || !identifier(payload[1]) || payload[2] !== digest(authority.bearer)) return null;
  const parentAuthority = { kind: payload[3], principalId: payload[4], credentialSha256: payload[5] };
  if (!validAuthority(parentAuthority)) return null;
  return { workspaceId: authority.workspaceId, conversationId: payload[0], turnId: payload[1],
    runId: params.get('run')!, credentialSha256: payload[2], authority: parentAuthority };
}
