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

/** Fired once per turn start. Heartbeats + returns the reminder text
 *  (the OMP adapter at the bottom of the file is responsible for
 *  surfacing it to the model). */
export async function onTurnStart(): Promise<string> {
  // Heartbeat: re-declare current intent (writePresence bumps heartbeat).
  // We do this fire-and-forget so the reminder fetch isn't gated on it.
  void callMcpTool('coord:declare-intent', {
    intent: '(active — see coord:presence for current work)',
  });

  const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';
  const [inboxResult, locksResult] = await Promise.all([
    callMcpTool('coord:inbox', {}),
    callMcpTool('locks:queue', { owner: ownerId }).catch(() => null),
  ]);

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

  return formatTurnStartReminder({ ownerId, inbox, heldLocks, changedPlans });
}

/**
 * Tool-call enforcement stub. Real lock enforcement (block on busy,
 * release on tool_result) is owned by `file-locking-improvements`
 * plan #2. Until that ships, this stub permits every call.
 */
export interface ToolCallEvent {
  tool: string;
  input?: Record<string, unknown>;
}
export async function onToolCall(_event: ToolCallEvent): Promise<{ block: boolean; reason?: string } | null> {
  // TODO(file-locking-improvements #2): inspect tool + path; call
  //   locks:acquire; return { block: true, reason } on busy.
  return null;
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
 * The OMP entry point. OMP loads this via --hook=<path>.
 *
 * IMPORTANT — adapter assumption (verify at deploy): this assumes the
 * OMP HookAPI exposes `pi.on(event, handler)` and that the `turn_start`
 * handler's return value (when a non-empty string) is prepended as a
 * system message to the next turn. If OMP's actual API differs,
 * adjust the three `pi.on(...)` calls below; the underlying handlers
 * (onSessionStart / onTurnStart / onToolCall) are unchanged.
 */
type Listener = (event: unknown, api?: unknown) => unknown;
interface HookApi {
  on(event: string, handler: Listener): void;
}

export default function register(pi: HookApi): void {
  pi.on('session_start', async () => {
    await safe(() => onSessionStart(), undefined);
  });

  pi.on('turn_start', async () => {
    return safe(() => onTurnStart(), '');
  });

  pi.on('tool_call', async (event) => {
    const e = event as ToolCallEvent;
    return safe(() => onToolCall(e), null);
  });
}
