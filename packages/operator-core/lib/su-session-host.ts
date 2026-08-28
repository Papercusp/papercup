/**
 * Shared host for one durable SU session.
 *
 * This deliberately extends the shipped agent-chats + SSE substrate instead
 * of introducing another session service. Backend adapters feed typed events
 * into the host; PUI attaches through the existing agent-chat route family.
 * Persistence/re-materialisation across operator replacement belongs to the
 * downstream P-004 lane.
 */
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  isSuSessionCommandType,
  type SuSessionBackend,
  type SuSessionCommand,
  type SuSessionCommandResultEvent,
  type SuSessionDescriptor,
  type SuSessionEvent,
  type SuSessionIdentity,
  type SuSessionJsonValue,
  type SuSessionLifecycleState,
  type SuSessionRefusal,
} from '@papercusp/chat-protocol';
import { pinModuleState } from '@papercusp/module-singleton';
import { dropChannel, getChannel, parseLastEventId, sseResponse, type BusChannel } from '@papercusp/sse';

type EventEnvelopeKey = 'schema' | 'protocolVersion' | 'eventId' | 'sequence' | 'at' | 'session';

type StripEventEnvelope<T> = T extends unknown ? Omit<T, EventEnvelopeKey> : never;

/** Event payload accepted from runtime adapters; the host owns the envelope. */
export type SuSessionEventInput<B extends SuSessionBackend = SuSessionBackend> = StripEventEnvelope<SuSessionEvent<B>>;

export type SuSessionCommandOutcome = { status: 'completed' } | { status: 'refused'; refusal: SuSessionRefusal };

export interface SuSessionCommandContext<B extends SuSessionBackend> {
  descriptor(): SuSessionDescriptor<B>;
  emit(event: SuSessionEventInput<B>): SuSessionEvent<B>;
  transition(state: SuSessionLifecycleState, reason?: string, runtimeGeneration?: number): SuSessionEvent<B> | null;
}

export type SuSessionCommandExecutor<B extends SuSessionBackend> = (
  command: SuSessionCommand<B>,
  context: SuSessionCommandContext<B>,
) => Promise<SuSessionCommandOutcome> | SuSessionCommandOutcome;

type CommandResult<B extends SuSessionBackend> = SuSessionCommandResultEvent<B>;

export interface SuSessionCommandDispatch<B extends SuSessionBackend> {
  /** Immediate owner-turn/control acknowledgement; null for an immediate refusal. */
  accepted: CommandResult<B> | null;
  /** Resolves to the single terminal result event for this command id. */
  terminal: Promise<CommandResult<B>>;
  /** True when command-id idempotency returned an existing dispatch. */
  replayed: boolean;
}

interface StoredCommand<B extends SuSessionBackend> {
  fingerprint: string;
  accepted: CommandResult<B> | null;
  terminal: Promise<CommandResult<B>>;
}

export interface SuSessionHostOptions<B extends SuSessionBackend> {
  descriptor: SuSessionDescriptor<B>;
  executeCommand?: SuSessionCommandExecutor<B>;
  /** Retained events available to Last-Event-ID reconnects. Default 1024. */
  replaySize?: number;
  /** Per-live-client queue before the shared SSE layer closes/replays. */
  subscriberQueueSize?: number;
  now?: () => Date;
}

export interface SuSessionHostSnapshot<B extends SuSessionBackend = SuSessionBackend> {
  descriptor: SuSessionDescriptor<B>;
  floorSequence: number;
  lastSequence: number;
  terminal: boolean;
}

export class SuSessionHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SuSessionHostError';
  }
}

const TERMINAL_STATES = new Set<SuSessionLifecycleState>(['ended', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function identityMatches(expected: SuSessionIdentity, actual: SuSessionIdentity): boolean {
  return (
    expected.agentChatId === actual.agentChatId &&
    expected.advSessionId === actual.advSessionId &&
    expected.backend === actual.backend &&
    expected.nativeSessionId === actual.nativeSessionId &&
    expected.ownerId === actual.ownerId &&
    expected.workspaceId === actual.workspaceId &&
    expected.harnessSlug === actual.harnessSlug
  );
}

function validateDescriptor<B extends SuSessionBackend>(descriptor: SuSessionDescriptor<B>): void {
  const identity = descriptor.identity;
  if (descriptor.role !== 'su') {
    throw new SuSessionHostError('invalid_descriptor', 'SU-session role must be su');
  }
  if (!identity.agentChatId || !identity.ownerId || !identity.workspaceId) {
    throw new SuSessionHostError(
      'invalid_descriptor',
      'SU-session identity requires agentChatId, ownerId, and workspaceId',
    );
  }
  if (!Number.isSafeInteger(identity.advSessionId) || identity.advSessionId <= 0) {
    throw new SuSessionHostError('invalid_descriptor', 'SU-session advSessionId must be a positive safe integer');
  }
  if (
    descriptor.backendExtension.backend !== identity.backend ||
    descriptor.runtimeGeneration < 0 ||
    !Number.isSafeInteger(descriptor.runtimeGeneration)
  ) {
    throw new SuSessionHostError(
      'invalid_descriptor',
      'backend extension and runtime generation must match the durable identity',
    );
  }
}

function parseCommand<B extends SuSessionBackend>(input: unknown): SuSessionCommand<B> {
  if (!isRecord(input)) {
    throw new SuSessionHostError('invalid_command', 'command body must be an object');
  }
  if (input.schema !== SU_SESSION_SCHEMA || input.protocolVersion !== SU_SESSION_PROTOCOL_VERSION) {
    throw new SuSessionHostError(
      'unsupported_protocol',
      `expected ${SU_SESSION_SCHEMA} protocol ${SU_SESSION_PROTOCOL_VERSION}`,
      409,
    );
  }
  if (
    typeof input.type !== 'string' ||
    !isSuSessionCommandType(input.type) ||
    typeof input.commandId !== 'string' ||
    input.commandId.length === 0 ||
    typeof input.issuedAt !== 'string' ||
    !isRecord(input.target)
  ) {
    throw new SuSessionHostError(
      'invalid_command',
      'command requires a known type, commandId, issuedAt, and target identity',
    );
  }
  return input as unknown as SuSessionCommand<B>;
}

function hostChannelKey(identity: SuSessionIdentity): string {
  return `su-session:${encodeURIComponent(identity.workspaceId)}:${encodeURIComponent(
    identity.harnessSlug ?? '',
  )}:${encodeURIComponent(identity.agentChatId)}`;
}

export class SuSessionHost<B extends SuSessionBackend = SuSessionBackend> {
  readonly channelKey: string;
  private readonly channel: BusChannel<SuSessionEvent<B>>;
  private readonly now: () => Date;
  private readonly executeCommand?: SuSessionCommandExecutor<B>;
  private readonly commands = new Map<string, StoredCommand<B>>();
  private descriptorValue: SuSessionDescriptor<B>;
  private activeCommands = 0;
  private disposed = false;

  constructor(options: SuSessionHostOptions<B>) {
    validateDescriptor(options.descriptor);
    this.descriptorValue = jsonClone(options.descriptor);
    this.now = options.now ?? (() => new Date());
    this.executeCommand = options.executeCommand;
    this.channelKey = hostChannelKey(this.descriptorValue.identity);
    this.channel = getChannel<SuSessionEvent<B>>(this.channelKey, {
      ringSize: options.replaySize ?? 1024,
      subscriberQueueSize: options.subscriberQueueSize ?? 4096,
      // A durable session may remain owner-idle for hours. The host registry,
      // not the generic channel's producer-idle backstop, owns its lifetime.
      idleReapMs: 24 * 60 * 60 * 1000,
    });
    this.emit({
      type: 'session',
      descriptor: this.descriptorValue,
    } as SuSessionEventInput<B>);
  }

  descriptor(): SuSessionDescriptor<B> {
    return jsonClone(this.descriptorValue);
  }

  snapshot(): SuSessionHostSnapshot<B> {
    const recent = this.channel.recent;
    const lastSequence = recent.at(-1)?.id ?? 0;
    return {
      descriptor: this.descriptor(),
      floorSequence: recent[0]?.id ?? lastSequence,
      lastSequence,
      terminal: TERMINAL_STATES.has(this.descriptorValue.lifecycle),
    };
  }

  get subscriberCount(): number {
    return this.channel.subscriberCount;
  }

  get recent(): ReadonlyArray<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.recent;
  }

  recentSince(sequence: number): ReadonlyArray<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.recentSince(sequence);
  }

  subscribe(): AsyncIterable<{ id: number; event: SuSessionEvent<B> }> {
    return this.channel.subscribe();
  }

  emit(input: SuSessionEventInput<B>): SuSessionEvent<B> {
    if (this.disposed) {
      throw new SuSessionHostError('host_disposed', 'SU-session host is disposed', 410);
    }
    const sequence = (this.channel.recent.at(-1)?.id ?? 0) + 1;
    const event = {
      ...jsonClone(input),
      schema: SU_SESSION_SCHEMA,
      protocolVersion: SU_SESSION_PROTOCOL_VERSION,
      eventId: `${this.descriptorValue.identity.agentChatId}:${sequence}`,
      sequence,
      at: this.now().toISOString(),
      session: jsonClone(this.descriptorValue.identity),
    } as unknown as SuSessionEvent<B>;

    if (event.type === 'lifecycle') {
      const current = this.descriptorValue.lifecycle;
      if (TERMINAL_STATES.has(current) && event.state !== current) {
        throw new SuSessionHostError(
          'terminal_state_conflict',
          `session already converged to ${current}; cannot transition to ${event.state}`,
          409,
        );
      }
      this.descriptorValue = {
        ...this.descriptorValue,
        lifecycle: event.state,
        runtimeGeneration: event.runtimeGeneration,
      } as SuSessionDescriptor<B>;
    } else if (event.type === 'session') {
      validateDescriptor(event.descriptor);
      if (!identityMatches(this.descriptorValue.identity, event.descriptor.identity)) {
        throw new SuSessionHostError(
          'identity_conflict',
          'session event cannot replace the durable SU-session identity',
          409,
        );
      }
      this.descriptorValue = jsonClone(event.descriptor) as SuSessionDescriptor<B>;
    } else if (event.type === 'backend') {
      this.descriptorValue = {
        ...this.descriptorValue,
        backendExtension: jsonClone(event.extension),
      } as SuSessionDescriptor<B>;
    }

    const id = this.channel.publish(event);
    if (id !== sequence) {
      throw new SuSessionHostError('sequence_conflict', `channel assigned ${id}; host expected ${sequence}`, 500);
    }
    return event;
  }

  transition(
    state: SuSessionLifecycleState,
    reason?: string,
    runtimeGeneration = this.descriptorValue.runtimeGeneration,
  ): SuSessionEvent<B> | null {
    const current = this.descriptorValue.lifecycle;
    if (current === state) return null;
    if (TERMINAL_STATES.has(current)) return null;
    return this.emit({
      type: 'lifecycle',
      previousState: current,
      state,
      runtimeGeneration,
      ...(reason ? { reason } : {}),
    } as SuSessionEventInput<B>);
  }

  reconcileRuntimeExit(input: {
    expected: boolean;
    reason?: string;
    exitCode?: number | null;
    signal?: string | null;
  }): SuSessionEvent<B> | null {
    const state: SuSessionLifecycleState = input.expected || input.exitCode === 0 ? 'ended' : 'failed';
    const detail =
      input.reason ??
      ([input.exitCode == null ? null : `exit=${input.exitCode}`, input.signal ? `signal=${input.signal}` : null]
        .filter(Boolean)
        .join(' ') ||
        (state === 'ended' ? 'runtime ended' : 'runtime exited unexpectedly'));
    return this.transition(state, detail);
  }

  startCommand(input: unknown): SuSessionCommandDispatch<B> {
    const command = parseCommand<B>(input);
    const fingerprint = canonicalJson(command);
    const existing = this.commands.get(command.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.emit({
          type: 'error',
          scope: 'command',
          code: 'command_id_conflict',
          message: `commandId ${command.commandId} was reused with a different payload`,
          recoverable: false,
          commandId: command.commandId,
        } as SuSessionEventInput<B>);
        throw new SuSessionHostError(
          'command_id_conflict',
          `commandId ${command.commandId} already belongs to a different command`,
          409,
        );
      }
      return {
        accepted: existing.accepted,
        terminal: existing.terminal,
        replayed: true,
      };
    }

    const identity = this.descriptorValue.identity;
    if (!identityMatches(identity, command.target)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'target_mismatch',
        message: 'command target does not match the attached durable SU session',
        retryable: false,
      });
    }
    if (TERMINAL_STATES.has(this.descriptorValue.lifecycle)) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'session_terminal',
        message: `session is already ${this.descriptorValue.lifecycle}`,
        retryable: false,
      });
    }

    const support = this.descriptorValue.capabilities.commands[command.type];
    if (support.state === 'unsupported') {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'unsupported',
        message: support.reason,
        retryable: false,
      });
    }
    if (!this.executeCommand) {
      return this.rememberImmediateRefusal(command, fingerprint, {
        code: 'backend_adapter_unavailable',
        message: `no ${identity.backend} runtime adapter is attached`,
        retryable: true,
      });
    }

    const accepted = this.emit({
      type: 'command_result',
      commandId: command.commandId,
      commandType: command.type,
      status: 'accepted',
    } as SuSessionEventInput<B>) as CommandResult<B>;

    this.activeCommands += 1;
    const terminal = Promise.resolve().then(async () => {
      try {
        const outcome = await this.executeCommand!(command, {
          descriptor: () => this.descriptor(),
          emit: (event) => this.emit(event),
          transition: (state, reason, runtimeGeneration) => this.transition(state, reason, runtimeGeneration),
        });
        const result = this.emit(
          outcome.status === 'completed'
            ? ({
                type: 'command_result',
                commandId: command.commandId,
                commandType: command.type,
                status: 'completed',
              } as SuSessionEventInput<B>)
            : ({
                type: 'command_result',
                commandId: command.commandId,
                commandType: command.type,
                status: 'refused',
                refusal: outcome.refusal,
              } as SuSessionEventInput<B>),
        ) as CommandResult<B>;

        if (outcome.status === 'completed' && command.type === 'interrupt') {
          this.transition('interrupted', 'interrupt command completed');
        }
        if (outcome.status === 'completed' && command.type === 'end') {
          this.transition('ended', 'end command completed');
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          type: 'error',
          scope: 'command',
          code: 'runtime_command_failed',
          message,
          recoverable: true,
          commandId: command.commandId,
          details: { backend: identity.backend } as SuSessionJsonValue,
        } as SuSessionEventInput<B>);
        return this.emit({
          type: 'command_result',
          commandId: command.commandId,
          commandType: command.type,
          status: 'refused',
          refusal: {
            code: 'runtime_command_failed',
            message,
            retryable: true,
          },
        } as SuSessionEventInput<B>) as CommandResult<B>;
      } finally {
        this.activeCommands = Math.max(0, this.activeCommands - 1);
      }
    });

    this.commands.set(command.commandId, { fingerprint, accepted, terminal });
    return { accepted, terminal, replayed: false };
  }

  private rememberImmediateRefusal(
    command: SuSessionCommand<B>,
    fingerprint: string,
    refusal: SuSessionRefusal,
  ): SuSessionCommandDispatch<B> {
    const terminalEvent = this.emit({
      type: 'command_result',
      commandId: command.commandId,
      commandType: command.type,
      status: 'refused',
      refusal,
    } as SuSessionEventInput<B>) as CommandResult<B>;
    const terminal = Promise.resolve(terminalEvent);
    this.commands.set(command.commandId, {
      fingerprint,
      accepted: null,
      terminal,
    });
    return { accepted: null, terminal, replayed: false };
  }

  dispose(reason = 'host disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.done({ reason, activeCommands: this.activeCommands });
    dropChannel(this.channelKey);
  }
}

type RegisteredHost = SuSessionHost<SuSessionBackend>;
const hostRegistry = pinModuleState(
  '@papercusp/operator-core.su-session-host-registry',
  () => new Map<string, RegisteredHost>(),
);

function registry(): Map<string, RegisteredHost> {
  return hostRegistry;
}

export function registerSuSessionHost<B extends SuSessionBackend>(host: SuSessionHost<B>): () => void {
  const key = host.channelKey;
  const existing = registry().get(key);
  if (existing && existing !== (host as unknown as RegisteredHost)) {
    throw new SuSessionHostError(
      'host_already_registered',
      `a different SU-session host is already registered for ${key}`,
      409,
    );
  }
  registry().set(key, host as unknown as RegisteredHost);
  return () => {
    if (registry().get(key) === (host as unknown as RegisteredHost)) {
      registry().delete(key);
      host.dispose('host unregistered');
    }
  };
}

export function getRegisteredSuSessionHost(input: {
  workspaceId: string;
  harnessSlug: string | null;
  agentChatId: string;
}): RegisteredHost | null {
  const key = hostChannelKey({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    agentChatId: input.agentChatId,
    advSessionId: 1,
    backend: 'claude',
    nativeSessionId: '',
    ownerId: '',
  });
  return registry().get(key) ?? null;
}

export type SuSessionSseEvents = Record<'session_event', SuSessionEvent> & Record<string, unknown>;

/**
 * Bridge one host onto the existing SSE transport. Subscription is installed
 * before the replay snapshot is captured; queued items at/below the snapshot
 * ceiling are de-duplicated, closing the replay/live race.
 */
export function createSuSessionEventResponse(
  request: Request,
  host: RegisteredHost,
  options: {
    heartbeatMs?: number;
    backpressureTimeoutMs?: number;
  } = {},
): Response {
  const lastEventId = parseLastEventId(request) ?? 0;
  const source = host.subscribe();
  const replay = [...host.recentSince(lastEventId)];
  const replayCeiling = replay.at(-1)?.id ?? lastEventId;
  const snapshot = host.snapshot();

  return sseResponse<SuSessionSseEvents>({
    signal: request.signal,
    lastEventId,
    heartbeatMs: options.heartbeatMs,
    backpressureTimeoutMs: options.backpressureTimeoutMs,
    replay: () =>
      replay.map(({ id, event }) => ({
        name: 'session_event' as const,
        data: event,
        id,
      })),
    resumeBounds: () => ({
      floorId: snapshot.floorSequence,
      maxId: snapshot.lastSequence,
    }),
    headers: {
      'X-Papercusp-Su-Session': host.descriptor().identity.agentChatId,
    },
    setup: async (sink) => {
      const iterator = source[Symbol.asyncIterator]();
      sink.onClose(() => {
        void iterator.return?.();
      });
      if (host.snapshot().terminal) {
        sink.done({ reason: 'terminal', snapshot: host.snapshot() });
        return;
      }
      while (!sink.closed) {
        const next = await iterator.next();
        if (next.done) return;
        if (next.value.id <= replayCeiling) continue;
        sink.event('session_event', next.value.event, { id: next.value.id });
        if (next.value.event.type === 'lifecycle' && TERMINAL_STATES.has(next.value.event.state)) {
          sink.done({ reason: 'terminal', snapshot: host.snapshot() });
          return;
        }
      }
    },
  });
}

/** Test-only: dispose all registered hosts and clear their channels. */
export function _resetSuSessionHostsForTest(): void {
  for (const host of registry().values()) host.dispose('test reset');
  registry().clear();
}
