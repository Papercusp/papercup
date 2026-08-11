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

/**
 * The owner's typed text out of a coord message body, whichever shape it is in.
 *
 * ⚠ THE SHAPE IS NOT THE ONE THE GUI POSTS. The chat composer sends `body` as a
 * plain string, but it never reaches the send tool that way: the GUI wrapper
 * (`applyOwnerMessageDefaults` in `owner-message.ts`) rewrites it to a SECTION
 * ARRAY — `[{ text, forYouBecause }]` — before dispatch, because agent-authored
 * coord messages require that shape. So the send path sees an array, and a
 * `typeof body === 'string'` guard at the call site silently yields "" for every
 * real owner message: the marker is never stamped, the wake falls back to the
 * generic envelope, and NOTHING fails loudly. That is exactly how this shipped
 * broken the first time — the unit tests covered the string shape only, stayed
 * green, and the live send still delivered the old blob. Both shapes are pinned
 * in the suite now.
 *
 * Normalising HERE rather than at the call site is the point: a caller that has
 * to ask "is this a string or sections?" is a caller that can get it wrong.
 */
export function ownerChatTextFromBody(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (Array.isArray(body)) {
    return body
      .map((section) => {
        if (!section || typeof section !== 'object') return '';
        const text = (section as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter((t) => t.trim().length > 0)
      .join('\n\n')
      .trim();
  }
  return '';
}

/** The wake-payload fields that turn an ordinary coord wake into an owner-chat
 *  turn. Spread into the payload by the send path.
 *
 *  Takes the RAW body — string or section array, see {@link ownerChatTextFromBody}
 *  — so the call site never has to know which it got. Returns nothing to spread
 *  when there is no text, so a body-less send degrades to the ordinary wake shape
 *  rather than delivering an empty turn. */
export function ownerChatWakePayloadFields(body: unknown): Record<string, unknown> {
  const text = ownerChatTextFromBody(body);
  if (!text) return {};
  return { [OWNER_CHAT_TURN_MARKER]: true, [OWNER_CHAT_TEXT_FIELD]: text };
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

/**
 * The turn-provenance origin minted for a turn the AUTHENTICATED HUMAN authored
 * through an admin-only surface — today the HUD chat pane and the owner Inbox
 * reply, which are the same authority and deliberately share one origin.
 *
 * It lives HERE, in the import-free leaf, because two very different files must
 * agree on it EXACTLY: `wake-executor.ts` MINTS it, and `ownerVisiblePromptText`
 * below KEYS THE DISPLAY FILTER ON IT. If those two ever drift apart, the failure
 * is silent and points the wrong way — the owner's own messages stop matching and
 * VANISH from their chat pane, which is far worse than the plumbing leak this
 * filter exists to stop. A shared constant makes that drift impossible.
 */
export const OWNER_CHAT_TURN_ORIGIN = 'coord-inject:owner';

/** Same envelope as TURN_ORIGIN_ENVELOPE_RE, but CAPTURING the origin. */
const TURN_ORIGIN_CAPTURE_RE = /^\s*⟦turn-origin:([A-Za-z0-9:._@-]+) nonce:[a-f0-9]{8,64}⟧/;

/** A Stop-hook coaching block: written BY the harness TO the agent, recorded as a
 *  `user`-role turn purely because that is the injection channel. */
const HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:';

/**
 * What a `user`-role transcript turn should show in the OWNER'S CHAT PANE —
 * `''` when the turn is machine-authored and belongs to no conversation.
 *
 * EI-20135573616431912, owner-reported. `stripMachineTurnAnnotations` removes the
 * envelope but RETURNS THE BODY, so every machine wake rendered as a message from
 * the owner: loop-fire wake instructions, wake-pump envelopes, and Stop-hook
 * coaching walls all appeared in their chat as things they had apparently said.
 * The owner's report was "I said hi and it replied with all this" — he was reading
 * the agent's private supervision, attributed to himself.
 *
 * MEASURED, not guessed (3 days of `session_turns` where speaker='user'):
 *   1756 turn-origin envelopes · 1540 genuine owner turns · 71 coord injections ·
 *   44 Stop-hook walls. So the machine half is the MAJORITY of that pane's
 *   user-role rows, and the hook walls the owner happened to paste are the small
 *   part of it.
 *
 * The rule is an ALLOW-LIST ON PROVENANCE, not a deny-list of markers — a
 * deny-list rots silently every time a new wake kind is added, and it fails
 * OPEN (leaking machine text) which is the direction that produced this bug:
 *   - envelope present, origin === OWNER_CHAT_TURN_ORIGIN → the human authored it → SHOW
 *   - envelope present, any other origin                  → machine-injected     → HIDE
 *   - no envelope, Stop-hook wall                         → harness coaching     → HIDE
 *   - no envelope, anything else                          → typed by the human   → SHOW
 *
 * This is a RENDER filter only. Nothing is deleted: the full turn stays in the
 * transcript stores and in every audit/session-search path. The narrower reading
 * of "never hide delivered content" in `stripMachineTurnAnnotations` above still
 * holds for what it governs — a wake blob was delivered to the AGENT, and this
 * pane is the OWNER's conversation, so it was never theirs to be shown.
 *
 * PURE → unit-tested.
 */
export function ownerVisiblePromptText(text: string): string {
  if (!text) return '';
  const origin = text.match(TURN_ORIGIN_CAPTURE_RE)?.[1];
  if (origin !== undefined) return origin === OWNER_CHAT_TURN_ORIGIN ? stripMachineTurnAnnotations(text) : '';
  if (text.trimStart().startsWith(HOOK_FEEDBACK_PREFIX)) return '';
  return stripMachineTurnAnnotations(text);
}
