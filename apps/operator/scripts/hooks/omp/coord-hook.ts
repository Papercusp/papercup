/**
 * Papercusp coordination hook for OMP — one module, three handlers
 * (per agent-coordination-architecture-v2 §7.3 + §12.1):
 *
 *   session_start → declare presence (coord:declare-intent over MCP),
 *                   which writePresence side-effects bump heartbeat_at.
 *   turn_start    → touch heartbeat + assemble + inject the
 *                   system-reminder payload (held locks, unread inbox,
 *                   changed plans, firing watches).
 *   tool_call     → L2 file-lock enforcement — stubbed permissive here.
 *                   The file-locking-improvements plan owns the real
 *                   enforcement (calls locks:acquire and returns
 *                   { block: true, reason } on busy). When that ships,
 *                   the stub below becomes the real call site.
 *
 * Runtime: the hook is loaded BY OMP, inside the OMP child process,
 * NOT in the operator. It MUST be self-contained (no operator imports)
 * and talks back to the operator over HTTP.
 *
 * Env (set by buildConsoleEnvelope when mode='omp' per the OMP-bundle
 * plan §4.4, omp-power-user-bundle-brief §3):
 *   PAPERCUSP_AUTH_SESSION_ID     — agent canonical id (pus-<uuid>)
 *   PAPERCUSP_BUNDLE_URL          — bundle URL (operator origin = prefix)
 *   PAPERCUSP_BUNDLE_ACCESS_TOKEN — bearer for MCP calls
 *
 * Best-effort: every handler swallows its errors — a hook failure must
 * never crash the OMP session. See the omp-bundle plan §4.3.1.
 *
 * OMP HookAPI shape — VERIFY AT DEPLOY: this file assumes a standard
 * `default (pi: HookAPI) => void` registration where `pi.on(event,
 * handler)` wires a handler whose return value can carry an injection
 * (turn_start) or a block decision (tool_call). The exact OMP types
 * are in node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/.
 * The adapter at the bottom is documented and trivial to reshape.
 */

// ── Pure helpers (unit-tested) ───────────────────────────────────────

export interface InboxEntry {
  ts: string;
  msg_id: string;
  from: string;
  kind: string;
  summary?: string;
  plan_slug?: string;
  related_msg_id?: string;
  severity?: string;
}

export interface HeldLock {
  path: string;
  acquired_ts?: string;
  expires_ts?: string;
}

export interface PlanEventSummary {
  plan_slug: string;
  events: string[];
}

export interface ReminderInput {
  ownerId: string;
  inbox: InboxEntry[];
  heldLocks: HeldLock[];
  changedPlans: PlanEventSummary[];
}

/**
 * Format the turn-start reminder shown to the model. Compact,
 * skimmable — does NOT dump full bodies; those are one tool call away.
 * Returns "" when there is nothing to surface (no reminder injected).
 */
export function formatTurnStartReminder(input: ReminderInput): string {
  const out: string[] = [];

  if (input.heldLocks.length > 0) {
    out.push(`You (${input.ownerId}) currently hold ${input.heldLocks.length} lock${input.heldLocks.length === 1 ? '' : 's'}:`);
    for (const l of input.heldLocks.slice(0, 5)) {
      out.push(`  • ${l.path}`);
    }
    if (input.heldLocks.length > 5) {
      out.push(`  • … and ${input.heldLocks.length - 5} more (locks:queue { owner })`);
    }
  }

  // Escalations first within the inbox — they earn the right to interrupt.
  const escalations = input.inbox.filter((e) => e.kind === 'escalation');
  const messages = input.inbox.filter((e) => e.kind === 'message' || e.kind === 'ack');
  const notifies = input.inbox.filter((e) => e.kind === 'notify');
  const handoffs = input.inbox.filter((e) => e.kind === 'handoff' || e.kind === 'handoff_accepted');

  if (input.inbox.length > 0) {
    out.push(`Inbox — ${input.inbox.length} unread:`);
    for (const e of escalations.slice(0, 3)) {
      out.push(`  • [escalation${e.severity ? `:${e.severity}` : ''}] ${e.summary ?? '(no summary)'} (id ${e.msg_id})`);
    }
    for (const e of handoffs.slice(0, 3)) {
      out.push(`  • [${e.kind} from ${e.from}] ${e.summary ?? ''}${e.plan_slug ? ` → ${e.plan_slug}` : ''}`);
    }
    for (const e of messages.slice(0, 5)) {
      out.push(`  • [${e.kind} from ${e.from}] ${e.summary ?? ''}`);
    }
    for (const e of notifies.slice(0, 5)) {
      out.push(`  • [notify] ${e.summary ?? ''}`);
    }
  }

  if (input.changedPlans.length > 0) {
    out.push(`Plans changed since you last read (${input.changedPlans.length}):`);
    for (const p of input.changedPlans.slice(0, 5)) {
      out.push(`  • ${p.plan_slug} — ${p.events.join(', ')}`);
    }
  }

  if (out.length === 0) return '';

  return `<system-reminder type="coord">\n${out.join('\n')}\n</system-reminder>`;
}

/** Aggregate raw plan_event lines into one summary per plan_slug. */
export function summarisePlanEvents(events: InboxEntry[]): PlanEventSummary[] {
  const by = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== 'plan_event') continue;
    const slug = e.plan_slug ?? '<unknown>';
    const ev = (e as { event?: string }).event ?? 'event';
    if (!by.has(slug)) by.set(slug, []);
    by.get(slug)!.push(ev);
  }
  return [...by.entries()].map(([plan_slug, events]) => ({ plan_slug, events }));
}

// ── HTTP plumbing (operator MCP transport) ───────────────────────────

interface JsonRpcResp {
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

/**
 * Call an MCP tool on the operator. Returns the parsed JSON of the
 * tool's text content (the coord:* tools all JSON-stringify into a
 * single text element). Returns null on any failure — best-effort.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  env: { mcpUrl?: string; bearer?: string; sessionId?: string } = {},
): Promise<unknown | null> {
  const mcpUrl =
    env.mcpUrl ??
    (process.env.PAPERCUSP_BUNDLE_URL
      ? new URL('/api/mcp?power_user=1', process.env.PAPERCUSP_BUNDLE_URL).toString()
      : process.env.PAPERCUSP_OPERATOR_URL
      ? new URL('/api/mcp?power_user=1', process.env.PAPERCUSP_OPERATOR_URL).toString()
      : null);
  if (!mcpUrl) return null;
  const bearer = env.bearer ?? process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN ?? '';
  const sessionId = env.sessionId ?? process.env.PAPERCUSP_AUTH_SESSION_ID ?? '';
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // The Streamable HTTP MCP transport may return either application/json
    // or text/event-stream framed. Strip SSE `data: ` if present.
    const payload = text.startsWith('data:')
      ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? text
      : text;
    const parsed = JSON.parse(payload) as JsonRpcResp;
    if (parsed.error) return null;
    const content = parsed.result?.content?.[0]?.text;
    if (typeof content !== 'string') return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ── Handlers ─────────────────────────────────────────────────────────

/** Fired once per OMP session start. Declares initial presence. */
export async function onSessionStart(): Promise<void> {
  await callMcpTool('coord:declare-intent', {
    intent: 'OMP session started',
  });
}

/**
 * Watermark carried between turn_start and turn_end. onTurnStart records
 * the newest inbox ts it surfaced; onTurnEnd persists it via
 * coord:watermark-set. Conservative by design (plan §7.2): an aborted
 * turn never reaches turn_end, so the next turn re-sees the same
 * notifications — a missed notification is worse than a repeated one.
 */
let _pendingMessagesWatermark: string | null = null;

/** Largest ISO ts in a list of inbox entries, or '' if empty. */
function maxTs(entries: InboxEntry[]): string {
  let max = '';
  for (const e of entries) {
    if (e.ts > max) max = e.ts;
  }
  return max;
}

/** Result of a turn-start assembly. `degraded` is true when the core
 *  operator call (coord:inbox) failed — the reminder is then built from
 *  whatever partial data arrived, and the adapter surfaces a marker
 *  (plan §7.4 silent-failure surfacing). */
export interface TurnStartResult {
  reminder: string;
  degraded: boolean;
}

/** Fired once per turn start. Heartbeats + returns the reminder text
 *  plus a degraded flag (the OMP adapter surfaces both). Scopes the
 *  inbox to entries newer than the agent's stored watermark so the
 *  same notification is not re-surfaced every turn. */
export async function onTurnStart(): Promise<TurnStartResult> {
  const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';

  // Read the watermark first — its messages_since_ts scopes the inbox.
  const wmResult = await callMcpTool('coord:watermark', {});
  const sinceTs = (() => {
    const r = wmResult as { watermark?: { messages_since_ts?: string } } | null;
    const v = r?.watermark?.messages_since_ts;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  })();

  // The heartbeat (declare-intent) runs concurrently with the inbox
  // fetch — it does not gate the reminder — but is AWAITED as part of
  // the batch. A bare `void callMcpTool(...)` could accumulate unbounded
  // pending promises against a hung operator (audit B4); batching it
  // bounds the in-flight count to one per turn.
  const [inboxResult, locksResult] = await Promise.all([
    callMcpTool('coord:inbox', sinceTs ? { since_ts: sinceTs } : {}),
    callMcpTool('locks:queue', { owner: ownerId }).catch(() => null),
    callMcpTool('coord:declare-intent', {
      intent: '(active — see coord:presence for current work)',
    }),
  ]);

  // coord:inbox returning null means the operator call FAILED (an empty
  // inbox returns { entries: [] }, which is truthy). That is the
  // degraded signal — the turn-start context is incomplete.
  const degraded = inboxResult === null;

  const inbox: InboxEntry[] = (() => {
    const r = inboxResult as { entries?: InboxEntry[] } | null;
    return r?.entries ?? [];
  })();
  const heldLocks: HeldLock[] = (() => {
    const r = locksResult as { active_locks?: HeldLock[] } | null;
    return r?.active_locks ?? [];
  })();
  const changedPlans = summarisePlanEvents(
    inbox.filter((e) => e.kind === 'plan_event'),
  );

  // Stage the watermark advance for turn_end. Only advance past entries
  // we actually surfaced this turn; if the inbox was empty, keep the
  // prior watermark (don't skip past anything that lands mid-turn).
  // A degraded turn never advances — it saw nothing reliably.
  const surfacedMax = maxTs(inbox);
  _pendingMessagesWatermark =
    !degraded && surfacedMax.length > 0 ? surfacedMax : null;

  return {
    reminder: formatTurnStartReminder({ ownerId, inbox, heldLocks, changedPlans }),
    degraded,
  };
}

/** Fired once per turn end. Persists the watermark staged by
 *  onTurnStart so next turn's inbox is scoped to genuinely-new
 *  entries. No-op when nothing was surfaced this turn. */
export async function onTurnEnd(): Promise<void> {
  if (_pendingMessagesWatermark == null) return;
  const ts = _pendingMessagesWatermark;
  _pendingMessagesWatermark = null;
  await callMcpTool('coord:watermark-set', { messages_since_ts: ts });
}

/**
 * Tool-call enforcement stub. Real lock enforcement (block on busy,
 * release on tool_result) is owned by `file-locking-improvements`
 * plan #2. Until that ships, this stub permits every call.
 *
 * Matches OMP's `ToolCallEvent` from
 * @oh-my-pi/pi-coding-agent/src/extensibility/types.ts: discriminated
 * `type: "tool_call"` envelope with toolName / toolCallId / input.
 * Return shape matches `ToolCallEventResult` ({ block?, reason? }).
 */
export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}
export async function onToolCall(_event: ToolCallEvent): Promise<{ block?: boolean; reason?: string }> {
  // TODO(file-locking-improvements #2): inspect tool + path; call
  //   locks:acquire; return { block: true, reason } on busy.
  return {};
}

// ── OMP adapter (registration) ───────────────────────────────────────

/**
 * Best-effort wrapper that swallows handler errors. A hook handler
 * must never crash the OMP session.
 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Narrow shape of the OMP HookAPI we depend on. The real interface
 * lives at `@oh-my-pi/pi-coding-agent/src/extensibility/hooks/types.ts`
 * (HookAPI). We don't import it because this file ships standalone
 * to OMP — it has no dev-dependency on @oh-my-pi/pi-coding-agent.
 *
 * Verified 2026-05-20 against the installed version: turn_start
 * handlers receive `TurnStartEvent` and their return value is
 * DISCARDED — to inject context, call `pi.sendMessage()` from inside
 * the handler. tool_call handlers may return ToolCallEventResult
 * ({ block?, reason? }) to block. session_start handlers' return
 * values are also discarded.
 */
type SessionStartHandler = (event: { type: 'session_start' }, ctx: unknown) => unknown;
type TurnStartHandler = (event: { type: 'turn_start'; turnIndex: number; timestamp: number }, ctx: unknown) => unknown;
type TurnEndHandler = (event: { type: 'turn_end' }, ctx: unknown) => unknown;
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;

interface HookApi {
  on(event: 'session_start', handler: SessionStartHandler): void;
  on(event: 'turn_start', handler: TurnStartHandler): void;
  on(event: 'turn_end', handler: TurnEndHandler): void;
  on(event: 'tool_call', handler: ToolCallHandler): void;
  sendMessage(
    message: {
      customType: string;
      content: string | Array<{ type: 'text'; text: string }>;
      display?: boolean;
      attribution?: 'user' | 'agent';
    },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' },
  ): void;
}

export default function register(pi: HookApi): void {
  pi.on('session_start', async () => {
    await safe(() => onSessionStart(), undefined);
  });

  pi.on('turn_start', async (_event, ctx) => {
    const { reminder, degraded } = await safe(() => onTurnStart(), {
      reminder: '',
      degraded: true,
    });
    if (reminder.length > 0) {
      // OMP `turn_start` discards the handler's return value, so we
      // inject via sendMessage. attribution='agent' so the message is
      // not billed to the user; display=false because the reminder is
      // for the model, not the human (the /coord UI surfaces it for
      // humans).
      pi.sendMessage({
        customType: 'coord-reminder',
        content: reminder,
        display: false,
        attribution: 'agent',
      });
    }
    if (degraded) {
      // Silent-failure surfacing (plan §7.4). Two markers:
      //  1. To the model — a reliable sendMessage note so the agent
      //     knows its coordination context is stale this turn.
      //  2. To the human — a best-effort OMP TUI notification. The ctx
      //     shape is accessed defensively; if the API differs the
      //     marker simply no-ops (consistent with the hook's
      //     never-crash-the-session philosophy).
      pi.sendMessage({
        customType: 'coord-reminder',
        content:
          '<system-reminder type="coord">Coordination context unavailable this turn (operator unreachable). Held locks, inbox, and presence may be stale — re-check before relying on them.</system-reminder>',
        display: false,
        attribution: 'agent',
      });
      const c = ctx as
        | { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void } }
        | undefined;
      if (c?.hasUI && typeof c.ui?.notify === 'function') {
        c.ui.notify(
          'Papercusp coordination unavailable (operator unreachable)',
          'warning',
        );
      }
    }
  });

  pi.on('turn_end', async () => {
    await safe(() => onTurnEnd(), undefined);
  });

  pi.on('tool_call', async (event) => {
    return safe(() => onToolCall(event), {});
  });
}
