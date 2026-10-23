import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ChatTurnSource } from '@papercusp/chat-protocol';
import { OperatorChatStore, operatorChatSessionAuthority,
  type OperatorChatCredential, type OperatorChatStoreOptions } from '../../operator-chat-store';
import { mintConverseChatBinding } from './converse-chat-binding';

type Parent = Omit<NonNullable<UnifiedToolContext['chatParent']>, 'credentialSha256'>;
type Credential = Extract<OperatorChatCredential, { kind: 'system' | 'pi' }>;

/** The host supplies authenticated authority and scope. No model/URL/card field
 * is an authority input. Reserve the existing PG turn before giving a provider
 * a mount, and retain the ORIGINAL parent credential across child PI mounts. */
export async function admitConverseTurn(input: {
  options: Omit<OperatorChatStoreOptions, 'authorize'>;
  credential: Credential;
  capability: string;
  toolName: string;
  runId: string;
  source: ChatTurnSource;
}) {
  const credential = { ...input.credential };
  const principalId = credential.kind === 'system' ? `system:${credential.name}` : `pi:${credential.sessionId}`;
  if (!credential.bearer || input.options.scope.principalId !== principalId) throw new Error('unauthorized');
  const options = { ...input.options, turn: { ...input.options.turn }, scope: { ...input.options.scope } };
  const runId = input.runId;
  const store = new OperatorChatStore({ ...options,
    authorize: operatorChatSessionAuthority({ workspaceId: options.workspaceId, principalId,
      credential, capability: input.capability, toolName: input.toolName }) });
  const parent: Parent = { workspaceId: options.workspaceId, ...options.turn, runId,
    authority: { kind: credential.kind, principalId,
      credentialSha256: createHash('sha256').update(credential.bearer).digest('hex') } };
  // false is an existing execution, including an uncertain admission ACK.
  // It must enter recovery; it is never permission to launch a second provider.
  if (!await store.beginTurn(runId, input.source, parent.authority)) throw new Error('needs-reconciliation');
  return {
    store,
    identity: { ...options.turn },
    async bindMount(mount: { url: string; bearer: string }) {
      const url = new URL(mount.url);
      // The child keeps its own run. Only the separate signed association is
      // attached; raw run/conversation parameters never establish a parent.
      url.searchParams.set('chat_binding', await mintConverseChatBinding(parent, mount.bearer));
      return { ...mount, url: url.toString() };
    },
    finalize(result: Omit<Parameters<OperatorChatStore['finalizeTurn']>[0], 'runId'>) {
      return store.finalizeTurn({ ...result, runId });
    },
  };
}
