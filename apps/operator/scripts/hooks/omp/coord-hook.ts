/**
 * Papercusp coordination hook for OMP — one module, six handlers
 * (per agent-coordination-architecture-v2 §7.3 + §12.1 +
 * file-locking-improvements #2):
 *
 *   session_start    → mint the per-process coordination owner id;
 *                      probe the operator (attached/detached) +
 *                      declare presence (coord:declare-intent over
 *                      MCP, attached only — presence is PG-backed).
 *   turn_start       → assemble + inject the system-reminder payload
 *                      (held locks, unread inbox, changed plans).
 *   turn_end         → persist the watermark pointers consumed.
 *   tool_call        → L2 file-lock enforcement — extract paths,
 *                      coord:locks:acquire, block on busy.
 *   tool_result      → release the lock acquired for that toolCallId.
 *   session_shutdown → defensive release of any locks still held.
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

import { promises as fsp, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
  /** Present on plan_event entries — created / promoted / etc. */
  event?: string;
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
 * Returns "" when there is nothing to surface (no reminder injected).
 * In detached mode, the detached warning is included only when another
 * coord surface is already being reported; injecting the header alone
 * creates a hidden no-op turn in OMP and can auto-continue forever.
 */
export function formatTurnStartReminder(input: ReminderInput): string {
  const out: string[] = [];

  const detachedNotice =
    'Coordination: DETACHED (no operator). Inbox + plans work via the ' +
    'filesystem; file locks and presence are unavailable — do not rely ' +
    'on locks:* this session.';


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

  if (input.mode === 'detached') {
    out.unshift(detachedNotice);
  }

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
/**
 * Per-PROCESS coordination owner id (file-locking #2). Minted once,
 * cached for the process lifetime.
 *
 * This is the structural fix for OMP per-session identity: the hook
 * OWNS its identity rather than inheriting it from whatever the MCP
 * transport's `Mcp-Session-Id` / bundle token happens to carry. Two
 * OMP shells on one machine ALWAYS get distinct owners because
 * `process.pid` differs — the lock store can never collapse them.
 *
 * Format `omp-<session>-<pid>`: the session part is
 * PAPERCUSP_AUTH_SESSION_ID when the bundle env supplies it (already
 * unique per desktop launch), else a random hex (covers the
 * standalone-install path where no bundle session id exists). The
 * `<pid>` makes it unconditional regardless. callMcpTool passes this
 * via `?client=` — the operator's power-user route branch honors it
 * (see _mcp-handler.ts).
 */
let _hookOwnerId: string | null = null;
export function hookOwnerId(): string {
  if (_hookOwnerId === null) {
    const session =
      process.env.PAPERCUSP_AUTH_SESSION_ID &&
      process.env.PAPERCUSP_AUTH_SESSION_ID.length > 0
        ? process.env.PAPERCUSP_AUTH_SESSION_ID
        : Math.random().toString(36).slice(2, 10);
    _hookOwnerId = `omp-${session}-${process.pid}`;
  }
  return _hookOwnerId;
}

/** Test-only: reset the memoised owner id between cases. */
export function _resetHookOwnerIdForTests(): void {
  _hookOwnerId = null;
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  env: { mcpUrl?: string; bearer?: string; sessionId?: string } = {},
): Promise<unknown | null> {
  // Append the per-process coordination owner as `?client=` so the
  // operator attributes every coord/locks call to THIS process, not
  // to a shared bundle-token identity (file-locking #2).
  const clientParam = `client=${encodeURIComponent(hookOwnerId())}`;
  const withClient = (base: string): string =>
    base.includes('?') ? `${base}&${clientParam}` : `${base}?${clientParam}`;
  const mcpUrl =
    env.mcpUrl ??
    (process.env.PAPERCUSP_BUNDLE_URL
      ? withClient(
          new URL('/api/mcp?power_user=1', process.env.PAPERCUSP_BUNDLE_URL).toString(),
        )
      : process.env.PAPERCUSP_OPERATOR_URL
      ? withClient(
          new URL('/api/mcp?power_user=1', process.env.PAPERCUSP_OPERATOR_URL).toString(),
        )
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

/** Epoch ms of the last probe — drives the detached-mode re-probe
 *  throttle so a recovered operator is picked up without paying a
 *  probe (a 2s timeout when still down) on every detached turn. */
let _lastProbeAtMs = 0;

/** How stale a detached-mode probe may get before onTurnStart re-probes
 *  (audit NB-1 — detached→attached recovery). */
const DETACHED_REPROBE_MS = 120_000;

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

/** Probe and update `_mode` + the probe timestamp. Returns the mode. */
export async function refreshMode(): Promise<CoordMode> {
  _mode = (await probeOperator()) ? 'attached' : 'detached';
  _lastProbeAtMs = Date.now();
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

/** Last-read pointers the hook tracks — a subset of the operator's
 *  Watermark (messages + plan-events; escalations/subscriptions are
 *  not consumed by the turn-start reminder). */
export interface HookWatermark {
  messages?: string;
  plan_events?: string;
}

/** Detached-mode watermark read: coord/watermarks/<ownerId>.json. */
export async function readWatermarkFs(ownerId: string): Promise<HookWatermark> {
  const file = join(coordDirFs(), 'watermarks', `${sanitiseOwner(ownerId)}.json`);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      messages_since_ts?: unknown;
      plan_events_since_ts?: unknown;
    };
    const out: HookWatermark = {};
    if (typeof parsed.messages_since_ts === 'string' && parsed.messages_since_ts.length > 0) {
      out.messages = parsed.messages_since_ts;
    }
    if (typeof parsed.plan_events_since_ts === 'string' && parsed.plan_events_since_ts.length > 0) {
      out.plan_events = parsed.plan_events_since_ts;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Detached-mode watermark write: merge the supplied pointers into
 * coord/watermarks/<ownerId>.json (other fields preserved). Best-effort
 * — a write failure must not break the turn.
 */
export async function writeWatermarkFs(
  ownerId: string,
  patch: HookWatermark,
): Promise<void> {
  const dir = join(coordDirFs(), 'watermarks');
  const file = join(dir, `${sanitiseOwner(ownerId)}.json`);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  if (patch.messages !== undefined) current.messages_since_ts = patch.messages;
  if (patch.plan_events !== undefined) current.plan_events_since_ts = patch.plan_events;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Detached-mode plan-events read: scan coord/plan-events-*.jsonl (and
 * the legacy un-suffixed file) directly, newer than `sinceTs`. Mirrors
 * the operator's readPlanEvents() so the "plans changed" reminder
 * section is identical attached vs detached.
 */
export async function readPlanEventsFs(sinceTs?: string): Promise<InboxEntry[]> {
  const dir = coordDirFs();
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const planEventFiles = files
    .filter((f) => f === 'plan-events.jsonl' || /^plan-events-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort(); // legacy 'plan-events.jsonl' sorts before 'plan-events-YYYY-MM'
  const sinceMs = sinceTs ? Date.parse(sinceTs) : 0;
  const out: InboxEntry[] = [];
  for (const f of planEventFiles) {
    for (const l of await readJsonlFs(join(dir, f))) {
      if (l.kind !== 'plan_event') continue;
      const ts = typeof l.ts === 'string' ? l.ts : '';
      if (sinceMs && ts && Date.parse(ts) <= sinceMs) continue;
      out.push({
        ts,
        msg_id: typeof l.msg_id === 'string' ? l.msg_id : '',
        from: typeof l.from === 'string' ? l.from : '',
        kind: 'plan_event',
        plan_slug: typeof l.plan_slug === 'string' ? l.plan_slug : undefined,
        event: typeof l.event === 'string' ? l.event : undefined,
      });
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
  return out;
}

// ── Handlers ─────────────────────────────────────────────────────────

interface HookSessionLinkContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getCwd?: () => string;
  };
}

function currentSessionLinkFromContext(ctx: unknown): {
  advSessionId: number;
  sessionId: string;
  filePath?: string;
  cwd?: string;
} | null {
  const rawAdvSessionId = process.env.PAPERCUSP_ADV_SESSION_ID;
  if (!rawAdvSessionId) return null;
  const advSessionId = Number(rawAdvSessionId);
  if (!Number.isFinite(advSessionId) || advSessionId <= 0) return null;

  const c = ctx as HookSessionLinkContext | undefined;
  const sessionId = c?.sessionManager?.getSessionId?.()?.trim();
  if (!sessionId) return null;

  const filePath = c?.sessionManager?.getSessionFile?.();
  const cwd = c?.cwd ?? c?.sessionManager?.getCwd?.();
  return {
    advSessionId,
    sessionId,
    ...(filePath ? { filePath } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export async function linkAdvSessionFromContext(ctx: unknown): Promise<void> {
  const link = currentSessionLinkFromContext(ctx);
  if (!link) return;
  await callMcpTool('omp:sessions', { op: 'link', ...link });
}

/** Fired once per OMP session start. Probes the operator to choose
 *  attached/detached mode, then links the ADV sessions row to the OMP
 *  session id when the launcher passed PAPERCUSP_ADV_SESSION_ID. It then
 *  declares presence (attached only — presence is PG-backed and unavailable
 *  detached). */
export async function onSessionStart(ctx?: unknown): Promise<void> {
  // Mint the per-process coordination owner id up front (file-locking
  // #2). Every subsequent callMcpTool carries it via `?client=`, so a
  // lock or coordination message authored by this process is always
  // attributed to THIS process — never collapsed with a sibling OMP
  // shell that happens to share a bundle token.
  hookOwnerId();
  await refreshMode();
  if (_mode === 'attached') {
    await linkAdvSessionFromContext(ctx);
    await callMcpTool('coord:declare-intent', { intent: 'OMP session started' });
  }
}

/**
 * Fired on process exit (SIGINT/SIGTERM). Defensive lock cleanup
 * (file-locking #2 step 4): release every lock this owner still
 * holds. In the normal path onToolResult already released each lock
 * as its tool finished, so this is a backstop for a session that
 * ends mid-edit (turn aborted between tool_call and tool_result).
 *
 * Uses `all_mine: true` — one call that releases everything the
 * `?client=` owner holds, rather than iterating the local cache
 * (which could be stale if a tool_result was missed). Best-effort:
 * a failure here is covered by the lock TTL.
 */
export async function onSessionShutdown(): Promise<void> {
  acquiredLocks.clear();
  await callMcpTool('coord:locks:release', { all_mine: true });
}

/**
 * Watermark carried between turn_start and turn_end. onTurnStart records
 * the newest ts it surfaced on each surface (messages + plan-events);
 * onTurnEnd persists them. Conservative by design (plan §7.2): an
 * aborted turn never reaches turn_end, so the next turn re-sees the
 * same notifications — a missed notification is worse than a repeated
 * one.
 */
let _pendingWatermark: HookWatermark = {};

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
  // Read the watermark first — its two pointers scope the inbox and the
  // plan-events feed respectively.
  const wmResult = await callMcpTool('coord:watermark', {});
  const wm = (() => {
    const r = wmResult as {
      watermark?: { messages_since_ts?: string; plan_events_since_ts?: string };
    } | null;
    const m = r?.watermark?.messages_since_ts;
    const p = r?.watermark?.plan_events_since_ts;
    return {
      messages: typeof m === 'string' && m.length > 0 ? m : undefined,
      planEvents: typeof p === 'string' && p.length > 0 ? p : undefined,
    };
  })();

  // The heartbeat (declare-intent) runs concurrently with the inbox
  // fetch — it does not gate the reminder — but is AWAITED as part of
  // the batch. A bare `void callMcpTool(...)` could accumulate unbounded
  // pending promises against a hung operator (audit B4); batching it
  // bounds the in-flight count to one per turn. coord:plan-events is in
  // the same batch — plan_event lines live in coord/plan-events-*.jsonl,
  // NOT coord/messages/, so coord:inbox never surfaces them (audit NB-2).
  const [inboxResult, locksResult, , planEventsResult] = await Promise.all([
    callMcpTool('coord:inbox', wm.messages ? { since_ts: wm.messages } : {}),
    callMcpTool('locks:queue', { owner: ownerId }).catch(() => null),
    callMcpTool('coord:declare-intent', {
      intent: '(active — see coord:presence for current work)',
    }),
    callMcpTool(
      'coord:plan-events',
      wm.planEvents ? { since_ts: wm.planEvents } : {},
    ).catch(() => null),
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
  const planEvents: InboxEntry[] = (() => {
    const r = planEventsResult as { events?: InboxEntry[] } | null;
    return r?.events ?? [];
  })();
  const changedPlans = summarisePlanEvents(planEvents);

  const inboxMax = maxTs(inbox);
  const planEventsMax = maxTs(planEvents);
  _pendingWatermark = degraded
    ? {}
    : {
        ...(inboxMax.length > 0 ? { messages: inboxMax } : {}),
        ...(planEventsMax.length > 0 ? { plan_events: planEventsMax } : {}),
      };

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
 *  plan-events, changed-plans and watermark are all filesystem-backed
 *  (plan §10). */
async function onTurnStartDetached(ownerId: string): Promise<TurnStartResult> {
  const wm = await readWatermarkFs(ownerId);
  const inbox = await readInboxFs(ownerId, wm.messages);
  const planEvents = await readPlanEventsFs(wm.plan_events);
  const changedPlans = summarisePlanEvents(planEvents);

  const inboxMax = maxTs(inbox);
  const planEventsMax = maxTs(planEvents);
  _pendingWatermark = {
    ...(inboxMax.length > 0 ? { messages: inboxMax } : {}),
    ...(planEventsMax.length > 0 ? { plan_events: planEventsMax } : {}),
  };

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

/** Fired once per turn start. Dispatches by mode. Recovery is
 *  bidirectional (audit NB-1): an attached call that comes back
 *  degraded re-probes (operator may have gone away); a detached turn
 *  re-probes on a throttle (operator may have come back). */
export async function onTurnStart(): Promise<TurnStartResult> {
  const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';

  if (_mode === 'detached') {
    // Throttled re-probe — a recovered operator is picked up without
    // paying a probe (a 2s timeout while still down) every turn.
    if (Date.now() - _lastProbeAtMs > DETACHED_REPROBE_MS) {
      await refreshMode();
    }
    if (_mode === 'detached') {
      return onTurnStartDetached(ownerId);
    }
    // Operator came back — fall through to the attached path.
  }

  const attached = await onTurnStartAttached(ownerId);
  if (!attached.degraded) return attached;
  // Attached call failed — was it a transient blip or did the operator
  // go away? Re-probe; if it is truly gone, fall through to detached so
  // this turn is still useful.
  // Use refreshMode()'s return value, not the module-level `_mode`:
  // TS's control-flow analysis over-narrows `_mode` to 'attached' here
  // (it was narrowed by the block above and TS doesn't track that
  // refreshMode() reassigns it), which makes `_mode === 'detached'`
  // look like dead code. The returned value is correctly typed.
  const reprobed = await refreshMode();
  if (reprobed === 'detached') {
    return onTurnStartDetached(ownerId);
  }
  return attached; // operator is up — a genuine transient failure
}

/** Fired once per turn end. Persists the watermark pointers staged by
 *  onTurnStart — via coord:watermark-set when attached, or directly to
 *  coord/watermarks/ when detached. No-op when nothing was surfaced. */
export async function onTurnEnd(): Promise<void> {
  const wm = _pendingWatermark;
  _pendingWatermark = {};
  if (wm.messages === undefined && wm.plan_events === undefined) return;
  if (_mode === 'detached') {
    const ownerId = process.env.PAPERCUSP_AUTH_SESSION_ID ?? 'unknown';
    await writeWatermarkFs(ownerId, wm);
  } else {
    await callMcpTool('coord:watermark-set', {
      ...(wm.messages !== undefined ? { messages_since_ts: wm.messages } : {}),
      ...(wm.plan_events !== undefined ? { plan_events_since_ts: wm.plan_events } : {}),
    });
  }
}

/**
 * Tool-call enforcement (file-locking-improvements #2). Matches OMP's
 * `ToolCallEvent` from @oh-my-pi/pi-coding-agent/src/extensibility/
 * hooks/types.ts: discriminated `type: "tool_call"` envelope with
 * toolName / toolCallId / input. Return shape matches
 * `ToolCallEventResult` ({ block?, reason? }).
 *
 * Strategy (mirrors the now-deleted Claude Code PreToolUse/PostToolUse
 * shell hooks, with the same fail-open precedent):
 *   1. Extract repo-relative paths from the tool input (skip if the
 *      tool isn't a file-edit, or the path is outside the repo).
 *   2. Call coord:locks:acquire with wait={max_sec:0} (no queueing on
 *      the hook — block immediately so the agent can replan).
 *   3. On ok → cache lock_id by toolCallId for onToolResult to release.
 *   4. On busy → return { block: true, reason: <formatted refusal> }.
 *   5. On operator-unreachable → log + return {} (fail open;
 *      cooperative discipline only works when the system is up).
 */
export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  toolName?: string;
}

/**
 * In-process toolCallId → lock_id cache. Same OMP process handles
 * both tool_call and tool_result, so an in-memory Map is sufficient
 * — no FS cache (the CC hooks needed one because each Pre/Post fired
 * as a separate subprocess). Cleared on tool_result.
 */
const acquiredLocks = new Map<string, string>();

// ── Fail-open health marker (file-locking #3) ────────────────────────

/**
 * Directory the hook writes its two health markers into. Operator
 * reads them via GET /api/su-locks/hook-health so the /coord UI can
 * surface "enforcement is offline" when the last error is newer than
 * the last success. Located OUTSIDE the repo so multiple checkouts
 * share one marker set per host user.
 *
 * Two files, per the plan contract:
 *   - last-error.json   — written ONLY on a hook error (fail-open)
 *   - last-success.json — written on every successful hook call
 */
function locksCacheDir(): string {
  const override = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  if (override) return override;
  const home = process.env.HOME ?? '/tmp';
  return resolve(home, '.papercusp/locks-cache');
}

/** Error record — shape per file-locking plan §3 step 1. */
export interface HookErrorRecord {
  /** ISO timestamp of the failure. */
  ts: string;
  /** Which hook handler hit the error. */
  handler: 'tool_call' | 'tool_result';
  /** Coarse phase of the failure. */
  phase: 'connect' | 'http' | 'parse';
  /** One-line human-readable context. */
  detail: string;
  /** Operator URL the hook was trying to reach. */
  operator_url: string;
}

/** Success record — the "track this similarly" half of plan §3 step 2. */
export interface HookSuccessRecord {
  ts: string;
}

/**
 * Atomic-ish JSON write — temp file + rename. The hook never throws
 * on marker write failure (a filesystem error must not crash the
 * agent's tool call); errors are silently swallowed.
 */
async function writeMarker(path: string, value: unknown): Promise<void> {
  try {
    await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = path + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(tmp, path);
  } catch {
    // Best-effort. A failed marker write must never break the hook.
  }
}

/** Record a successful hook call (operator reachable + answered). */
export async function recordHookSuccess(): Promise<void> {
  const rec: HookSuccessRecord = { ts: new Date().toISOString() };
  await writeMarker(resolve(locksCacheDir(), 'last-success.json'), rec);
}

/** Record a hook error (fail-open path). */
export async function recordHookError(
  input: { handler: HookErrorRecord['handler']; phase: HookErrorRecord['phase']; detail: string },
): Promise<void> {
  const rec: HookErrorRecord = {
    ts: new Date().toISOString(),
    handler: input.handler,
    phase: input.phase,
    detail: input.detail,
    operator_url:
      process.env.PAPERCUSP_BUNDLE_URL ??
      process.env.PAPERCUSP_OPERATOR_URL ??
      '(unset)',
  };
  await writeMarker(resolve(locksCacheDir(), 'last-error.json'), rec);
}

/** Repo root the hook restricts itself to. Override with
 *  PAPERCUSP_REPO_ROOT for non-standard layouts. */
function papercupRoot(): string {
  return (
    process.env.PAPERCUSP_REPO_ROOT ??
    resolve(process.env.HOME ?? '/tmp', 'papercupai-workspace/papercup')
  );
}

/**
 * Pull file paths to claim out of a tool's input. Repo-relative;
 * anything outside the repo, or any wildcard/glob, is silently
 * dropped (the lock store is workspace-scoped; non-repo paths are not
 * coordinated, globs would over-claim).
 *
 * Tool-name coverage matches OMP's file-edit surface:
 *   - write       → input.path
 *   - edit        → input.path | file_path | filePath  (extension)
 *   - ast_edit    → input.paths[]  (skip entries containing * ? [ )
 *   - multi_edit  → input.paths[]  (legacy / future)
 *
 * Path normalization mirrors the server's rules in
 * `apps/operator/lib/agent-tools/locks/path-normalize.ts` — that file
 * is the source of truth. The hook MUST duplicate them rather than
 * import the module because it ships as a single self-contained file
 * copied into `~/.omp/agent/extensions/`. `node:path.resolve()`
 * already collapses `.`, `..`, `//` and trailing `/` and the
 * repo-prefix slice drops absolute / outside-repo paths; the explicit
 * backslash skip below covers the one rule resolve() does NOT enforce
 * on POSIX (a `\` is a literal filename char there, but the server
 * rejects it). `coord-hook.test.ts` asserts this stays consistent
 * with `normalizePaths()`.
 */
export function extractPathsFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const raw: string[] = [];
  if (toolName === 'write' || toolName === 'edit') {
    for (const k of ['path', 'file_path', 'filePath'] as const) {
      const v = input[k];
      if (typeof v === 'string' && v.length > 0) raw.push(v);
    }
  } else if (toolName === 'ast_edit' || toolName === 'multi_edit') {
    const ps = input.paths;
    if (Array.isArray(ps)) {
      for (const p of ps) {
        if (typeof p === 'string' && p.length > 0 && !/[*?[\]]/.test(p)) {
          raw.push(p);
        }
      }
    }
  }
  const root = papercupRoot();
  const prefix = root.endsWith('/') ? root : root + '/';
  const out: string[] = [];
  for (const p of raw) {
    // Backslash: the server's validatePath rejects it outright. Skip
    // here so the hook never asks the operator to claim a path the
    // operator would refuse (consistency with path-normalize.ts).
    if (p.includes('\\')) continue;
    const abs = resolve(p);
    if (abs === root) continue; // never claim the repo root itself
    if (abs.startsWith(prefix)) out.push(abs.slice(prefix.length));
  }
  return out;
}

/**
 * Symlink refusal (file-locking-improvements #1). The lock store keys
 * on the path STRING — `apps/foo.ts` and a symlink `apps/link.ts`
 * pointing at it are two different keys, so two agents editing "the
 * same file" through different names would BOTH acquire. The operator
 * can't catch this (it doesn't share the agent's filesystem); the hook
 * runs ON that filesystem, so it can.
 *
 * The hook REFUSES rather than silently rewriting the claim to the
 * canonical path: rewriting would hide the aliasing from the agent,
 * and the plan (#1) deliberately scoped resolution out — the caller
 * owns resolving symlinks before it claims.
 *
 * Detection: canonicalize both the repo root and each candidate with
 * realpathSync, then compare repo-relative forms. Equal ⇒ no symlink.
 * Differ ⇒ a symlink sits somewhere in the path (or it escapes the
 * repo entirely). A not-yet-existent leaf (a `write` creating a new
 * file) is not itself a symlink — realpath its PARENT dir instead, so
 * a symlinked directory component is still caught. Anything realpath
 * can't resolve at all (broken link, EACCES, missing parent, or a root
 * that isn't a real dir — e.g. unit tests with PAPERCUSP_REPO_ROOT set
 * to a fake path) is left to the server: fail-open, consistent with
 * every other hook failure path.
 */
export function detectSymlinkedPaths(
  relPaths: string[],
  root: string,
): Array<{ given: string; real: string }> {
  let canonRoot: string;
  try {
    canonRoot = realpathSync(root);
  } catch {
    return []; // root not a real directory — fail open
  }
  const hits: Array<{ given: string; real: string }> = [];
  for (const rel of relPaths) {
    const abs = join(root, rel);
    let canon: string | null = null;
    try {
      canon = realpathSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Leaf missing (new file via `write`). A symlink can still
        // hide in a directory component — resolve the parent.
        try {
          canon = join(realpathSync(dirname(abs)), basename(abs));
        } catch {
          canon = null; // parent unresolvable — leave it to the server
        }
      }
      // EACCES / ELOOP / etc. — canon stays null, fail open.
    }
    if (canon === null) continue;
    const canonRel =
      canon === canonRoot
        ? ''
        : canon.startsWith(canonRoot + '/')
          ? canon.slice(canonRoot.length + 1)
          : null;
    // canonRel === null ⇒ the real path escaped the repo (a symlink
    // pointing outside): also a refusal — the claim string would look
    // in-repo while the edit lands elsewhere.
    if (canonRel !== rel) {
      hits.push({ given: rel, real: canonRel ?? canon });
    }
  }
  return hits;
}

/** Format the refusal when a tool targets a symlinked path (#1). */
export function formatSymlinkRefusal(
  hits: Array<{ given: string; real: string }>,
): string {
  const lines = [
    'locks: refused — symlinked path(s). Edit the real file directly:',
  ];
  for (const h of hits.slice(0, 5)) {
    lines.push(`  - ${h.given} → ${h.real || '(repo root)'}`);
  }
  if (hits.length > 5) lines.push(`  ... and ${hits.length - 5} more`);
  lines.push('');
  lines.push(
    'The lock store keys on the path string, so a symlink and its target',
  );
  lines.push(
    'are two separate claims — editing through the symlink would let',
  );
  lines.push('another agent hold the same underlying file at the same time.');
  return lines.join('\n');
}

/** Busy-array entry as returned by coord:locks:acquire. */
interface BusyEntry {
  path: string;
  owner?: string;
  owner_label?: string | null;
  intent?: string;
  expires_ts?: string;
}

/** Format the human/agent-readable refusal when paths are contested. */
export function formatBusyRefusal(busy: BusyEntry[]): string {
  const lines: string[] = [
    'locks: refused — file(s) held by another SU agent:',
  ];
  for (const b of busy.slice(0, 5)) {
    const who = b.owner_label || b.owner || 'unknown';
    const intent = b.intent ? JSON.stringify(b.intent) : "'unknown'";
    lines.push(
      `  - ${b.path}: held by ${who} for ${intent} (expires ${b.expires_ts ?? '?'})`,
    );
  }
  if (busy.length > 5) lines.push(`  ... and ${busy.length - 5} more`);
  lines.push('');
  lines.push('Options: (1) wait and retry, (2) work on something else,');
  lines.push('(3) call locks:acquire with wait={max_sec:300} to queue.');
  return lines.join('\n');
}

export async function onToolCall(
  event: ToolCallEvent,
): Promise<{ block?: boolean; reason?: string }> {
  const blockedTaskTools = new Set(['task', 'taskcreate', 'taskupdate', 'taskget', 'tasklist']);
  if (blockedTaskTools.has(event.toolName.toLowerCase())) {
    return {
      block: true,
      reason:
        'Do not use Claude task-panel or subagent Task tools in OMP. Use todo_write for task tracking instead.',
    };
  }
  const paths = extractPathsFromToolInput(event.toolName, event.input);
  if (paths.length === 0) return {};

  // Symlink refusal (file-locking #1) — runs BEFORE the acquire. The
  // operator keys locks on the path string and cannot see that two
  // strings alias one file; the hook, running on the agent's
  // filesystem, can. A local decision: no operator round-trip, so no
  // health marker (like the paths.length === 0 short-circuit above).
  const symlinked = detectSymlinkedPaths(paths, papercupRoot());
  if (symlinked.length > 0) {
    return { block: true, reason: formatSymlinkRefusal(symlinked) };
  }

  const result = await callMcpTool('coord:locks:acquire', {
    paths,
    intent: `tool_call:${event.toolName}`,
    ttl_sec: 1200,
    wait: { max_sec: 0 },
  });

  if (result == null) {
    // Operator unreachable or call errored — fail open. Cooperative
    // discipline only works when the system is up; blocking edits
    // would wedge the agent. The persisted marker (file-locking #3)
    // lets the operator UI surface "enforcement offline."
    console.error(
      '[su-locks] coord:locks:acquire unreachable; allowing tool_call (fail-open)',
    );
    await recordHookError({
      handler: 'tool_call',
      phase: 'connect',
      detail: 'coord:locks:acquire returned null (operator unreachable)',
    });
    return {};
  }

  const r = result as {
    ok?: boolean;
    lock_id?: string;
    busy?: BusyEntry[];
    reason?: string;
  };
  // Reaching here means the operator answered — a successful hook
  // call, whether the answer was ok or busy.
  if (r.ok === true && typeof r.lock_id === 'string') {
    acquiredLocks.set(event.toolCallId, r.lock_id);
    await recordHookSuccess();
    return {};
  }
  await recordHookSuccess();
  const reason =
    r.busy && r.busy.length > 0
      ? formatBusyRefusal(r.busy)
      : r.reason ?? 'locks: refused (unknown reason)';
  return { block: true, reason };
}

export async function onToolResult(event: ToolResultEvent): Promise<void> {
  const lockId = acquiredLocks.get(event.toolCallId);
  if (lockId === undefined) return;
  acquiredLocks.delete(event.toolCallId);
  // Best-effort release. Missed releases are covered by the lock's
  // TTL (1200s) so a network blip does NOT leak a lock permanently.
  await callMcpTool('coord:locks:release', { lock_id: lockId });
}

/** Test-only: reset the in-memory lock cache between cases. */
export function _resetToolCallCacheForTests(): void {
  acquiredLocks.clear();
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
type SessionShutdownHandler = (event: { type: 'session_shutdown' }, ctx: unknown) => unknown;
type TurnStartHandler = (event: { type: 'turn_start'; turnIndex: number; timestamp: number }, ctx: unknown) => unknown;
type TurnEndHandler = (event: { type: 'turn_end' }, ctx: unknown) => unknown;
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: unknown,
) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;
type ToolResultHandler = (
  event: ToolResultEvent,
  ctx: unknown,
) => Promise<void> | void;

interface HookApi {
  on(event: 'session_start', handler: SessionStartHandler): void;
  on(event: 'session_shutdown', handler: SessionShutdownHandler): void;
  on(event: 'turn_start', handler: TurnStartHandler): void;
  on(event: 'turn_end', handler: TurnEndHandler): void;
  on(event: 'tool_call', handler: ToolCallHandler): void;
  on(event: 'tool_result', handler: ToolResultHandler): void;
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
  pi.on('session_start', async (_event, ctx) => {
    await safe(() => onSessionStart(ctx), undefined);
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
      // Silent-failure surfacing (plan §7.4). `degraded` is the
      // TRANSIENT case — the operator probe succeeded (it is reachable)
      // but a specific coordination call errored this turn. A truly
      // unreachable operator is the separate DETACHED path, whose
      // header the reminder already carries. Two markers:
      //  1. To the model — a reliable sendMessage note.
      //  2. To the human — a best-effort OMP TUI notification. The ctx
      //     shape is accessed defensively; if the API differs the
      //     marker simply no-ops (consistent with the hook's
      //     never-crash-the-session philosophy).
      pi.sendMessage({
        customType: 'coord-reminder',
        content:
          '<system-reminder type="coord">A coordination call failed this turn (operator reachable, but the call errored). Held locks, inbox, and changed-plans may be stale — re-check before relying on them.</system-reminder>',
        display: false,
        attribution: 'agent',
      });
      const c = ctx as
        | { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void } }
        | undefined;
      if (c?.hasUI && typeof c.ui?.notify === 'function') {
        c.ui.notify(
          'Papercusp coordination call failed this turn (will retry next turn)',
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

  pi.on('tool_result', async (event) => {
    await safe(() => onToolResult(event), undefined);
  });

  pi.on('session_shutdown', async () => {
    await safe(() => onSessionShutdown(), undefined);
  });
}
