/**
 * coord:send — send a typed message (or coord broadcast) to one or
 * more other agents. agent-coordination-architecture-v2 §6.4 (#6).
 *
 * Persists to the `messages` surface of the CoordEventLog (the operator
 * backs it with Postgres — harness_shared.coord_event_log). Recipients
 * see it via coord:inbox.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): the SINGLE form
 * { to, summary, … } sends ONE message (its `to` is a multi-RECIPIENT list — one
 * message to many addressees, unchanged). The NEW `items:[{ to, summary, … }]`
 * axis sends N DISTINCT messages in one call. Both return the house envelope
 * { ok, results:[{ ok, to, msg_id? … | error }], counts } — each result
 * self-describes its `to` (+ returned msg_id); one failed message never fails the
 * rest. All routing/recipient-resolve/wake/endTurn logic runs PER message.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { fetchPresenceFleet } from '../presence-fleet';
import { scopeBroadcastAudience } from '../scope-broadcast';
import { resolveSenderCueAuthority } from '../cue-authority-resolve';
import { CUE_AUTHORITY_FIELD, type CueAuthorityStamp } from '../cue-authority';
import { sendMessage, getMessageById } from '../messages';
import { parseSlotSelector } from '../slot-selector';
import { wakeRecipients, reportIdleRecipients, buildStagedWakeNote } from '../inbox-wake';
import { describeMissedRecipients, type MissedRecipientLiveness } from '../recipient-liveness';
import { resolveRecipients, isSelectorOrWildcard, remoteSessionsByOwnerId } from '../recipient-resolve';
import { resolveWorkspaceHiveScope } from '../federation-scope';
import { COORD_ROLES } from '../roles';
import { forceEndTurn } from '../../turn/interrupt';
import { runBulk, bulkContent, type BulkItemResult } from '../../_bulk';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/** Settle window between an endTurn ESC and the following wake (coord-end-turn D-003): lets each recipient's
 *  CLI finish ending the dead turn + re-arm its `coord:inbox-wake:<owner>` watch before the wake fires, so
 *  the wake doesn't race the abort and land woken:0. Env-tunable. */
const ENDTURN_SETTLE_MS = Number(process.env.PAPERCUSP_ENDTURN_SETTLE_MS) || 1500;

/** One distinct message's full arg set (the new `items` axis carries N of these). */
interface SendMsg {
  to: string[];
  summary: string;
  body?: string;
  files?: string[];
  plan_slug?: string;
  related_msg_id?: string;
  wake?: boolean | 'required' | 'optimistic';
  wakeOnReply?: boolean;
  /** EI-8986: "nudge if silent" — the dual of wakeOnReply (which wakes you when
   *  a reply ARRIVES). If no reply lands within this many seconds, the
   *  reply-deadline-sweep (dbos/periodic-workflows.ts, every 5m) nudges you
   *  once: a coord message + a fail-soft wake. Independent of wakeOnReply —
   *  set either, both, or neither. Omitted = no deadline tracking (today's
   *  behavior). */
  replyDeadlineSec?: number;
  endTurn?: boolean;
  /** P-001 (cross-machine-coord-parity-and-trust): federation-scope override.
   *  'hive' forces the workspace's shared-Hive scope (loud error naming the
   *  candidates when none/ambiguous); 'local' keeps this message machine-local
   *  even for a harness-scoped sender. Omitted = auto (ctx harness, else the
   *  workspace's single shared Hive, else local). */
  scope?: 'hive' | 'local';
  /** FF#1: name the DURABLE BACKSTOP that will re-dispatch a wake:'optimistic' miss
   *  (e.g. 'queen-survey re-dispatches'). Optimistic is silent-on-miss ONLY when a
   *  backstop is declared; WITHOUT one, an optimistic miss is reported as loudly as a
   *  required miss (recipient_absent) — silence must be consciously claimed. */
  backstop?: string;
  /** fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. A
   *  fleeted sender's bare `['*']` is auto-scoped to `@fleet:<slug>`; set allHive:true
   *  to keep `'*'` literal and reach every agent (system-wide issue / urgent notice).
   *  No effect for a non-fleeted sender or a directed send. */
  allHive?: boolean;
}

/** Whether `to` is a DIRECTED send: at least one recipient, ALL concrete (none a
 *  selector / wildcard / '*' / 'human' — `isSelectorOrWildcard` already covers
 *  those). Used as the DEFAULT for wakeOnReply (ON for directed, OFF for broadcast). */
function isDirected(to: string[]): boolean {
  return to.length > 0 && to.every((id) => !isSelectorOrWildcard(id));
}

const wakeArg = z
  .union([z.boolean(), z.enum(['required', 'optimistic'])])
  .optional()
  .describe(
    "Wake a SLEEPING addressee NOW, not just inject. 'required' = the wake MUST land: a clean miss (no awake/watching session, none paused) returns recipient_absent:true — a loud miss to handle, not a silent ok. 'optimistic' = best-effort, SAFE ONLY when a durable backstop re-dispatches a miss (e.g. the Queen survey) — and you must NAME that backstop via the `backstop` arg. WITHOUT a declared backstop an optimistic miss is now reported as loudly as a required miss (recipient_absent + the missed agents' fresh sessionState), so you can't silently hand work to a dead agent. For a one-off transfer to a specific agent, prefer 'required' (verify woken≥1) or coord:handoff. Omit = plain inject. Legacy boolean: true → 'required', false → no wake. Targeted to the addressees only — never a broadcast ('*'/'human' are skipped).",
  );

const wakeOnReplyArg = z
  .boolean()
  .optional()
  .describe(
    "When a peer REPLIES to this message (their coord:send sets related_msg_id to this message's msg_id), wake YOU (the sender) so you re-invoke the moment the reply lands — the dual of waking the recipient. Default: ON for DIRECTED sends (concrete recipients), OFF for broadcasts (to '*'/'human'). Set false to opt out (fire-and-forget).",
  );

const replyDeadlineSecArg = z
  .number()
  .positive()
  .optional()
  .describe(
    'EI-8986: "nudge if silent" — the dual of wakeOnReply (which wakes you when a reply ARRIVES; this wakes you when one does NOT). If no reply lands within this many seconds, a periodic backstop sweep nudges you ONCE: a coord message + a fail-soft wake — never a recurring alarm. Independent of wakeOnReply — set either, both, or neither. Omit for no deadline tracking (today\'s behavior).',
  );

const endTurnArg = z
  .boolean()
  .optional()
  .describe(
    "ESC each addressee's CURRENT turn (mimic pressing Escape) BEFORE delivering — the dual of wake-as-Enter. Use ONLY when a recipient's turn is STUCK (e.g. wedged on an API error so a plain wake reaches nobody / typing+Enter won't start the next turn): the ESC ends the dead turn so the CLI re-arms, then (with wake) this message starts a fresh turn. Force-ESC is audited + storm-rate-limited; only end a turn you KNOW is stuck. Skips '*'/'human'/self.",
  );

const toArg = z
  .array(z.string().min(1), {
    error:
      'coord:send needs `to`: recipient ids. Accepts the SHORT HANDLE shown in the [coord+N] injection / inbox (e.g. "93a38"), the "su-…" prefix, OR the full ownerId — all resolve against the live roster, so NO coord:presence lookup is needed to reply to a peer. ["*"] broadcasts, ["human"] surfaces to the user. AUDIENCE SELECTORS expand to a group: @fleet:<slug> (live members of a named fleet — the cohort an agent joins, no per-agent subscribe), @fleet-leader:<slug> (escalate to the fleet lead), @topic:<slug>, @plan:<slug>, @object:<kind>:<ref>, @file:<path>. The selector is preserved as the audience key, so members catch up later via coord:catch-up. (To make a peer who is waiting on your reply act NOW rather than on their next turn, set wake:"required" — a plain send only injects.)',
  })
  .min(1, 'coord:send needs at least one recipient in `to` — ["*"] broadcasts, ["human"] surfaces to the user.');

const summaryArg = z
  .string({
    error:
      'coord:send needs `summary`: a one-line headline of the message (what the recipient sees in their inbox).',
  })
  .min(1, '`summary` must be a non-empty one-line headline.');

const backstopArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "FF#1: name the DURABLE BACKSTOP that re-dispatches a wake:'optimistic' miss (e.g. 'queen-survey re-dispatches'). Optimistic stays silent-on-miss ONLY when you declare one; WITHOUT a backstop an optimistic miss is reported as loudly as a required miss (recipient_absent). Do NOT pass a fake backstop to silence the warning — that re-creates the dead-drop trap. No effect on wake:'required' / inject.",
  );

const scopeArg = z
  .enum(['hive', 'local'])
  .optional()
  .describe(
    "Federation scope of THIS message (cross-machine-coord-parity P-001). Omitted = auto: a harness-scoped sender stamps its harness; an un-scoped (SU/operator) sender in a workspace with EXACTLY ONE shared Hive stamps that Hive's home (the message federates to the Hive's other machines); otherwise the message stays machine-local. 'hive' FORCES the shared-Hive scope — errors loudly (no_hive_scope / ambiguous_hive_scope + candidates) instead of silently staying local. 'local' keeps the message on this machine only. Every result reports `federated:` so a local-only send is never mistaken for cross-machine delivery.",
  );

const allHiveArg = z
  .boolean()
  .optional()
  .describe(
    "fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. If YOU are in a fleet, a bare to:['*'] is auto-scoped to your fleet (@fleet:<slug>, leader included) so routine status doesn't flood every agent — the result reports the rewrite as `scopedBroadcast`. Set allHive:true to keep '*' literal and reach EVERY agent, for system-wide issues / urgent notices only. No effect for a non-fleeted sender or a directed send.",
  );

const itemSpec = z.object({
  to: toArg,
  summary: summaryArg,
  body: z.string().optional(),
  files: z.array(z.string()).optional(),
  plan_slug: z.string().optional(),
  related_msg_id: z.string().optional(),
  wake: wakeArg,
  wakeOnReply: wakeOnReplyArg,
  replyDeadlineSec: replyDeadlineSecArg,
  endTurn: endTurnArg,
  backstop: backstopArg,
  scope: scopeArg,
  allHive: allHiveArg,
});

/**
 * Send ONE distinct message — the full per-message pipeline (recipient resolve →
 * endTurn → persist → wake / idle-report). Returns the self-describing result for
 * the bulk envelope: it embeds the message's `to` (its key) + the minted msg_id.
 * A recipient-resolve miss is this message's { ok:false } (it does NOT throw), so
 * one bad address never fails the other messages in the batch.
 */
async function sendOne(
  msg: SendMsg,
  identity: AgentIdentity,
  harnessSlug: string | null,
  bcast?: { scoped?: { from: '*'; to: string; reason: string }; allHive?: boolean },
  cueAuthority?: CueAuthorityStamp | null,
): Promise<BulkItemResult> {
  // Wake INTENT (directed-wake-honesty D-002): 'required' = the wake must land
  // (a clean miss → recipient_absent); 'optimistic' = best-effort over a durable
  // backstop (silent miss). Legacy boolean coerces: true → 'required' (the safe
  // loud default), false/omit → no wake.
  const wakeMode: 'required' | 'optimistic' | null =
    msg.wake === true ? 'required' : msg.wake === false || msg.wake == null ? null : msg.wake;

  // wake-on-reply (coord-wake-on-reply): when a peer REPLIES to this message
  // (their coord:send sets related_msg_id to this msg_id) the ORIGINAL sender
  // should be re-invoked — the dual of deliver-and-wake. Default ON for a
  // DIRECTED send (concrete recipients), OFF for a broadcast ('*'/'human');
  // explicit `wakeOnReply:false` always wins, `true` forces on. Flag-gated:
  // when OFF, neither the opt-in is persisted nor a reply fires the wake
  // (today's behavior). Fail-safe to ON on a flag-read error (the new default).
  const wakeOnReplyFlag = await getFlag(FLAGS.COORD_WAKE_ON_REPLY, 'system').catch(() => true);
  const effectiveWakeOnReply = wakeOnReplyFlag && (msg.wakeOnReply ?? isDirected(msg.to));

  // owner-2026-06-17: validate + resolve recipients against the live roster
  // BEFORE sending. A short ownerId PREFIX resolves to the full id (so the exact
  // `coord:inbox-wake:<ownerId>` wake key matches and the wake lands); a concrete
  // recipient that matches NO known agent is a LOUD error — the send does NOT
  // happen — instead of the old silent ok:true. Fail-soft: a roster-read hiccup
  // degrades to the raw ids (never blocks coord). Local-roster scoped.
  let toSend = msg.to;
  if (msg.to.some((id) => !isSelectorOrWildcard(id))) {
    try {
      const r = await resolveRecipients(msg.to, identity.workspaceId);
      if (r.unknown.length || r.ambiguous.length) {
        return {
          ok: false,
          to: msg.to,
          error: 'unknown_recipient',
          message:
            'coord:send addressed agent(s) not in the roster — nothing was sent. ' +
            'Use the short handle from [coord+N]/inbox, the su- prefix, or the full ownerId ' +
            '(coord:presence lists them); a substring of a live ownerId also resolves.',
          ...(r.unknown.length ? { unknown_recipients: r.unknown } : {}),
          ...(r.ambiguous.length ? { ambiguous_recipients: r.ambiguous } : {}),
        };
      }
      toSend = r.resolved;
    } catch (e) {
      console.warn(
        `[coord:send] recipient resolve failed, sending unresolved: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // EI-279: persist the wake intent ON the envelope so it federates — a recipient
  // homed on a REMOTE instance is woken by the coord-message projection's fan when
  // the row arrives there (the local fan below only covers THIS instance's await
  // store). coord-wake-on-reply: ALSO persist `wakeOnReply:true` when this directed
  // send opted in, so a FUTURE reply (which looks the original up by msg_id) can see
  // the opt-in and wake us back. Both keys merge onto the persisted envelope.
  const extra: Record<string, unknown> = {};
  if (wakeMode) extra.wake = true;
  if (effectiveWakeOnReply) extra.wakeOnReply = true;
  // EI-8986: stamp an absolute deadline (epoch ms) so the reply-deadline-sweep
  // (dbos/periodic-workflows.ts) can select it with a simple `<= now` compare —
  // no need to re-derive "elapsed since send" from `ts` at sweep time. Positive
  // finite seconds only; a bad value is silently dropped rather than failing
  // the send (this is a best-effort nudge, never a hard requirement).
  if (typeof msg.replyDeadlineSec === 'number' && Number.isFinite(msg.replyDeadlineSec) && msg.replyDeadlineSec > 0) {
    // Math.round: the zod arg allows FRACTIONAL seconds, but the sweep (and the
    // 536 partial index) cast this field `::bigint` — a fractional stamp like
    // 1752119999999.1 would fail that cast at sweep time. Integer ms always.
    extra.replyDeadlineAt = Math.round(Date.now() + msg.replyDeadlineSec * 1000);
  }
  // P-008 (cross-machine-coord-parity): a FEDERATED, DIRECTED, required-wake
  // send requests a DELIVERY RECEIPT — the receiving machine's projection sends
  // back a fed-event `coord:receipt:<msg_id>` when it applies the row (payload:
  // woken count + machine). The result carries `receiptEvent`; await it
  // (events:await) to close the cross-machine wake-honesty loop.
  const wantReceipt = wakeMode === 'required' && isDirected(msg.to) && Boolean(harnessSlug);
  if (wantReceipt) extra.receipt = true;
  // P-003 (queen-fleet-authority-boundary): a fleet leader's / Queen's BROADCAST
  // (a "status send") carries the sender's structured authority + scope, so a
  // recipient reads a leader's fleet-scoped blast as fleet-leader→fleet-members and
  // never mistakes it for a hive-wide Queen directive. Resolved by the caller only
  // for broadcasts; a directed 1:1 send is left unstamped (no noise).
  if (cueAuthority) extra[CUE_AUTHORITY_FIELD] = cueAuthority;
  const env = await sendMessage(identity, {
    to: toSend,
    summary: msg.summary,
    body: msg.body,
    files: msg.files,
    plan_slug: msg.plan_slug,
    related_msg_id: msg.related_msg_id,
    // WI-3653: pass the resolved scope THROUGH, including the explicit-local
    // null — omitting it would re-trigger sendMessage's AUTO default and defeat
    // scope:'local'.
    harnessSlug,
    ...(Object.keys(extra).length ? { extra } : {}),
  });

  // EI-6874 (zero-recipient audience send is a refusal-class event, not a silent
  // ok): a LIVE-audience selector (@fleet:/@fleet-leader:/@topic:/@plan:/@object:/
  // @file:) resolves to a set of live recipients at send time; sendMessage's
  // `env.to` IS that expanded set (empty ⇒ nobody). A SLOT selector
  // (@role:/@wave:/@feature:/@user:) legitimately parks for a future agent, so a
  // zero there is expected and NOT a miss — those are excluded here.
  //
  // The incident: fleet p2p-dist's leader sent a drain order to @fleet:p2p-dist,
  // but all 4 members were launched without fleet registration (fleetSlug:null),
  // so the audience resolved to ZERO live members and coord:send returned a SILENT
  // ok:true — the leader then sat ~3h "awaiting compliance acks" nobody could send.
  // We now report recipients_resolved for every audience-selector send and surface
  // a LOUD zero_recipients warning when it reached nobody. An EXPLICIT audience
  // selector reaching nobody is a hard refusal (ok:false); an AUTO-scoped
  // '*'→@fleet broadcast (bcast.scoped — e.g. a solo/quiet fleet) is a soft warning
  // that keeps ok:true. The row still persisted above (audience history /
  // coord:catch-up), so env.msg_id is returned either way.
  const audienceSelectors = msg.to.filter(
    (t) => t.startsWith('@') && parseSlotSelector(t) === null,
  );
  let zeroRecipients: { selectors: string[]; note: string } | undefined;
  if (audienceSelectors.length > 0 && env.to.length === 0) {
    const isFleet = audienceSelectors.some(
      (s) => s.startsWith('@fleet:') || s.startsWith('@fleet-leader:'),
    );
    const hint = isFleet
      ? ' A fleet selector with no live members usually means the members were launched WITHOUT fleet registration (the EI-5835 --fleet trap: fleetSlug:null) — verify via coord:roster that each member row carries the fleetSlug, or address the members by ownerId directly.'
      : ' Nobody currently subscribes to / is present on this audience; the row persisted to audience history, so a later joiner can still catch up via coord:catch-up.';
    const note =
      `coord:send audience ${audienceSelectors.join(', ')} resolved to ZERO live recipients — ` +
      `the message reached NOBODY live.` +
      hint;
    // Hard refusal for an EXPLICIT audience selector; an auto-scoped '*'→@fleet
    // broadcast to an empty/solo fleet is a soft warning (the sender intended a
    // broadcast, not a targeted directive), so keep ok:true and fall through.
    if (!bcast?.scoped) {
      return {
        ok: false,
        to: env.to,
        msg_id: env.msg_id,
        ts: env.ts,
        error: 'zero_recipients',
        recipients_resolved: 0,
        zero_recipients: { selectors: audienceSelectors, note },
        message: note,
      };
    }
    zeroRecipients = { selectors: audienceSelectors, note };
  }

  // Reply-wake (coord-wake-on-reply): if THIS send is a REPLY (it carries a
  // related_msg_id), look the ORIGINAL message up by that id and — when the
  // original opted into wake-on-reply — fire an OPTIMISTIC wake back to its
  // sender so they re-invoke the moment our reply lands. Fully fail-soft: ANY
  // error (lookup miss, sql hiccup, wake failure) is swallowed and NEVER fails
  // or blocks this send (the reply already persisted above). Never self-wakes and
  // never wakes '*'/'human'. Skipped entirely when the flag is OFF.
  let replyWake: { target: string; woken: number } | undefined;
  if (wakeOnReplyFlag && msg.related_msg_id) {
    try {
      const original = await getMessageById(msg.related_msg_id);
      const originalFrom = original?.from;
      const optedIn =
        original != null && (original as { wakeOnReply?: unknown }).wakeOnReply === true;
      if (
        optedIn &&
        typeof originalFrom === 'string' &&
        originalFrom &&
        originalFrom !== identity.ownerId &&
        !isSelectorOrWildcard(originalFrom)
      ) {
        const fan = await wakeRecipients([originalFrom], {
          summary: msg.summary,
          source: identity.ownerId,
        });
        replyWake = { target: originalFrom, woken: fan.woken };
      }
    } catch {
      /* fail-soft: a reply-wake miss/error never blocks the (already-persisted) send */
    }
  }

  // endTurn (coord-end-turn P-002): ESC each addressed recipient's CURRENT turn BEFORE the wake. A turn
  // STUCK on an API error is NOT sleeping on its inbox-wake key, so a plain wake reaches nobody (woken:0);
  // the ESC ends the dead turn → the CLI returns to idle + re-arms its watch → the wake below starts a
  // fresh turn with this message. Force-ESC reuses turn:interrupt's audit + storm rate-limit; skips
  // '*'/'human'/self. Then SETTLE so the wake doesn't race the abort (D-003).
  let endTurn: { ended: string[]; missed: string[] } | undefined;
  if (msg.endTurn) {
    const targets = env.to.filter((id) => id !== '*' && id !== 'human' && id !== identity.ownerId);
    const ended: string[] = [];
    const missed: string[] = [];
    for (const owner of targets) {
      try {
        const r = await forceEndTurn({
          actor: identity.ownerId,
          workspaceId: identity.workspaceId ?? '*',
          owner,
          reason: msg.summary,
        });
        (r.ok ? ended : missed).push(owner);
      } catch {
        missed.push(owner);
      }
    }
    endTurn = { ended, missed };
    // Give each CLI a moment to finish ending its turn + re-arm its inbox-wake watch before we wake it.
    if (wakeMode && ended.length > 0) await new Promise((r) => setTimeout(r, ENDTURN_SETTLE_MS));
  }

  // Deliver-and-wake (P-040): the message already persisted to the inbox above
  // (the durable default). When the sender opted in, ALSO fire each addressed
  // recipient's OWN inbox-wake key so a SLEEPING addressee is re-invoked — one
  // targeted emit per ownerId, NEVER a broadcast key (P-042). We wake the
  // POST-expansion recipients (`env.to` — audience selectors already resolved),
  // so a `@plan:`/`@topic:` send wakes exactly the resolved set, not '*'.
  let wake:
    | {
        mode: 'required' | 'optimistic';
        targets: string[];
        woken: number;
        staged?: number;
        /** EI-5957: the ownerIds whose wake STAGED (manual wake-mode) — named so a
         *  leader-steering send surfaces WHO didn't get the directive, alongside `note`. */
        stagedTargets?: string[];
        recipient_absent?: boolean;
        /** WI-574: the subset of missed targets with NO live session watching their inbox-wake key —
         *  genuinely dead (not merely paused), so the inject has no "next turn" to be seen on and the
         *  dispatch black-holes until they are re-spawned. A LOUD miss the sender must handle. */
        recipient_dead?: string[];
        /** P-007 (cross-machine-coord-parity): missed targets homed on a REMOTE
         *  machine of this hive — not dead, elsewhere. Delivery + wake continue
         *  via federation when the send is hive-scoped (federated:true). */
        recipient_remote?: string[];
        /** P-010: the subset of recipient_remote whose presence beat is STALE —
         *  probably gone; treat like dead unless the receipt arrives. */
        recipient_remote_stale?: string[];
        /** FF#3: each missed addressee's FRESH session state (ended/parked/…) at the
         *  transfer moment — the un-ignorable "this agent ended" fact in the result. */
        recipient_liveness?: MissedRecipientLiveness[];
        note?: string;
      }
    | undefined;
  if (wakeMode) {
    const fan = await wakeRecipients(env.to, {
      summary: msg.summary,
      source: identity.ownerId,
    });
    wake = { mode: wakeMode, targets: fan.targets, woken: fan.woken };
    if (fan.staged > 0) wake.staged = fan.staged;
    // EI-5957: a wake that STAGED (target in manual wake-mode) is NOT delivered —
    // the leader-steering failure was a quiet `staged:1` read as success while the
    // member never got the directive. Surface it LOUDLY: name the staged target(s)
    // and how to make it land (release the staged wake, or flip to auto). This does
    // NOT run when `missed` fires below (missed requires staged === 0), so the two
    // notes never collide.
    if (fan.stagedTargets.length > 0) {
      wake.stagedTargets = fan.stagedTargets;
      wake.note = buildStagedWakeNote(fan.stagedTargets);
    }
    const missed = fan.targets.length > 0 && fan.woken === 0 && fan.staged === 0;
    if (missed) {
      // FF#1 — the forcing function: a 'required' miss is ALWAYS loud; an 'optimistic'
      // miss is loud UNLESS the caller consciously declared a durable backstop
      // (`backstop:'<what re-dispatches>'`). Silent-on-miss must be CLAIMED, never the
      // default — the incident was an optimistic transfer to a dead agent whose woken:0
      // was read as "fine, the backstop will get it" when there was no backstop.
      const loud = wakeMode === 'required' || !msg.backstop;
      // FF#3: force each missed addressee's FRESH session state into the result so a
      // transfer to a long-dead agent reads `ended`, not a silent woken:0. Miss-path only.
      try {
        const liveness = await describeMissedRecipients(fan.targets);
        if (liveness.length > 0) wake.recipient_liveness = liveness;
      } catch {
        /* fail-soft: liveness enrichment is best-effort */
      }
      if (loud) {
        wake.recipient_absent = true;
        // WI-574 (dispatch-black-hole fix): a miss is NOT necessarily "seen on their next
        // turn" — if the recipient has NO live session watching its inbox-wake key it is
        // genuinely dead and the inject black-holes. Classify the dead ones (same non-firing
        // probe the no-wake path uses) and report them LOUDLY + truthfully.
        let dead: string[] = [];
        // P-007 (cross-machine-coord-parity): a REMOTE-homed recipient has no
        // local watcher by definition — it is not dead, it is elsewhere. Split
        // it out of the dead set and report it truthfully (below).
        let remoteHomed: string[] = [];
        let staleRemote: string[] = [];
        try {
          const report = await reportIdleRecipients(fan.targets, {
            workspaceId: identity.workspaceId ?? undefined,
          });
          dead = report.idle;
          const remote = await remoteSessionsByOwnerId(identity.workspaceId);
          remoteHomed = fan.targets.filter((t) => remote.has(t));
          dead = dead.filter((d) => !remote.has(d));
          // P-010: classify freshness — a remote beat older than the staleness
          // window means the session is probably gone; say so instead of
          // implying the wake will land on arrival.
          const nowMs = Date.now();
          staleRemote = remoteHomed.filter((t) => {
            const seen = remote.get(t);
            return typeof seen === 'number' && nowMs - seen > 10 * 60 * 1000;
          });
        } catch {
          /* fail-soft: keep the generic miss note below */
        }
        const optimisticNoBackstop = wakeMode === 'optimistic';
        if (remoteHomed.length > 0 && dead.length === 0) {
          wake.recipient_remote = remoteHomed;
          if (staleRemote.length > 0) wake.recipient_remote_stale = staleRemote;
          const freshRemote = remoteHomed.filter((t) => !staleRemote.includes(t));
          wake.note = !harnessSlug
            ? `recipient(s) ${remoteHomed.join(', ')} are homed on a REMOTE machine, but this send did NOT ` +
              "federate (federated:false — no hive scope). It will NEVER reach them: re-send with scope:'hive' " +
              'so the message rides the hive topic.'
            : freshRemote.length > 0
              ? `recipient(s) ${freshRemote.join(', ')} are homed on a REMOTE machine of this hive (fresh beat) — ` +
                'the message FEDERATES and the remote machine fires the wake fan on arrival. CONFIRM pickup: ' +
                `events:await the receiptEvent key returned on this result (coord:receipt:<msg_id> — the remote ` +
                'machine acks with delivered+woken), or rely on wakeOnReply.' +
                (staleRemote.length > 0 ? ` STALE remote beat (probably gone): ${staleRemote.join(', ')}.` : '')
              : `recipient(s) ${staleRemote.join(', ')} are remote-homed but their presence beat is STALE — the ` +
                'session is probably gone. The message still federates (seen if it resumes), but do NOT assume ' +
                'pickup: treat this like recipient_dead and re-dispatch to a live agent unless the receipt arrives.';
        } else if (dead.length > 0) {
          wake.recipient_dead = dead;
          wake.note =
            (optimisticNoBackstop
              ? `optimistic wake with NO declared backstop MISSED — `
              : `required wake MISSED — `) +
            `NO live session is watching the inbox of: ${dead.join(', ')}. ` +
            'These agents are not running, so the message will NOT be seen on any "next turn" — the ' +
            'dispatch black-holes until they are re-spawned/resumed. Do NOT assume it landed: re-dispatch ' +
            'to a LIVE agent (coord:presence → wakeable:true), use coord:handoff, or — only if something ' +
            "truly re-dispatches — pass backstop:'<what re-dispatches>'.";
        } else {
          wake.note =
            (optimisticNoBackstop
              ? `optimistic wake with NO declared backstop reached no awake/watching session for: `
              : `required wake reached no awake/watching session for: `) +
            `${fan.targets.join(', ')} — the message was injected; a live-but-paused recipient sees it ` +
            'next turn, but none was re-invoked now. Confirm the recipient is actually running ' +
            '(coord:presence) before assuming pickup.';
        }
      } else {
        // OPTIMISTIC + a declared backstop → silence is consciously claimed. Soft note that
        // NAMES the backstop (no recipient_absent), so it's auditable but not a loud miss.
        wake.note =
          `optimistic wake reached no live session (woken:0) — relying on the declared backstop: ` +
          `"${msg.backstop}". If that backstop will NOT actually re-dispatch, this was NOT picked up — ` +
          "use wake:'required' or coord:handoff instead.";
      }
    }
  }

  // Default (no-wake / inject-only) path — REPORT idle recipients
  // (coord-dispatch-reliability-2026-06-21 P-001). A plain send lands in the
  // inbox but does NOT re-invoke a sleeping agent, so a hand-off injected to an
  // idle agent silently stalls. We NON-FIRINGLY probe each concrete addressee's
  // inbox-wake key (report-only — NEVER a wake on this path, invariant a) and
  // surface the ones no live session is watching, so the sender can re-send with
  // wake:'required' instead of assuming pickup. Fully fail-soft: a roster /
  // await-store hiccup degrades to no report — the send already succeeded
  // (invariant c), so this never blocks or fails it. We probe the SAME
  // post-expansion set the wake fan would (`env.to`), so a `@plan:`/`@topic:`
  // send reports exactly the resolved recipients, never '*'.
  let notWoken: { idleRecipients: string[]; note: string } | undefined;
  if (!wakeMode) {
    const report = await reportIdleRecipients(env.to, { workspaceId: identity.workspaceId ?? undefined });
    if (report.idle.length > 0) {
      notWoken = {
        idleRecipients: report.idle,
        note:
          `injected to ${report.idle.join(', ')} — no live session is watching their inbox, so this send does NOT ` +
          'wake them (seen on their next natural turn, if any). To hand off live work that must be picked up now, ' +
          "re-send with wake:'required' and verify pickup (woken / recipient_absent).",
      };
    }
  }

  return {
    ok: true,
    to: env.to,
    msg_id: env.msg_id,
    ts: env.ts,
    // P-001: whether this message rides a federation scope (harness-stamped ⇒ the
    // mig-150 capture gate federates it to the Hive's other machines). `false` =
    // machine-local only — never mistake it for cross-machine delivery.
    federated: Boolean(harnessSlug),
    ...(harnessSlug ? { federationScope: harnessSlug } : {}),
    // fleet-scoped-broadcast-default: report a '*'→@fleet auto-scope so the rewrite
    // is transparent + teaches the allHive override; flag a conscious hive-wide blast.
    ...(bcast?.scoped ? { scopedBroadcast: bcast.scoped } : {}),
    ...(bcast?.allHive ? { allHiveBroadcast: true } : {}),
    // P-008: await this key to confirm cross-machine delivery+wake (the
    // receiving machine emits it back as a fed event when the row applies).
    ...(wantReceipt ? { receiptEvent: `coord:receipt:${env.msg_id}` } : {}),
    ...(endTurn ? { endTurn } : {}),
    ...(wake ? { wake } : {}),
    ...(replyWake ? { replyWake } : {}),
    ...(notWoken ? { notWoken } : {}),
    // EI-6874: report how many live recipients an audience-selector send resolved
    // to (for EVERY audience send, not just the zero case), plus the loud
    // zero_recipients warning when an auto-scoped '*'→@fleet broadcast reached
    // nobody (an explicit selector reaching nobody already returned above).
    ...(audienceSelectors.length > 0 ? { recipients_resolved: env.to.length } : {}),
    ...(zeroRecipients ? { zero_recipients: zeroRecipients } : {}),
  };
}

/**
 * P-001 (cross-machine-coord-parity-and-trust-2026-07-01): the EFFECTIVE
 * federation scope for one message. Precedence:
 *   scope:'local'  → none (explicit machine-local, wins over everything);
 *   ctx harness    → the sender's own harness (pipeline roles — unchanged);
 *   scope:'hive'   → the workspace's single shared Hive, LOUD error when
 *                    none/ambiguous (never a silent local fallback);
 *   omitted        → auto: the single shared Hive when exactly one, else none.
 * Returns either the slug to stamp (undefined = stay local) or the per-message
 * error result.
 */
async function effectiveFederationScope(
  msgScope: 'hive' | 'local' | undefined,
  ctxHarness: string | undefined,
  workspaceId: string | null | undefined,
  to: string[],
): Promise<{ harnessSlug: string | null } | { error: BulkItemResult }> {
  // WI-3653: every "stay local" DECISION returns null (sendMessage's explicit
  // machine-local opt-out) — this layer has already resolved the scope, so the
  // write seam's own AUTO default (undefined → resolve) must not re-decide it.
  if (msgScope === 'local') return { harnessSlug: null };
  if (ctxHarness) return { harnessSlug: ctxHarness };
  if (!workspaceId || workspaceId === '*') {
    if (msgScope === 'hive') {
      return {
        error: {
          ok: false,
          to,
          error: 'no_hive_scope',
          message:
            "scope:'hive' needs a concrete workspace to resolve the shared Hive from, and this session has none — nothing was sent.",
        },
      };
    }
    return { harnessSlug: null };
  }
  const resolved = await resolveWorkspaceHiveScope(workspaceId);
  if (resolved.kind === 'one') return { harnessSlug: resolved.homeSlug };
  if (msgScope === 'hive') {
    return {
      error: {
        ok: false,
        to,
        error: resolved.kind === 'many' ? 'ambiguous_hive_scope' : 'no_hive_scope',
        message:
          resolved.kind === 'many'
            ? `scope:'hive' is ambiguous — this workspace has ${resolved.candidates.length} shared Hives; nothing was sent. There is no per-message hive picker yet: pick the right hive's home and re-send from a session scoped to it.`
            : "scope:'hive' found no shared Hive in this workspace (a hive federates only when published public/invite or joined) — nothing was sent. Publish the hive (discovery:set_pot) or drop scope:'hive' to send machine-local.",
        ...(resolved.kind === 'many' ? { candidates: resolved.candidates } : {}),
      },
    };
  }
  return { harnessSlug: null }; // auto: none/ambiguous → machine-local, decided HERE
}

export default defineTool({
  name: 'coord:send',
  description:
    'Send a message to other coordination agents — ONE message (single form) OR N distinct messages (items:[…]). `to` is ownerIds; ["*"] broadcasts, ["human"] surfaces to the user. In a fleet, a bare ["*"] auto-scopes to your fleet (reported `scopedBroadcast`); pass allHive:true for a genuine hive-wide notice. Default INJECTED — lands in the recipient\'s inbox, seen next turn. `wake` ALSO re-invokes a sleeping recipient now (\'required\' → a miss returns recipient_absent:true; \'optimistic\' → silent best-effort over a durable backstop). Single: { to, summary, body?, wake?, … }. Many distinct: items:[{ to, summary, … }]. A DIRECTED send defaults `wakeOnReply` — you\'re auto-woken when a peer replies (set false to opt out; broadcasts off). Returns { ok, results:[{ ok, to, msg_id? … | error }], counts } — correlate by `to`, not position; one failed message never fails the rest.',
  guidance: {
    when: 'Sharing context or asking a question. Use items:[…] for many distinct messages. wake:\'required\' = recipient must act now, miss → recipient_absent. wake:\'optimistic\' = best-effort over a named backstop (`backstop:`). A running recipient already sees the inject — a wake is wasted on it.',
    notWhen: 'Human reply: just speak. File lock: locks:acquire. Don\'t wake for ambient notes (inject is default; wake = billable). ONE msg to MANY: single `to:[…]` — `items` is many-distinct-messages. Work transfer: coord:handoff. Without a backstop, wake:\'optimistic\' miss is SILENT — use wake:\'required\' + confirm woken≥1.',
    seeAlso: [
      'coord:handoff (transfer WORK, not just a message)',
      'coord:inbox (read replies to what you sent)',
      'coord:roster { view:"live" } (confirm a recipient is awake before wake:required)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // EI-7838: this cross-field "need {to,summary} (or items)" check used to live in
  // a trailing `.refine()` on the object below. Zod only RUNS a `.refine()` /
  // `.superRefine()` after the base object schema parses EVERY field successfully —
  // when a SIBLING field (e.g. `wake`) ALSO fails its own type check (a stray
  // string "true" instead of boolean/enum, or any other bad value), zod short-
  // circuits and returns ONLY that field's issue; the refine never runs, so a
  // genuinely-missing `summary` goes unreported and the caller is misdirected
  // toward an unrelated field ("wake: Invalid input") instead of the real,
  // actionable problem. A `z.preprocess` wrapping the object runs BEFORE the
  // object's own per-field validation, so its `ctx.addIssue` fires independently
  // of whether `wake`/etc. later fail their own checks — this makes the
  // fundamental "you forgot to/summary" message win over a secondary field-shape
  // issue (confirmed via z.toJSONSchema: preprocess is transparent to schema
  // introspection, so the advertised tool schema is byte-identical either way).
  args: z.preprocess((data, pctx) => {
    const a = data as { items?: unknown[]; to?: unknown[]; summary?: unknown } | null | undefined;
    const hasItems = Array.isArray(a?.items) && a.items.length > 0;
    const hasSingle = Array.isArray(a?.to) && a.to.length > 0 && Boolean(a?.summary);
    if (!hasItems && !hasSingle) {
      pctx.addIssue({
        code: 'custom',
        message: 'pass { to, summary } for one message, or items:[{ to, summary }] for many distinct messages',
      });
    }
    return data;
  }, z.object({
    // Caller-DX (watchdog P-006): actionable validation messages — agents
    // repeatedly bounced off the bare "Required" / "Array must contain at least
    // 1 element(s)" zod default on these two required fields.
    to: toArg.optional(),
    summary: summaryArg.optional(),
    body: z.string().optional(),
    files: z.array(z.string()).optional(),
    plan_slug: z.string().optional(),
    related_msg_id: z.string().optional(),
    wake: wakeArg,
    wakeOnReply: wakeOnReplyArg,
    endTurn: endTurnArg,
    backstop: backstopArg,
    scope: scopeArg,
    allHive: allHiveArg,
    items: z
      .array(itemSpec)
      .min(1)
      .max(100)
      .optional()
      .describe('send many DISTINCT messages at once — each { to, summary, body?, files?, plan_slug?, related_msg_id?, wake?, wakeOnReply?, endTurn? }'),
  })),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // The sender's own harness when it's a real, harness-scoped agent (pipeline
    // roles carry ctx.harnessSlug); '*'/empty = SU/operator/oracle wildcard.
    // P-001: an un-scoped sender no longer silently stays local — in a workspace
    // with exactly one SHARED Hive its sends default to that Hive's home scope
    // (so they federate), resolved per message by effectiveFederationScope.
    const rawCtxHarness = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness =
      typeof rawCtxHarness === 'string' && rawCtxHarness && rawCtxHarness !== '*'
        ? rawCtxHarness
        : undefined;

    const list: SendMsg[] = args.items?.length
      ? args.items.map((it) => ({ ...it }))
      : [
          {
            to: args.to as string[],
            summary: args.summary as string,
            body: args.body,
            files: args.files,
            plan_slug: args.plan_slug,
            related_msg_id: args.related_msg_id,
            wake: args.wake,
            wakeOnReply: args.wakeOnReply,
            endTurn: args.endTurn,
            backstop: args.backstop,
            scope: args.scope,
            allHive: args.allHive,
          },
        ];
    // fleet-scoped-broadcast-default: resolve the sender's fleet ONCE (only when a
    // message actually broadcasts) so a fleeted agent's bare ['*'] is scoped to
    // @fleet:<slug> rather than every agent in the hive. Fail-soft: a presence-read
    // hiccup degrades to "no fleet" → today's literal '*' behavior.
    const anyWildcard = list.some((m) => m.to.includes('*'));
    let senderFleet: string | null = null;
    // P-003: a broadcast is a fleet-leader / Queen "status send" — resolve the
    // sender's structured authority+scope ONCE (only when something actually
    // broadcasts) so each `*`-broadcast cue is stamped with its provenance. null
    // for a caller with no recognized control authority (an ordinary bee/su).
    let senderCueAuthority: CueAuthorityStamp | null = null;
    if (anyWildcard) {
      try {
        // P-004 FIX: fleetSlug lives on the fleet-membership JOIN (coord_presence
        // via fetchPresenceFleet), NOT on PresenceRecord — the old
        // `getPresence(...).fleetSlug` read `undefined` every time, so a fleeted
        // sender's `['*']` was NEVER down-scoped and the whole scope-broadcast
        // default was a production no-op (a leader could broadcast a drain/pause
        // cue to every agent, incl. peer leaders outside its fleet). Resolve it
        // from the correct source so the down-scope to @fleet:<slug> actually fires.
        senderFleet = (await fetchPresenceFleet([identity.ownerId])).get(identity.ownerId)?.fleetSlug ?? null;
      } catch {
        senderFleet = null;
      }
      senderCueAuthority = await resolveSenderCueAuthority(identity);
    }

    const env = await runBulk(
      list,
      async (msg) => {
        // Capture the ORIGINAL broadcast intent BEFORE scopeBroadcastAudience
        // rewrites `*` → @fleet:<slug>: only a broadcast is stamped (P-003).
        const wasBroadcast = msg.to.includes('*');
        // Auto-scope the broadcast BEFORE resolve/persist, then thread the report
        // through so the rewrite (or conscious all-hive claim) shows on the result.
        const bcast = scopeBroadcastAudience({ to: msg.to, senderFleet, allHive: msg.allHive });
        msg.to = bcast.to;
        const scoped = await effectiveFederationScope(
          msg.scope,
          ctxHarness,
          identity.workspaceId,
          msg.to,
        );
        if ('error' in scoped) return scoped.error;
        return sendOne(
          msg,
          identity,
          scoped.harnessSlug,
          { scoped: bcast.scoped, allHive: bcast.allHive },
          wasBroadcast ? senderCueAuthority : null,
        );
      },
      {
        keyOf: (msg) => ({ to: msg.to }),
      },
    );
    return bulkContent(env);
  },
});
