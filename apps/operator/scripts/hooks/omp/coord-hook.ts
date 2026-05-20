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
 *
 * Attached vs detached (agent-coordination-architecture-v2 §10): the
 * extension probes GET /api/health at session start. Attached → the
 * MCP path below. Detached (no operator) → it reads coord/ on the
 * filesystem directly. Locks and presence are PG-backed and stay
 * unavailable when detached; the inbox + watermark are filesystem and
 * keep working.
 */

import { promises as fsp, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
  /** When 'detached', a header line warns that locks/presence are off. */
  mode?: 'attached' | 'detached';
}

/**
 * Format the turn-start reminder shown to the model. Compact,
 * skimmable — does NOT dump full bodies; those are one tool call away.
 * Returns "" when there is nothing to surface (no reminder injected) —
 * except in detached mode, where the detached header always surfaces
 * (the model must know locks/presence are unavailable every turn).
 */
export function formatTurnStartReminder(input: ReminderInput): string {
  const out: string[] = [];

  if (input.mode === 'detached') {
    out.push(
      'Coordination: DETACHED (no operator). Inbox + plans work via the ' +
        'filesystem; file locks and presence are unavailable — do not rely ' +
        'on locks:* this session.',
    );
  }

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

// ── Mode detection: attached vs detached (§10) ───────────────────────

export type CoordMode = 'attached' | 'detached';

/**
 * Current coordination mode. Defaults to 'attached' (optimistic) — the
 * first turn self-corrects if the operator turns out unreachable, so a
 * missing session_start probe is not fatal.
 */
let _mode: CoordMode = 'attached';

/** The operator's base origin from env, or null if none is configured. */
function operatorBaseUrl(): string | null {
  for (const v of [process.env.PAPERCUSP_BUNDLE_URL, process.env.PAPERCUSP_OPERATOR_URL]) {
    if (v) {
      try {
        return new URL(v).origin;
      } catch {
        /* malformed — try the next */
      }
    }
  }
  return null;
}

/**
 * Probe GET <operator>/api/health. True iff the operator answers 200
 * within `timeoutMs`. Any error (no operator configured, refused,
 * timeout, non-200) → false. See agent-coordination-architecture-v2
 * Q-5: /api/health is the dedicated liveness route.
 */
export async function probeOperator(timeoutMs = 2000): Promise<boolean> {
  const base = operatorBaseUrl();
  if (!base) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** Probe and update `_mode`. Returns the resolved mode. */
export async function refreshMode(): Promise<CoordMode> {
  _mode = (await probeOperator()) ? 'attached' : 'detached';
  return _mode;
}

// ── Filesystem coord/ reader (detached mode) ─────────────────────────

/**
 * Resolve the coord/ directory the same way the operator does:
 * PAPERCUSP_COORD_DIR if set, else the nearest ancestor of cwd with a
 * .git, else cwd/coord. Kept in lockstep with
 * apps/operator/lib/agent-tools/coordination/paths.ts:coordDir().
 */
function coordDirFs(): string {
  const env = process.env.PAPERCUSP_COORD_DIR;
  if (env && env.length > 0) return env;
  let cur = resolve(process.cwd());
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(cur, '.git'))) return join(cur, 'coord');
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(process.cwd(), 'coord');
}

/** ownerId → POSIX-safe filename stem (matches paths.ts sanitisation). */
function sanitiseOwner(ownerId: string): string {
  return ownerId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Read + parse a JSONL file. Missing file or bad lines → []. */
async function readJsonlFs(path: string): Promise<Array<Record<string, unknown>>> {
  let buf: string;
  try {
    buf = await fsp.readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ln of buf.split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') out.push(o as Record<string, unknown>);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Detached-mode inbox: scan coord/messages/*.jsonl directly, filtered
 * to entries addressed to `ownerId` (or '*'), newer than `sinceTs`,
 * excluding the agent's own outbox lines. Mirrors the operator's
 * readInbox() so the reminder is identical attached vs detached.
 */
export async function readInboxFs(
  ownerId: string,
  sinceTs?: string,
): Promise<InboxEntry[]> {
  const dir = join(coordDirFs(), 'messages');
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const sinceMs = sinceTs ? Date.parse(sinceTs) : 0;
  const out: InboxEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    for (const l of await readJsonlFs(join(dir, f))) {
      const to = l.to;
      if (!Array.isArray(to)) continue;
      if (!to.includes(ownerId) && !to.includes('*')) continue;
      if (l.from === ownerId) continue;
      const ts = typeof l.ts === 'string' ? l.ts : '';
      if (sinceMs && ts && Date.parse(ts) <= sinceMs) continue;
      out.push({
        ts,
        msg_id: typeof l.msg_id === 'string' ? l.msg_id : '',
        from: typeof l.from === 'string' ? l.from : '',
        kind: typeof l.kind === 'string' ? l.kind : '',
        summary: typeof l.summary === 'string' ? l.summary : undefined,
        plan_slug: typeof l.plan_slug === 'string' ? l.plan_slug : undefined,
        related_msg_id:
          typeof l.related_msg_id === 'string' ? l.related_msg_id : undefined,
        severity: typeof l.severity === 'string' ? l.severity : undefined,
      });
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
  return out;
}

/** Detached-mode watermark read: coord/watermarks/<ownerId>.json. */
export async function readWatermarkFs(ownerId: string): Promise<string | undefined> {
  const file = join(coordDirFs(), 'watermarks', `${sanitiseOwner(ownerId)}.json`);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      messages_since_ts?: unknown;
    };
    return typeof parsed.messages_since_ts === 'string' && parsed.messages_since_ts.length > 0
      ? parsed.messages_since_ts
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detached-mode watermark write: merge messages_since_ts into
 * coord/watermarks/<ownerId>.json. Best-effort — a write failure must
 * not break the turn.
 */
export async function writeWatermarkFs(
  ownerId: string,
  messagesSinceTs: string,
): Promise<void> {
  const dir = join(coordDirFs(), 'watermarks');
  const file = join(dir, `${sanitiseOwner(ownerId)}.json`);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  current.messages_since_ts = messagesSinceTs;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

// ── Handlers ─────────────────────────────────────────────────────────

/** Fired once per OMP session start. Probes the operator to choose
 *  attached/detached mode, then declares presence (attached only —
 *  presence is PG-backed and unavailable detached). */
export async function onSessionStart(): Promise<void> {
  await refreshMode();
  if (_mode === 'attached') {
    await callMcpTool('coord:declare-intent', { intent: 'OMP session started' });
  }
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

/** Result of a turn-start assembly. `degraded` is true when ATTACHED
 *  but the core operator call (coord:inbox) failed transiently.
 *  `mode` reports attached/detached — detached is a supported mode,
 *  not a failure. The adapter surfaces both (plan §7.4 / §10). */
export interface TurnStartResult {
  reminder: string;
  degraded: boolean;
  mode: CoordMode;
}

/** Attached turn-start: assemble the reminder over the MCP tool path. */
async function onTurnStartAttached(ownerId: string): Promise<TurnStartResult> {
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

  const surfacedMax = maxTs(inbox);
  _pendingMessagesWatermark =
    !degraded && surfacedMax.length > 0 ? surfacedMax : null;

  return {
    reminder: formatTurnStartReminder({
      ownerId,
      inbox,
      heldLocks,
      changedPlans,
      mode: 'attached',
    }),
    degraded,
    mode: 'attached',
  };
}

/** Detached turn-start: assemble the reminder from coord/ on the
 *  filesystem. No operator — locks + presence are omitted; the inbox,
 *  changed-plans and watermark are all filesystem-backed (plan §10). */
async function onTurnStartDetached(ownerId: string): Promise<TurnStartResult> {
  const sinceTs = await readWatermarkFs(ownerId);
  const inbox = await readInboxFs(ownerId, sinceTs);
  const changedPlans = summarisePlanEvents(
    inbox.filter((e) => e.kind === 'plan_event'),
  );

  const surfacedMax = maxTs(inbox);
  _pendingMessagesWatermark = surfacedMax.length > 0 ? surfacedMax : null;

  return {
    reminder: formatTurnStartReminder({
      ownerId,
      inbox,
      heldLocks: [], // PG-backed — unavailable detached
      changedPlans,
      mode: 'detached',
    }),
    degraded: false, // detached is a supported mode, not a failure
    mode: 'detached',
  };
}

/** Fired once per turn start. Dispatches by mode; on an attached call
 *  that comes back degraded, re-probes — a mid-session operator outage
 *  flips to detached and the SAME turn still gets a filesystem
 *  reminder rather than nothing. */
export async function onTurnStart(): Promise<TurnStartResult> {
  const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';
  if (_mode === 'detached') {
    return onTurnStartDetached(ownerId);
  }
  const attached = await onTurnStartAttached(ownerId);
  if (!attached.degraded) return attached;
  // Attached call failed — was it a transient blip or did the operator
  // go away? Re-probe; if it is truly gone, fall through to detached so
  // this turn is still useful.
  await refreshMode();
  if (_mode === 'detached') {
    return onTurnStartDetached(ownerId);
  }
  return attached; // operator is up — a genuine transient failure
}

/** Fired once per turn end. Persists the watermark staged by
 *  onTurnStart — via coord:watermark-set when attached, or directly to
 *  coord/watermarks/ when detached. No-op when nothing was surfaced. */
export async function onTurnEnd(): Promise<void> {
  if (_pendingMessagesWatermark == null) return;
  const ts = _pendingMessagesWatermark;
  _pendingMessagesWatermark = null;
  if (_mode === 'detached') {
    const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';
    await writeWatermarkFs(ownerId, ts);
  } else {
    await callMcpTool('coord:watermark-set', { messages_since_ts: ts });
  }
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
      mode: 'attached' as CoordMode,
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
