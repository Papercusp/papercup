import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import { deliverCommittedCardResponse, type CardResponse, type CardSpec, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { CardSpec as PersistedCardSpec, ChatTurnToolCall } from '@papercusp/chat-protocol';
import { InteractionResolver, type InteractionRecord, type InteractionScope } from '@papercusp/chat-protocol/interactions';
import { canonicalJson } from '../../external-bench/reproducibility/canonical-json';
import { coerceAskChoiceOptions } from '../../ask-choice-options';
import { OperatorChatStore, operatorChatChildAuthority, operatorChatParentAuthority,
  operatorChatTurnWorkflow, operatorChatTurnChannel, type OperatorChatInteractionBinding, type OperatorChatStoreOptions } from '../../operator-chat-store';
import { hubListen } from '../../pg-listen-hub';

type Parent = Omit<NonNullable<UnifiedToolContext['chatParent']>, 'credentialSha256'>;
type Binding = Omit<OperatorChatInteractionBinding, 'nativeCallId'>;
const schemaId = (spec: PersistedCardSpec) => `chat:ask_choice:${createHash('sha256').update(canonicalJson(spec)).digest('hex')}`;

/** Recovery/HTTP ingress needs no live waiter or child process. Lookup is
 * scoped by the authenticated workspace and URL conversation; returned data
 * is reauthorized by createConverseCard under each transaction's locks. */
export async function findConverseCard(input: {
  sql: postgres.Sql; workspaceId: string; conversationId: string; correlationId: string;
  authorizeAdditional: OperatorChatStoreOptions['authorize'];
}) {
  const { sql, workspaceId, conversationId, correlationId, authorizeAdditional } = input;
  const found = await OperatorChatStore.findInteraction({ sql, workspaceId, conversationId,
    correlationId, authorize: authorizeAdditional });
  return found ? createConverseCard({ sql, ...found, correlationId, authorizeAdditional }) : null;
}

export async function findConverseRunCards(input: {
  sql: postgres.Sql; workspaceId: string; conversationId: string; runId: string;
  authorizeAdditional: OperatorChatStoreOptions['authorize'];
}) {
  const { sql, workspaceId, conversationId, runId, authorizeAdditional } = input;
  if (!workspaceId || workspaceId === '*' || !runId || runId.length > 512
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)) return null;
  const ids = await sql.begin(async tx => {
    if (!await authorizeAdditional(tx)) throw new Error('unauthorized');
    return tx.unsafe<{ correlation_id: string }[]>(`SELECT entry.key AS correlation_id
      FROM harness_shared.operator_turns t
      CROSS JOIN LATERAL jsonb_each(COALESCE(t.chat_state->'interactionBindings','{}'::jsonb)) entry
      WHERE t.workspace_id=$1 AND t.conversation_id=$2 AND t.role='assistant'
        AND (t.chat_state->'execution'->>'runId'=$3 OR entry.value->>'childRunId'=$3)
      LIMIT 1001`, [workspaceId, conversationId, runId]);
  });
  if (ids.length === 0) return null;
  if (ids.length > 1000) throw new Error('interaction-run-overflow');
  const cards = [];
  for (const { correlation_id: correlationId } of ids) {
    const card = await findConverseCard({ sql, workspaceId, conversationId, correlationId, authorizeAdditional });
    if (!card) throw new Error('needs-reconciliation');
    cards.push(card);
  }
  return cards;
}

/** Concrete adapter for the existing ask_choice/store/resolver ports. It is
 * deliberately not enabled by constructing a turn: host and ALL ingress
 * paths must bind current responder authority before installing these hooks.
 * No map or model event is an authority or a correlation mechanism. */
export function createConverseCard(input: {
  sql: postgres.Sql; parent: Parent; binding: Binding; tool: ChatTurnToolCall;
  correlationId?: string;
  /** HTTP/inbox ingress supplies its current authenticated responder fence.
   * Tool-owned timeout/abort uses only the original parent and current child. */
  authorizeAdditional?: OperatorChatStoreOptions['authorize'];
}) {
  const { sql, authorizeAdditional } = input;
  const parent = structuredClone(input.parent);
  const binding = structuredClone(input.binding);
  const tool = structuredClone(input.tool);
  const workspaceId = parent.workspaceId;
  const turn = { conversationId: parent.conversationId, turnId: parent.turnId };
  const principalId = parent.authority.principalId;
  const scope: InteractionScope = { principalId, tenantId: workspaceId, customerId: principalId, publicOwnerId: principalId };
  const currentParent = operatorChatParentAuthority({ workspaceId, authority: parent.authority,
    capability: 'chat:write', toolName: 'chat:ask_choice' });
  const currentChild = operatorChatChildAuthority({ workspaceId, credentialSha256: binding.credentialSha256,
    capability: 'chat:write', toolName: 'chat:ask_choice' });
  const store = new OperatorChatStore({ sql, workspaceId, turn, scope,
    authorize: async tx => await currentParent(tx) && await currentChild(tx)
      && (!authorizeAdditional || await authorizeAdditional(tx)) });
  let correlationId = input.correlationId ?? null;
  const identity = () => {
    if (!correlationId) throw new Error('interaction-not-prepared');
    return { conversationId: turn.conversationId, correlationId };
  };
  const resolver: InteractionResolver = new InteractionResolver({
    store: store.interactions(operatorChatTurnWorkflow({ workspaceId, turn }), { parent, binding }),
    async validate(schema, value) {
      // Schema revisions are content addressed in the existing persisted card,
      // so a worker needs no second schema registry after a restart.
      const read = await resolver.read(identity(), scope);
      if (!read.ok || schema.revision !== 1 || schema.id !== read.value.schema.id
        || schema.id !== schemaId(read.value.spec)) return { ok: false };
      const presentation = read.value.spec.presentation;
      if (presentation?.kind !== 'radio' && presentation?.kind !== 'checkbox') return { ok: false };
      const options = presentation.options;
      if (!Array.isArray(options)) return { ok: false };
      const picks = value.picks;
      if (Object.keys(value).length !== 1 || !Array.isArray(picks) || picks.length < 1 || picks.length > 6
        || (presentation.kind === 'radio' && picks.length !== 1) || new Set(picks).size !== picks.length
        || picks.some(pick => typeof pick !== 'string' || !options.some(option => option.id === pick))) {
        return { ok: false };
      }
      return { ok: true, value: structuredClone(value) };
    },
  });
  const responseOf = (record: InteractionRecord): CardResponse => {
    if (record.status === 'cancelled') return { action: 'cancel' };
    if (record.status !== 'resolved' || !record.decision) throw new Error('needs-reconciliation');
    return record.decision.response.action === 'submit'
      ? { action: 'submit', payload: structuredClone(record.decision.response.value) }
      : { action: record.decision.response.action };
  };
  const commitResponse: NonNullable<CardSpec['commitResponse']> = async (response, info) => {
    if (info.workspaceId !== workspaceId || info.runId !== binding.childRunId || info.correlationId !== correlationId) {
      throw new Error('unauthorized');
    }
    const current = await resolver.read(identity(), scope);
    if (!current.ok) throw new Error(current.code);
    if (current.value.status !== 'pending') return { accepted: false, response: responseOf(current.value) };
    const result = response.action === 'cancel'
      ? await resolver.cancel(identity(), scope, current.value.revision)
      : await resolver.resolve(identity(), scope, { submissionId: randomUUID(), revision: current.value.revision,
        response: response.action === 'submit'
          ? { action: 'submit', correlationId, value: response.payload }
          : { action: 'decline', correlationId } });
    if (result.ok) {
      const committed = await resolver.read(identity(), scope);
      if (!committed.ok) throw new Error(committed.code);
      return { accepted: true, response: responseOf(committed.value) };
    }
    // Reconcile a known competitor without retrying the write. An unknown
    // write outcome remains an error even if a later row happens to resolve.
    if (result.code === 'already-decided' || result.code === 'cancelled') {
      const winner = await resolver.read(identity(), scope);
      if (winner.ok && winner.value.status !== 'pending') return { accepted: false, response: responseOf(winner.value) };
    }
    throw new Error(result.code);
  };
  return {
    store, resolver, scope,
    info: () => ({ correlationId: identity().correlationId, runId: binding.childRunId, workspaceId }),
    read: () => resolver.read(identity(), scope),
    commitResponse,
    /** Reconnect and onCard both use this same reauthorized read. A wake is
     * only a hint, never a decision receipt or permission to replay a write. */
    async listen(onError: (error: unknown) => void, listen = hubListen) {
      let stopped = false, dirty = false;
      let reading: Promise<void> | null = null;
      const refresh = (): Promise<void> => {
        if (stopped || !correlationId) return Promise.resolve();
        dirty = true;
        if (reading) return reading;
        reading = (async () => {
          while (dirty && !stopped) {
            dirty = false;
            const read = await resolver.read(identity(), scope);
            if (stopped) return;
            if (!read.ok) throw new Error(read.code);
            if (read.value.status !== 'pending') deliverCommittedCardResponse({
              ...identity(), runId: binding.childRunId, workspaceId, response: responseOf(read.value),
            });
          }
        })().finally(() => { reading = null; });
        return reading;
      };
      const nudge = () => { void refresh().catch(error => { if (!stopped) onError(error); }); };
      const stop = await listen(operatorChatTurnChannel(workspaceId, turn), nudge, nudge);
      // Read AFTER LISTEN as well: any commit during registration is now
      // either visible in this read or covered by a notification.
      try { await refresh(); } catch (error) { stopped = true; stop(); throw error; }
      return { refresh, stop() { stopped = true; stop(); } };
    },
    hooks(spec: Pick<CardSpec, 'prompt' | 'allowDecline' | 'presentation' | 'fallbackText' | 'timeoutMs' | 'report'>): Pick<CardSpec, 'beforeCard' | 'commitResponse'> {
      // Persist only protocol data, never schema objects or callback functions.
      const persisted: PersistedCardSpec = { prompt: spec.prompt, allowDecline: spec.allowDecline ?? true,
        ...(spec.presentation === undefined ? {} : { presentation: structuredClone(spec.presentation) }),
        ...(spec.fallbackText === undefined ? {} : { fallbackText: spec.fallbackText }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(spec.report === undefined ? {} : { report: structuredClone(spec.report) }) };
      const args = tool.input as Record<string, unknown> | undefined;
      const presentation = persisted.presentation;
      if (!presentation || (presentation.kind !== 'radio' && presentation.kind !== 'checkbox')
        || !args || args.question !== persisted.prompt
        || presentation.kind !== (args.multi === true ? 'checkbox' : 'radio')
        || !isDeepStrictEqual(presentation.options, coerceAskChoiceOptions(args.options))) {
        throw new Error('interaction-binding-conflict');
      }
      return { commitResponse, beforeCard: async info => {
        if (info.workspaceId !== workspaceId || info.runId !== binding.childRunId
          || (correlationId !== null && info.correlationId !== correlationId)) throw new Error('unauthorized');
        correlationId = info.correlationId;
        const clock = await sql.unsafe<{ now: number }[]>(
          'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS now');
        const timeout = persisted.timeoutMs ?? 600_000;
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000) throw new Error('invalid-card-timeout');
        const record: InteractionRecord = { schemaVersion: 1, ...identity(), scope,
          schema: { id: schemaId(persisted), revision: 1 }, spec: persisted,
          revision: 0, expiresAt: clock[0].now + timeout, status: 'pending' };
        if (!await store.prepareInteraction({ record, parent, binding, tool })) throw new Error('needs-reconciliation');
      } };
    },
    async associateNative(nativeCallId: string) {
      return store.associateInteractionCall({ parent, ...binding, correlationId: identity().correlationId, nativeCallId });
    },
  };
}
