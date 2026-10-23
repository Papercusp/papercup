import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { coerceAskChoiceOptions } from './ask-choice-options';
import { canonicalToolName } from './operator-mcp-tools';
import { chatEventChannel, parseChatEnvelope, parseChatState,
  type ChatEventEnvelope } from '@papercusp/chat-protocol';
import type { DispatchAdmission, ReplayWindow, TurnCheckpoint, TurnCheckpointStore,
  TurnIdentity } from '@papercusp/chat-protocol/recovery';
import type { InteractionIdentity, InteractionMutation, InteractionRecord, InteractionResult,
  InteractionScope, InteractionStore } from '@papercusp/chat-protocol/interactions';

type Tx = postgres.TransactionSql;
interface StoredTurn {
  schemaVersion: 1;
  scope: InteractionScope;
  checkpoint: TurnCheckpoint | null;
  events: ChatEventEnvelope[];
  interactions: Record<string, InteractionRecord>;
}
interface LockedTurn { chat_state: unknown }
class OperatorChatAuthorizationError extends Error {
  constructor() { super('unauthorized'); }
}

export interface OperatorChatStoreOptions {
  sql: postgres.Sql;
  workspaceId: string;
  turn: TurnIdentity;
  scope: InteractionScope;
  /** Resolve current host authority and lock its session/ACL rows in THIS
   * transaction. Revocation must serialize with that same authority fence.
   * No permission is inferred from a turn, card, model event or scope string. */
  authorize(tx: Tx): Promise<boolean>;
  /** Existing converse replay policy is 5000. Smaller windows exercise eviction;
   * a caller cannot widen the production ceiling. */
  replayLimit?: number;
}

/** Credentials are captured by the host at admission, never supplied by a
 * card/model payload. The current rows, rather than a cached Principal, are
 * rechecked under the same lock as each read, decision and dispatch. */
export type OperatorChatCredential =
  | { kind: 'user-session'; token: string; userId: string }
  | { kind: 'system'; bearer: string; name: string }
  | { kind: 'pi'; bearer: string; sessionId: string };

export function operatorChatSessionAuthority(input: {
  workspaceId: string; principalId: string; credential: OperatorChatCredential;
  capability: string; toolName: string;
}): OperatorChatStoreOptions['authorize'] {
  const { workspaceId, principalId, capability, toolName } = input;
  const credential = { ...input.credential };
  const hash = credential.kind === 'user-session' ? null
    : createHash('sha256').update(credential.bearer).digest('hex');
  return async tx => {
    if (!workspaceId || !principalId || !capability || !toolName) return false;
    let rows: Array<{ capabilities: unknown; allowed_tools?: unknown }>;
    if (credential.kind === 'user-session') {
      if (!credential.token || credential.userId !== principalId) return false;
      rows = await tx.unsafe(`SELECT s.capabilities FROM harness_shared.user_sessions s
        JOIN harness_shared.users u ON u.id=s.user_id
        WHERE s.token=$1 AND s.workspace_id=$2 AND s.user_id=$3
          AND s.expires_at>clock_timestamp() AND u.is_active=true FOR SHARE OF s,u`,
      [credential.token, workspaceId, principalId]);
    } else if (credential.kind === 'system') {
      if (!credential.bearer || principalId !== `system:${credential.name}`) return false;
      rows = await tx.unsafe(`SELECT capabilities FROM harness_shared.system_principals
        WHERE workspace_id=$1 AND name=$2 AND bearer_hash=$3 FOR SHARE`,
      [workspaceId, credential.name, hash]);
    } else {
      if (!credential.bearer || principalId !== `pi:${credential.sessionId}`) return false;
      rows = await tx.unsafe(`SELECT capabilities,allowed_tools FROM harness_shared.pi_sessions
        WHERE workspace_id=$1 AND session_id=$2 AND bearer_hash=$3 AND ended_at IS NULL
          AND expires_at>clock_timestamp() FOR SHARE`, [workspaceId, credential.sessionId, hash]);
    }
    const row = rows[0];
    // Match the existing dispatcher: only the exact capability or '*' grants;
    // PI allowed_tools is an exact tool-name allowlist, never a glob.
    const allowed = !!row && Array.isArray(row.capabilities)
      && (row.capabilities.includes('*') || row.capabilities.includes(capability))
      && (row.allowed_tools == null || (Array.isArray(row.allowed_tools) && row.allowed_tools.includes(toolName)));
    if (!allowed) return false;
    if (credential.kind === 'user-session') return true;
    // resolveBearer first resolves token_index identity. Recheck that identity
    // too: deleting it revokes a credential even if its capability row remains.
    // Lock session/principal first, then identity, matching endPiSession's order.
    const identities = await tx.unsafe(`SELECT token FROM harness_shared.token_index
      WHERE token=$1 AND kind=$2 AND harness_slug=$3 AND workspace_id=$4 FOR SHARE`,
    [credential.bearer, credential.kind, principalId, workspaceId]);
    return identities.length === 1;
  };
}

/** Persist the existing ask_choice answered marker and card_pick user turn in
 * the decision transaction, as turn-answer does. callId is the stable host
 * interaction identity; an unrelated or already answered tool cannot advance.
 * This callback performs no external effect and needs no in-memory waiter. */
export function operatorChatTurnWorkflow(input: { workspaceId: string; turn: TurnIdentity }):
  (tx: Tx, next: InteractionRecord) => Promise<void> {
  const workspaceId = input.workspaceId;
  const turn = { ...input.turn };
  return async (tx, next) => {
    if (next.conversationId !== turn.conversationId || next.status !== 'resolved' || !next.decision) {
      throw new Error('invalid-workflow-transition');
    }
    const rows = await tx.unsafe<{ tools: unknown }[]>(`SELECT tools FROM harness_shared.operator_turns
      WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND role='assistant' FOR UPDATE`,
    [turn.turnId, turn.conversationId, workspaceId]);
    const tools = rows[0]?.tools;
    if (!Array.isArray(tools)) throw new Error('invalid-workflow-transition');
    const matches = tools.filter(tool => object(tool) && tool.callId === next.correlationId
      && typeof tool.name === 'string' && canonicalToolName(tool.name) === 'chat:ask_choice');
    if (matches.length !== 1 || matches[0].answered) throw new Error('invalid-workflow-transition');
    const tool = matches[0] as Record<string, unknown>;
    const args = object(tool.input) ? tool.input : object(tool.args) ? tool.args : {};
    const options = coerceAskChoiceOptions(args.options);
    const response = next.decision.response;
    const ids = response.action === 'submit' ? response.value.picks : [];
    if (!Array.isArray(ids) || (response.action === 'submit'
      && (ids.length < 1 || ids.length > 6 || (args.multi !== true && ids.length !== 1)
        || new Set(ids).size !== ids.length))) throw new Error('invalid-workflow-answer');
    const picks = ids.map(id => {
      const option = options?.find(option => typeof option.id === 'string' && option.id.toLowerCase() === id);
      if (typeof id !== 'string' || !option || typeof option.label !== 'string') throw new Error('invalid-workflow-answer');
      return { option_id: id, label: option.label };
    });
    tool.answered = { picks, ...(response.action !== 'submit' ? { declined: true } : {}), at: next.decision.decidedAt };
    await tx.unsafe(`UPDATE harness_shared.operator_turns SET tools=$1::jsonb
      WHERE id=$2 AND conversation_id=$3 AND workspace_id=$4`,
    [tx.json(tools), turn.turnId, turn.conversationId, workspaceId]);
    // OperatorChatStore holds the parent conversation FOR UPDATE, serializing
    // this sequence allocation with other shared-port decisions in the thread.
    await tx.unsafe(`INSERT INTO harness_shared.operator_turns
      (conversation_id,seq,role,text,source,created_at,workspace_id)
      SELECT $1,COALESCE(MAX(seq),-1)+1,'user',$2,'card_pick',$3,$4
        FROM harness_shared.operator_turns WHERE conversation_id=$1`,
    [turn.conversationId, response.action === 'submit' ? picks.map(pick => pick.label).join(' · ')
      : response.action === 'cancel' ? 'Cancelled' : 'Skipped', Math.trunc(next.decision.decidedAt), workspaceId]);
  };
}

const sameTurn = (a: TurnIdentity, b: TurnIdentity) =>
  a.conversationId === b.conversationId && a.turnId === b.turnId;
const sameScope = (a: InteractionScope, b: InteractionScope) =>
  ['principalId', 'tenantId', 'customerId', 'publicOwnerId'].every(key =>
    a[key as keyof InteractionScope] === b[key as keyof InteractionScope]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** PG implementation of shared ports, embedded in operator_turns. Instances
 * bind to authenticated host scope and an existing turn; no local cache is an
 * authority for completed effects or decisions after worker replacement. */
export class OperatorChatStore implements TurnCheckpointStore {
  private readonly options: OperatorChatStoreOptions;
  private readonly replayLimit: number;

  constructor(options: OperatorChatStoreOptions) {
    const limit = options.replayLimit ?? 5000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('invalid-replay-limit');
    this.replayLimit = limit;
    this.options = { ...options, turn: { ...options.turn }, scope: { ...options.scope } };
  }

  private decode(value: unknown): StoredTurn {
    if (value === null) return { schemaVersion: 1, scope: { ...this.options.scope }, checkpoint: null, events: [], interactions: {} };
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.events)
      || !object(value.interactions) || !Object.hasOwn(value, 'checkpoint')) throw new Error('invalid-state');
    if (!object(value.scope) || !sameScope(value.scope as unknown as InteractionScope, this.options.scope)) {
      throw new OperatorChatAuthorizationError();
    }
    if (value.checkpoint !== null && (!object(value.checkpoint)
      || !parseChatState(value.checkpoint.state).ok
      || !sameTurn(value.checkpoint.state as unknown as TurnIdentity, this.options.turn)
      || !object(value.checkpoint.effects))) throw new Error('invalid-state');
    const events = value.events;
    if (events.length > this.replayLimit || events.some((event, i) => {
      const parsed = parseChatEnvelope(event);
      return !parsed.ok || !sameTurn(parsed.value, this.options.turn)
        || chatEventChannel(parsed.value.event.type) !== 'event'
        || (i > 0 && parsed.value.sequence !== (events[i - 1] as ChatEventEnvelope).sequence + 1);
    })) throw new Error('invalid-state');
    const stored = structuredClone(value) as unknown as StoredTurn;
    if (stored.events.length && (!stored.checkpoint
      || stored.events.at(-1)!.sequence !== stored.checkpoint.state.lastSequence)) throw new Error('invalid-state');
    return stored;
  }

  private async locked<T>(identity: TurnIdentity,
    run: (tx: Tx, state: StoredTurn) => Promise<T>): Promise<T> {
    if (!sameTurn(identity, this.options.turn)) throw new OperatorChatAuthorizationError();
    return this.options.sql.begin(async tx => {
      if (!await this.options.authorize(tx)) throw new OperatorChatAuthorizationError();
      const rows = await tx.unsafe<LockedTurn[]>(
        `SELECT t.chat_state FROM harness_shared.operator_turns t
           JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
          WHERE t.id = $1 AND c.id = $2 AND c.workspace_id = $3 AND t.workspace_id = $3
          FOR UPDATE OF t, c`,
        [identity.turnId, identity.conversationId, this.options.workspaceId]);
      if (!rows[0]) throw new OperatorChatAuthorizationError();
      return run(tx, this.decode(rows[0].chat_state));
    }) as Promise<T>;
  }

  private async save(tx: Tx, state: StoredTurn): Promise<void> {
    // Serialization failure aborts the transaction and never acknowledges success.
    const json = JSON.parse(JSON.stringify(state));
    // JSON.stringify silently turns NaN into null, drops undefined and converts
    // Dates. Those changes cannot acknowledge the original completed result.
    if (!isDeepStrictEqual(state, json)) throw new Error('invalid-json-state');
    await tx.unsafe(`UPDATE harness_shared.operator_turns SET chat_state = $1::jsonb
      WHERE id = $2 AND conversation_id = $3 AND workspace_id = $4`,
    [tx.json(json), this.options.turn.turnId, this.options.turn.conversationId, this.options.workspaceId]);
  }

  async read(identity: TurnIdentity): Promise<TurnCheckpoint | null> {
    return this.locked(identity, async (_tx, state) => state.checkpoint);
  }

  async compareAndSwap(identity: TurnIdentity, revision: number | null, next: TurnCheckpoint): Promise<boolean> {
    const candidate = structuredClone(next);
    if (!parseChatState(candidate.state).ok || !sameTurn(candidate.state, identity)
      || candidate.state.revision !== (revision === null ? 0 : revision + 1)) throw new Error('invalid-state');
    return this.locked(identity, async (tx, state) => {
      if ((state.checkpoint?.state.revision ?? null) !== revision) return false;
      if (candidate.state.lastSequence !== (state.checkpoint?.state.lastSequence ?? 0)) throw new Error('invalid-state');
      state.checkpoint = candidate;
      if (candidate.state.phase === 'cancelled') {
        for (const [id, record] of Object.entries(state.interactions)) {
          if (record.status === 'pending') state.interactions[id] = { ...record, revision: record.revision + 1, status: 'cancelled' };
        }
      }
      await this.save(tx, state);
      return true;
    });
  }

  async admitDispatch<T>(identity: TurnIdentity, effectId: string, claimRevision: number,
    launch: () => Promise<T>): Promise<DispatchAdmission<T>> {
    try { return await this.locked<DispatchAdmission<T>>(identity, async (tx, state) => {
      const checkpoint = state.checkpoint;
      const effect = checkpoint && Object.hasOwn(checkpoint.effects, effectId) ? checkpoint.effects[effectId] : undefined;
      if (checkpoint?.state.phase === 'cancelled') return { admitted: false, reason: 'cancelled' };
      if (checkpoint?.state.phase !== 'running' || effect?.status !== 'dispatching'
        || effect.claimRevision !== claimRevision || effect.admitted) return { admitted: false, reason: 'conflict' };
      effect.admitted = true;
      checkpoint.state.revision++;
      await this.save(tx, state);
      // Launch once while cancellation is fenced. Never await an external
      // effect under the PG lock. A failed commit after launch is uncertain;
      // the shared coordinator refuses to retry its existing dispatch claim.
      let result: Promise<T>;
      try { result = launch(); } catch (error) { result = Promise.reject(error); }
      void result.catch(() => {});
      return { admitted: true, result };
    }); } catch (error) {
      if (error instanceof OperatorChatAuthorizationError) return { admitted: false, reason: 'unauthorized' };
      throw error;
    }
  }

  /** Sequence CAS reconciles ack loss without inventing another event id. */
  async appendEvent(input: ChatEventEnvelope): Promise<ChatEventEnvelope> {
    const parsed = parseChatEnvelope(structuredClone(input));
    if (!parsed.ok || chatEventChannel(parsed.value.event.type) !== 'event') throw new Error('invalid-frame');
    const event = parsed.value;
    return this.locked(event, async (tx, state) => {
      const checkpoint = state.checkpoint;
      if (!checkpoint) throw new Error('invalid-state');
      if (event.sequence <= checkpoint.state.lastSequence) {
        const prior = state.events.find(item => item.sequence === event.sequence);
        if (!prior) throw new Error('replay-expired');
        if (!isDeepStrictEqual(prior, event)) throw new Error('event-conflict');
        return prior;
      }
      if (event.sequence !== checkpoint.state.lastSequence + 1
        || state.events.some(item => item.eventId === event.eventId)) throw new Error('event-conflict');
      checkpoint.state.lastSequence = event.sequence;
      checkpoint.state.revision++;
      state.events = [...state.events, event].slice(-this.replayLimit);
      await this.save(tx, state);
      return event;
    });
  }

  async replay(identity: TurnIdentity, after: number): Promise<ReplayWindow> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid-cursor');
    return this.locked(identity, async (_tx, state) => ({
      lastSequence: state.checkpoint?.state.lastSequence ?? 0,
      firstAvailableSequence: state.events[0]?.sequence ?? (state.checkpoint?.state.lastSequence ?? 0) + 1,
      events: state.events.filter(event => event.sequence > after),
    }));
  }

  async seedInteraction(record: InteractionRecord): Promise<boolean> {
    const candidate = structuredClone(record);
    if (candidate.schemaVersion !== 1 || candidate.conversationId !== this.options.turn.conversationId
      || !sameScope(candidate.scope, this.options.scope) || candidate.status !== 'pending'
      || candidate.revision !== 0) throw new Error('invalid-state');
    return this.locked(this.options.turn, async (tx, state) => {
      if (state.checkpoint && !['running', 'awaiting-input'].includes(state.checkpoint.state.phase)) return false;
      if (Object.hasOwn(state.interactions, candidate.correlationId)) return false;
      state.interactions = { ...state.interactions, [candidate.correlationId]: candidate };
      await this.save(tx, state);
      return true;
    });
  }

  /** The host MUST supply its existing persisted workflow transition. It runs
   * in the decision transaction; no external effect belongs in this callback. */
  interactions(advance: (tx: Tx, next: InteractionRecord) => Promise<void>): InteractionStore {
    return { transact: async <T>(identity: InteractionIdentity, caller: InteractionScope,
      decide: (current: { record: InteractionRecord | null; now: number; authorized: boolean }) => InteractionMutation<T>,
    ): Promise<InteractionResult<T>> => {
      if (identity.conversationId !== this.options.turn.conversationId || !sameScope(caller, this.options.scope)) {
        return { ok: false, code: 'unauthorized' };
      }
      try { return await this.locked(this.options.turn, async (tx, state) => {
        const record = Object.hasOwn(state.interactions, identity.correlationId)
          ? structuredClone(state.interactions[identity.correlationId]) : null;
        const clock = await tx.unsafe<{ now: number }[]>('SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS now');
        const mutation = decide({ record, now: clock[0].now, authorized: true });
        if (mutation.next) {
          if (mutation.next.conversationId !== identity.conversationId
            || mutation.next.correlationId !== identity.correlationId
            || !sameScope(mutation.next.scope, this.options.scope)) throw new Error('invalid-state');
          state.interactions = { ...state.interactions, [identity.correlationId]: structuredClone(mutation.next) };
          await this.save(tx, state);
          await advance(tx, mutation.next);
        }
        return mutation.result;
      }); } catch (error) {
        if (error instanceof OperatorChatAuthorizationError) return { ok: false, code: 'unauthorized' };
        throw error;
      }
    } };
  }
}
