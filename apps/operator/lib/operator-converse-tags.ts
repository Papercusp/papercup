/**
 * Parser for the operator-converse turn-output tags:
 *
 *   <say>{utterance}</say>
 *   <set_mode>passive|active</set_mode>
 *   <sleep duration_minutes="N" reason="…">
 *   <spawn role="worker" feature="…" chunk="…" extras="K=V,K2=V2">
 *
 * The conversation engine parses each operator turn through this
 * module and dispatches four side-effects:
 *   1. Render the say-text (if any) into the chat transcript + TTS.
 *   2. Flip operator mode (if a set_mode tag was emitted).
 *   3. Set the sleep-until clock (if a sleep tag was emitted).
 *   4. POST to /api/plugins/orchestrator/spawn for each spawn tag.
 *
 * Pure parsing only — no DOM, no fetch, no state writes. Callers
 * thread the parsed result into the OperatorConversation reducer.
 *
 * The voice path (EL Conv AI / OpenAI Realtime) and the text path
 * (`/api/agent-mcp/operator-converse`) both produce the same shape
 * of raw turn string and both feed it through this parser, so the
 * two surfaces can stay in lockstep on tag semantics.
 *
 * Error handling: malformed tags are dropped silently with a console
 * warning. The user's chat keeps moving — a bad sleep tag shouldn't
 * crash the loop. Telemetry on parse failures is the next layer's job.
 */

export type OperatorMode = 'active' | 'passive';

export interface SpawnRequest {
  role: string;
  featureId: string | null;
  chunkId: string | null;
  extras: string[];
}

export interface ParsedOperatorTurn {
  /** The user-visible utterance, or null when the operator went silent (sleep tag only). */
  say: string | null;
  /** Mode flip the operator emitted, or null when no flip. */
  setMode: OperatorMode | null;
  /** Sleep tag the operator emitted, or null when no sleep. */
  sleep: { durationMinutes: number; reason: string } | null;
  /** Spawn requests emitted this turn. Empty array when none. */
  spawns: SpawnRequest[];
  /** Raw input, kept for debug/telemetry. Do NOT render this directly. */
  raw: string;
}

const SAY_RE = /<say>([\s\S]*?)<\/say>/i;
const SET_MODE_RE = /<set_mode>\s*(active|passive)\s*<\/set_mode>/i;
// <sleep duration_minutes="N" reason="…"> — self-closing-style; we
// match the opening tag and ignore any trailing content. `reason` is
// optional. Both attributes accept double or single quotes.
const SLEEP_RE = /<sleep\s+([^>]+?)\s*\/?>/i;
// <spawn role="…" feature="…" chunk="…" extras="K=V,K2=V2"> — self-closing.
// role required; feature/chunk/extras optional. Multiple <spawn> tags per
// turn are allowed (parallel fan-out: "review these three plans").
const SPAWN_RE = /<spawn\s+([^>]+?)\s*\/?>/gi;

/**
 * Clamp a `<say>` body to TTS-safe bounds: ≤220 chars, no markdown
 * formatting markers, no leading/trailing whitespace. Per the active-mode
 * plan ("1–2 sentences, ≤220 chars, TTS-safe, no markdown").
 *
 * Markdown stripping is deliberately conservative: only the inline
 * markers (`**`, `__`, `_`, `` ` ``, `[…](…)`) — block-level constructs
 * (headings, lists, code fences) shouldn't appear inside a single say
 * body and we don't want to mangle prose with literal asterisks.
 */
const SAY_MAX_CHARS = 220;
export function clampSay(s: string): string {
  let out = s.trim();
  // Inline markdown:
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1'); // bold
  out = out.replace(/__([^_]+)__/g, '$1');     // bold (alt)
  out = out.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1'); // italic
  out = out.replace(/`([^`]+)`/g, '$1');       // inline code
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links → just the text
  if (out.length > SAY_MAX_CHARS) {
    // Truncate at a word boundary close to the cap. Keep an ellipsis
    // hint so the LLM (reading next-turn context) sees the truncation.
    const cut = out.slice(0, SAY_MAX_CHARS).replace(/\s+\S*$/, '');
    out = (cut.length > 0 ? cut : out.slice(0, SAY_MAX_CHARS)) + '…';
  }
  return out;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match `key="value"` and `key='value'`. Loose enough that small
  // model-side formatting drift (extra spaces, attribute reordering)
  // still parses. `key=value` (no quotes) intentionally NOT supported
  // — we want a simple, predictable tag shape from the model.
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/**
 * Parse a raw turn-output string from the operator into structured
 * `say` / `setMode` / `sleep` slots. Always returns a result object;
 * any tag that fails to validate is dropped (with a console warn).
 *
 * Tag-presence rules from operator.converse.md (enforced loosely
 * here — the model is the primary enforcer, this is a safety net):
 *
 *   - `<say>` paired with `<set_mode>` is fine
 *   - `<sleep>` SHOULD NOT pair with `<say>` (silence IS the response).
 *     If both appear, the say wins and sleep is dropped.
 *   - Multiple of the same tag → first wins, rest dropped.
 */
export function parseOperatorTurn(raw: string): ParsedOperatorTurn {
  const result: ParsedOperatorTurn = {
    say: null,
    setMode: null,
    sleep: null,
    spawns: [],
    raw,
  };

  const sayMatch = SAY_RE.exec(raw);
  if (sayMatch) {
    const text = sayMatch[1].trim();
    result.say = text.length > 0 ? clampSay(text) : null;
  } else if (!SLEEP_RE.test(raw)) {
    // Defensive fallback: model emitted bare prose without <say> wrapping.
    // Treat the whole turn as the spoken content so the user actually sees
    // the reply. Strip any <set_mode> tags so they don't show in the
    // bubble. Skipped entirely when the turn contains a <sleep> — that's
    // the going-silent contract (silence IS the response), and any prose
    // around the sleep tag is model debug noise we should drop.
    const stripped = raw
      .replace(/<set_mode>[^<]*<\/set_mode>/gi, '')
      .trim();
    if (stripped.length > 0) {
      result.say = clampSay(stripped);
    }
  }

  const modeMatch = SET_MODE_RE.exec(raw);
  if (modeMatch) {
    const mode = modeMatch[1].toLowerCase() as OperatorMode;
    if (mode === 'active' || mode === 'passive') result.setMode = mode;
  }

  const sleepMatch = SLEEP_RE.exec(raw);
  if (sleepMatch) {
    const attrs = parseAttrs(sleepMatch[1]);
    const dur = Number(attrs['duration_minutes']);
    if (!Number.isFinite(dur) || dur <= 0) {
      // Malformed; drop with a warn so we notice if the model drifts.
      // eslint-disable-next-line no-console
      console.warn('[operator-converse] dropped malformed <sleep>: bad duration_minutes', {
        attrs,
        raw,
      });
    } else {
      result.sleep = {
        // Cap at 1 day. The plan's intent for <sleep> is "give me a
        // minute" / "I'm busy this hour" — anything longer than a day
        // is almost certainly a model formatting bug, and parking the
        // operator for weeks/years on a stray "9999" would be a footgun.
        durationMinutes: Math.min(Math.floor(dur), 60 * 24),
        reason: attrs['reason'] ?? '',
      };
    }
  }

  // Spawn tags — collect every <spawn …> in the turn.
  let spawnMatch: RegExpExecArray | null;
  // Reset regex state because g-flag is sticky.
  SPAWN_RE.lastIndex = 0;
  while ((spawnMatch = SPAWN_RE.exec(raw)) !== null) {
    const attrs = parseAttrs(spawnMatch[1]);
    const role = (attrs['role'] ?? '').trim();
    if (!role) {
      // eslint-disable-next-line no-console
      console.warn('[operator-converse] dropped malformed <spawn>: missing role', { attrs });
      continue;
    }
    const extrasRaw = attrs['extras'] ?? '';
    const extras = extrasRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    result.spawns.push({
      role,
      featureId: attrs['feature'] ? attrs['feature'] : null,
      chunkId: attrs['chunk'] ? attrs['chunk'] : null,
      extras,
    });
  }

  // Sleep + say is contradictory per the prompt contract. Drop sleep
  // when both present; the user-visible say wins. Log so we notice if
  // the model is making this mistake regularly.
  if (result.sleep && result.say) {
    // eslint-disable-next-line no-console
    console.warn('[operator-converse] dropped <sleep> because <say> was also emitted (going-silent contract)', {
      raw,
    });
    result.sleep = null;
  }

  return result;
}

// ─── sessionStorage / localStorage hooks for runtime state ──────────────

const MODE_KEY = 'papercusp.operatorMode';
const SLEEP_UNTIL_KEY = 'papercusp.operatorSleepUntilMs';
const MESSAGES_KEY = 'papercusp.operatorMessages';
const MESSAGES_MAX = 100; // bound the stored history to keep sessionStorage well under quota

/**
 * Read the operator's current mode from sessionStorage. Returns null
 * when the storage is empty (signals "not yet seeded from settings"
 * to the bootstrap logic in OperatorConversation).
 *
 * Mode is intentionally sessionStorage (not localStorage): every fresh
 * app open re-seeds from the user's `activeOnStartup` setting (default
 * true). Mid-session toggles persist within the tab; refreshing the
 * tab is treated as a fresh session.
 */
export function readOperatorModeFromSession(): OperatorMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(MODE_KEY);
    if (v === 'active' || v === 'passive') return v;
    return null;
  } catch {
    return null;
  }
}

export function writeOperatorModeToSession(mode: OperatorMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MODE_KEY, mode);
  } catch { /* sandbox / quota */ }
}

/**
 * Read the sleep-until epoch (ms). 0 or negative means "no sleep
 * timer set" or "expired". The "want active?" gate uses this.
 *
 * Stored in sessionStorage so it resets on tab close — the operator's
 * patience-tuning is relevant only for the current session.
 */
export function readSleepUntilMs(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = window.sessionStorage.getItem(SLEEP_UNTIL_KEY);
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeSleepUntilMs(epochMs: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (epochMs <= 0) window.sessionStorage.removeItem(SLEEP_UNTIL_KEY);
    else window.sessionStorage.setItem(SLEEP_UNTIL_KEY, String(epochMs));
    // Fan out so the chip + silence-timer effect re-evaluate without
    // having to poll sessionStorage.
    window.dispatchEvent(
      new CustomEvent('papercusp:operatorSleep', { detail: { sleepUntilMs: epochMs } }),
    );
  } catch { /* sandbox / quota */ }
}

/** Wake the operator immediately. No-op when no sleep is set. */
export function clearOperatorSleep(): void {
  writeSleepUntilMs(0);
}

/** Convenience: convert a parsed sleep tag to an absolute epoch ms. */
export function sleepTagToEpochMs(
  sleep: { durationMinutes: number },
  now: number = Date.now(),
): number {
  return now + sleep.durationMinutes * 60 * 1000;
}

// ─── Conversation history persistence ────────────────────────────────────
//
// Stored in sessionStorage to match mode + sleep semantics: persist
// within the tab, reset on a fresh app open. Cross-tab sharing is NOT
// attempted — each tab runs its own conversation. Capped at MESSAGES_MAX
// items to bound the storage footprint; older messages are dropped FIFO.
//
// The provider rehydrates from this on mount and writes after every
// state change. Schema is `{ role, content, tools? }` — same shape as
// ChatConversation's ChatMessage so no extra adapter is needed.

interface PersistedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  tools?: unknown[];
}

export function readOperatorMessagesFromSession(): PersistedMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is PersistedMessage => {
        if (!m || typeof m !== 'object') return false;
        const r = (m as { role?: unknown }).role;
        const c = (m as { content?: unknown }).content;
        if (r !== 'user' && r !== 'assistant' && r !== 'system') return false;
        if (typeof c !== 'string') return false;
        return true;
      })
      .slice(-MESSAGES_MAX);
  } catch {
    return [];
  }
}

export function writeOperatorMessagesToSession(messages: PersistedMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = messages.length > MESSAGES_MAX
      ? messages.slice(messages.length - MESSAGES_MAX)
      : messages;
    window.sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or sandboxed — drop silently. The in-memory state
    // remains; we just lose persistence for this tab. Rare in practice
    // because of the MESSAGES_MAX cap.
  }
}

export function clearOperatorMessagesFromSession(): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(MESSAGES_KEY); } catch { /* ignore */ }
}
