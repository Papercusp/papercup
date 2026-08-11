/**
 * Owner CHAT-PANE turns — the owner's HUD-chat message delivered as the turn
 * itself (EI-20130618357432548 / EI-20130675657060052).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * [owner 2026-08-11] "make it so that the response shows in the chat gui
 * like in the screenshot … it should show in the turn history same as if I had
 * the turn in the tui".
 *
 * The owner types "hi" in the session chat popup. That posts a plain coord:send
 * (`/api/admin/coord/send`, `?client=pc-admin-coord-ui`), and a PARKED recipient
 * is woken through the ordinary await pump — so what actually landed in the
 * agent's transcript as the user turn was the pump's own envelope:
 *
 *     ⟦turn-origin:wake-pump nonce:…⟧
 *     [await-event] coord:inbox-wake:su-… fired — hi. (event-wake delivery
 *     #12672 — a delivery-log id, not your wake count; …) NOTE (inbox-wake): …
 *
 * ONE substitution, both filed bugs:
 *
 *  1. The chat pane merges the owner's own sends into the transcript by EXACT
 *     trimmed text equality (`sent-message-echo.ts`). "hi" never equals that
 *     blob, so absorption always failed and the echo was APPENDED — the owner's
 *     message rendered BELOW the reply it preceded by 48s, and appeared TWICE
 *     (once as the blob, once as their own bubble).
 *  2. It reads as agent-to-agent mail from `pc-admin-coord-ui`, so the woken
 *     agent "replies to the sender" over coord — which returns `recipients_gone`
 *     (a UI pseudo-agent has no live session) — and then hedges with a second
 *     send to `human`. Two coord sends, one of them an error, for an answer the
 *     owner was only ever going to read in the transcript.
 *
 * ── What this module does, and the one thing it deliberately does NOT do ─────
 *
 * The send path stamps {@link OWNER_CHAT_TURN_MARKER} + the owner's FULL text on
 * the wake payload; `wake-executor`'s `wakeTurnText` then delivers that text
 * VERBATIM as the turn, with a single delimited {@link OWNER_CHAT_NOTE_TAG}
 * note, and the chat pane strips both machine annotations before rendering. The
 * owner sees exactly what they typed, once, in chronological order, and the
 * agent's ordinary turn response is the reply — same as a TUI turn.
 *
 * ⛔ It does NOT deliver the turn UNENROLLED (no envelope), which is the obvious
 * way to make it "identical to a TUI turn" and is UNSAFE. An unenrolled turn
 * classifies OWNER (interactive) — and `/api/admin/coord/send` admits a
 * no-Origin localhost POST (CSRF backstop only), so any agent with a shell could
 * `curl` it and mint an owner-stamped turn in a PEER's session. The provenance
 * hook auto-registers an AUTO/DRAIN mode grant on that branch and ONLY that
 * branch (`userpromptsubmit-provenance.sh`), so that is a direct agent→peer
 * privilege escalation — precisely the confusion class the turn-provenance
 * protocol exists to kill (see `inbox-reply.ts`'s SECURITY note). The wake stays
 * enrolled and keeps minting the EXISTING `coord-inject:owner` origin: the
 * trust boundary is unchanged by this fix. Reopening that route requires fixing
 * the admin route's authentication first — the seam is the weak link, not the
 * envelope.
 *
 * ── Zero imports, on purpose ─────────────────────────────────────────────────
 *
 * `wake-executor` → `inbox-wake` → `engine` → `wake-executor` is a real import
 * cycle (it is why `wake-executor.ts` hand-duplicates `COORD_INBOX_WAKE_PREFIX`
 * rather than importing it). This module is a leaf with NO imports, so the send
 * path, the wake executor and the browser-side chat pane can all share ONE
 * definition of the marker and the delimiters instead of three copies drifting
 * apart. It is also why it is safe to import from client code across the
 * `@papercusp/operator-core/lib/...` seam.
 */

/** Payload flag `wakeTurnText` reads to choose the owner-chat turn shape.
 *  Mirrors the `INBOX_OWNER_REPLY_MARKER` convention in `inbox-reply.ts`. */
export const OWNER_CHAT_TURN_MARKER = 'ownerChatTurn' as const;

/** Payload field carrying the owner's message VERBATIM.
 *
 *  The wake's `summary` cannot be used for this: the composer truncates it to 80
 *  chars with an ellipsis (`use-owner-session-chat.ts`), so a longer message
 *  would reach the agent cut in half. */
export const OWNER_CHAT_TEXT_FIELD = 'ownerChatText' as const;

/** Opens the one machine-authored line appended to an owner-chat turn. Chosen to
 *  match the ⟦…⟧ family already used by the turn-origin envelope, so a human
 *  reading a raw transcript recognises it as plumbing at a glance. */
export const OWNER_CHAT_NOTE_TAG = '⟦owner-chat⟧';

/**
 * The note appended to the owner's text in the delivered turn.
 *
 * This is the whole fix for the second bug. An agent that receives a coord
 * message genuinely CANNOT tell that this particular sender is a UI pseudo-agent
 * the owner reads a transcript through rather than a peer awaiting a reply — and
 * the standing coordination rule ("an answer not SENT back was never delivered")
 * is correct everywhere else, which is exactly why it produced two sends here.
 * So the turn says it explicitly, at the moment of action.
 */
export const OWNER_CHAT_TURN_NOTE =
  `${OWNER_CHAT_NOTE_TAG} Your owner typed the message above in their session chat pane, and that ` +
  'pane renders YOUR TRANSCRIPT — so answer in THIS TURN, in your ordinary response, and they will ' +
  'see it. Do NOT coord:send a reply: the sender id is a UI pseudo-agent with no live session, so a ' +
  'reply addressed to it fails with recipients_gone, and mirroring it to `human` puts your answer in ' +
  'the Inbox rather than the chat they are looking at. Zero coord sends are needed to answer this.';

/** The wake-payload fields that turn an ordinary coord wake into an owner-chat
 *  turn. Spread into the payload by the send path; `text` must be the owner's
 *  message verbatim. Returns nothing to spread when `text` is empty, so a
 *  body-less send degrades to the ordinary wake shape rather than delivering an
 *  empty turn. */
export function ownerChatWakePayloadFields(text: string): Record<string, unknown> {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return {};
  return { [OWNER_CHAT_TURN_MARKER]: true, [OWNER_CHAT_TEXT_FIELD]: trimmed };
}

/**
 * The owner's message when this delivery payload is an owner-chat turn, else
 * null. Pure and defensive — it runs on the wake executor's hot path against an
 * untyped `unknown` payload, and a malformed one must fall through to the
 * ordinary wake text rather than throw.
 */
export function readOwnerChatTurnText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p[OWNER_CHAT_TURN_MARKER] !== true) return null;
  const text = p[OWNER_CHAT_TEXT_FIELD];
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/** The delivered turn body: the owner's words first, one delimited machine note
 *  last. The order matters — the owner's text leads so the agent reads the
 *  actual message first, and the note is trailing + delimited so the chat pane
 *  can strip it back off deterministically. */
export function ownerChatTurnText(ownerText: string): string {
  return `${ownerText.trim()}\n\n${OWNER_CHAT_TURN_NOTE}`;
}

/** Matches the canonical turn-origin envelope prefix.
 *
 *  A LOCKSTEP MIRROR of `ENVELOPE_RE` in `../../turn-provenance/turn-provenance.ts`
 *  (which also mirrors it into `userpromptsubmit-provenance.sh`) — kept here
 *  rather than imported because that module is not a leaf and this one must stay
 *  import-free to cross the client seam. Change them together. */
const TURN_ORIGIN_ENVELOPE_RE = /^\s*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧[ \t]*\r?\n?/;

/**
 * Strip papercusp's machine annotations from a transcript user turn for DISPLAY.
 *
 * The chat pane renders `turn.prompt.text` raw, which is why the owner saw the
 * turn-origin envelope and the wake blob in their own conversation. Two things
 * come off, and only these two — anything else the agent was genuinely sent
 * stays, because silently hiding delivered content is a worse failure than
 * showing plumbing:
 *
 *   1. a leading `⟦turn-origin:… nonce:…⟧` envelope (pure injection plumbing,
 *      never meaningful to a human reader), and
 *   2. a trailing `⟦owner-chat⟧ …` note (machine-authored, addressed to the
 *      agent, and the owner did not type it).
 *
 * PURE → unit-tested. Returns the input unchanged when neither is present, so
 * every ordinary turn is byte-identical.
 */
export function stripMachineTurnAnnotations(text: string): string {
  if (!text) return text;
  let out = text.replace(TURN_ORIGIN_ENVELOPE_RE, '');
  const noteAt = out.indexOf(OWNER_CHAT_NOTE_TAG);
  if (noteAt >= 0) out = out.slice(0, noteAt);
  return out.trim();
}
