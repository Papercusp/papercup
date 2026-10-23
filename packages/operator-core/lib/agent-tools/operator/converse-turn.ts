import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ChatTurnSource } from '@papercusp/chat-protocol';
import { OperatorChatStore, operatorChatSessionAuthority,
  type OperatorChatCredential, type OperatorChatStoreOptions } from '../../operator-chat-store';
import { mintConverseChatBinding, verifyConverseCardBinding, readConverseCardBinding } from './converse-chat-binding';
import { canonicalToolName } from '../../operator-mcp-tools';
import { canonicalAskChoiceInput } from '../../ask-choice-options';

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
  let childBearer: string | null = null;
  const associations: Promise<void>[] = [];
  let associationError: unknown = null;
  return {
    store,
    identity: { ...options.turn },
    async bindMount(mount: { url: string; bearer: string }) {
      const url = new URL(mount.url);
      // The child keeps its own run. Only the separate signed association is
      // attached; raw run/conversation parameters never establish a parent.
      url.searchParams.set('chat_binding', await mintConverseChatBinding(parent, mount.bearer));
      childBearer = mount.bearer;
      return { ...mount, url: url.toString() };
    },
    /** runAgentChat calls this at its exact native result seam. Promise work
     * is retained here because the observer itself is synchronous. */
    observeToolResult(result: { name: string; output: string; isError: boolean; callId?: string }) {
      if (canonicalToolName(result.name) !== 'chat:ask_choice') return;
      const { output, callId, isError } = result;
      const bearer = childBearer;
      associations.push(Promise.resolve().then(async () => {
        const token = readConverseCardBinding(output);
        if (token === null) return;
        if (isError || !bearer || !callId || !callId.trim() || callId.length > 256) {
          throw new Error('invalid-card-binding');
        }
        const binding = await verifyConverseCardBinding(token, { parent, childBearer: bearer });
        if (!binding) throw new Error('invalid-card-binding');
        await store.associateInteractionCall({ ...binding, parent, nativeCallId: callId });
      }).catch(error => { associationError ??= error; }));
    },
    async finalize(result: Omit<Parameters<OperatorChatStore['finalizeTurn']>[0], 'runId'>) {
      // A native result may have arrived just before the generator closed.
      // Never finalize ahead of its signed association transaction.
      let settled = 0;
      while (settled < associations.length) {
        const pending = associations.slice(settled);
        settled += pending.length;
        await Promise.all(pending);
      }
      if (associationError) throw associationError;
      const tools = result.tools?.map(tool => canonicalToolName(tool.name) === 'chat:ask_choice'
        ? { ...tool, input: canonicalAskChoiceInput(tool.input) ?? tool.input } : tool);
      return store.finalizeTurn({ ...result, ...(tools ? { tools } : {}), runId });
    },
  };
}
