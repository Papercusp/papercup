'use client';

/**
 * AgentDossier — the right-pane detail dossier for one selected agent (plan
 * adv-sessions-live-roster-2026-06-02, P-007). Renders the full Tier-1..3 set
 * for ANY agent in the roster, including presence-only shells with no
 * adv_sessions row:
 *
 *   Tier-1/2 (free) — comes from the already-loaded RosterEntry: intent, files,
 *     host/pid, role/feature/plan, mode + terminal handles, session age.
 *   Tier-3 (lazy) — fetched through agentDetail.byOwner on selection:
 *     SU locks held + waiting (with blockers)
 *     and coord state (last message, unread, open handoffs/escalations).
 *
 * The files list is cross-marked with the agent's own lock state (L = holds a
 * lock on it, W = waiting on it) so "what is this agent touching / contending"
 * reads at a glance.
 */

import { useCallback, useMemo } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { formatRelativeUpdated } from '@papercusp/operator-core/lib/format/relative-time';
import { LivenessDot } from '@/app/coord/presence-ui';
import { useLexicon } from '@/lib/useLexicon';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
import { contextPct } from '../hud/hud-board-model';
import type { NativeSessionHandle, RosterEntry } from './SessionsRosterView';
import { useAgentDetail, type AgentDetail } from './use-agent-detail';
// hud-first-nav-and-dossier-2026-07-26 P-004: the DTO + the `agentDetail.byOwner`
// fetch hook now live in use-agent-detail.ts so the chat footer's "N locks / M
// unread" summary chip can share the SAME useSyncQuery cache entry (no new
// query) — re-exported here for backward compat (AgentDossier.test.tsx and any
// other existing `import { type AgentDetail } from './AgentDossier'`).
export type { AgentDetail, AgentSignals } from './use-agent-detail';

function shortSource(s: string): string {
  const v = (s || '').toLowerCase();
  if (v.includes('claude')) return 'claude';
  if (v.includes('codex')) return 'codex';
  if (v.includes('omp')) return 'omp';
  return s || '—';
}

/** "19m left" / "<1m left" / "expired" from an ISO expiry. */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  return min < 1 ? '<1m left' : `${min}m left`;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element | null {
  if (value == null || value === '' || value === false) return null;
  return (
    <div className="pc-dossier__meta-row">
      <span className="pc-dossier__meta-key">{label}</span>
      <span className="pc-dossier__meta-val">{value}</span>
    </div>
  );
}

/** Sort key for the capped Files list: contended before held before quiet. */
function fileRank(mark: 'held' | 'waiting' | null): number {
  return mark === 'waiting' ? 0 : mark === 'held' ? 1 : 2;
}

/** Build MetaRows from label/value pairs, DROPPING the ones that would render
 *  nothing. MetaRow itself returns null for an empty value, so handing a capped
 *  list the unfiltered set would make it promise "Show 6 more" and then reveal
 *  six blank lines — the count has to mean rows you can actually see. */
function metaRows(pairs: Array<[string, React.ReactNode]>): React.ReactNode[] {
  return pairs
    .filter(([, v]) => v != null && v !== '' && v !== false)
    .map(([label, value]) => <MetaRow key={label} label={label} value={value} />);
}

/** Rail R1 (session-chat-popup-direction-d-2026-08-02 P-008): every section
 *  previews at most this many rows before it drills in. This is what makes the
 *  rail a fixed height BY CONSTRUCTION — no agent's state can grow a section
 *  past three rows, so no agent can make the rail 2,000px tall. */
const DOSSIER_ROW_CAP = 3;

/** How the expanded sub-list is bounded. Expanding must not re-create the very
 *  problem the cap solves, so an opened section scrolls WITHIN the rail rather
 *  than pushing it taller — the deck's R1 plate left "Open all 32 needs
 *  somewhere to go" as its one open cost, and expand-in-place is the answer. */
function railExpandKeys(raw: string | null): Set<string> {
  return new Set((raw ?? '').split(',').filter(Boolean));
}

/**
 * One capped section body: previews `DOSSIER_ROW_CAP` rows, then a drill-in
 * that expands IN PLACE to a scrolling sub-list.
 *
 * `totalCount` is the SERVER-side total when it exceeds what we were actually
 * sent. Expanding cannot conjure rows the operator never delivered, so the
 * expanded view states what it holds instead of implying it has all of them.
 * That distinction is the whole point here — [owner 2026-07-28, verbatim] "it
 * says in the COORD section 38 unread, but I only see 2 messages" was exactly
 * a count naming rows the section could not show. A cap re-introduces that
 * failure unless the drill-in genuinely reaches the rest and says so when it
 * cannot, which is why the cap and this control landed in the same change.
 */
function CappedRows({
  rows,
  totalCount,
  noun,
  open,
  onToggle,
  testId,
}: {
  rows: React.ReactNode[];
  totalCount?: number;
  noun: string;
  open: boolean;
  onToggle: () => void;
  testId?: string;
}): React.JSX.Element | null {
  const held = rows.length;
  if (held === 0) return null;
  const total = Math.max(totalCount ?? held, held);
  const overflows = held > DOSSIER_ROW_CAP || total > held;
  const visible = !overflows || open ? rows : rows.slice(0, DOSSIER_ROW_CAP);
  const hiddenLocally = held - DOSSIER_ROW_CAP;
  return (
    <>
      <div className="pc-dossier__capped" data-open={open ? '' : undefined} data-testid={testId}>
        {visible}
      </div>
      {overflows ? (
        <>
          <button
            type="button"
            className="pc-dossier__drillin"
            onClick={onToggle}
            aria-expanded={open}
          >
            {open
              ? 'Show fewer ‹'
              : total > held
                ? `Open all ${total} ${noun} ›`
                : `Show ${hiddenLocally} more ${noun} ›`}
          </button>
          {open && total > held ? (
            <div className="pc-dossier__empty-line">
              Showing the {held} most recent of {total}.
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** hud-first-nav-and-dossier-2026-07-26 P-005: risk bucket for the context bar's
 *  color, mirroring the ~80%/60% thresholds already used fleet-wide for
 *  "past this, self-compact" guidance — not a new scale invented for this bar. */
function contextRisk(pct: number): 'ok' | 'warn' | 'bad' {
  if (pct >= 80) return 'bad';
  if (pct >= 60) return 'warn';
  return 'ok';
}

const CHECKPOINT_DISPLAY_CAP = 220;

/** Cap a checkpoint note for the glance row — the full text is what the agent
 *  itself is re-injected with on its next wake; this is a pointer, not the
 *  authoritative copy. */
function truncateCheckpoint(text: string): string {
  if (text.length <= CHECKPOINT_DISPLAY_CAP) return text;
  return `${text.slice(0, CHECKPOINT_DISPLAY_CAP)}…`;
}

function nativeSessionCommand(handle: NativeSessionHandle): string | null {
  if (handle.backend === 'claude') {
    if (!handle.sessionId) return null;
    // EI-308: a bare `claude --resume <id>` looks in the DEFAULT
    // CLAUDE_CONFIG_DIR and finds nothing — the transcript lives under the
    // per-session dir (~/.papercusp/session-claude/<ownerId>), mirroring why
    // the codex branch below already prefixes CODEX_HOME. Without this, the
    // exact command this dossier hands the user to copy-paste would fail
    // with a confusing "no conversation found" error — the same class of
    // wrong-by-construction resume command this ticket exists to fix.
    if (handle.configDir) {
      return `CLAUDE_CONFIG_DIR=${shellSingleQuote(handle.configDir)} claude --resume ${handle.sessionId}`;
    }
    return `claude --resume ${handle.sessionId}`;
  }
  if (handle.backend === 'codex') {
    if (!handle.codexHome) return null;
    const prefix = `CODEX_HOME=${shellSingleQuote(handle.codexHome)}`;
    return handle.rolloutId
      ? `${prefix} codex exec resume ${handle.rolloutId}`
      : `${prefix} codex resume --last`;
  }
  return handle.ompThreadId ? `omp -r ${handle.ompThreadId} --approval-mode yolo` : null;
}

/** Runtime provenance for the agent's underlying CLI session. Rail R1 P-008 moved
 *  it below Reference and capped it — how to re-enter a session is reference
 *  material, and the ACTIONS for it (Resume / Fork) live in the popup's control
 *  strip, not here. */
function NativeSessionSection({
  nativeSession,
  open,
  onToggle,
}: {
  nativeSession: NativeSessionHandle;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <section className="pc-dossier__section" id="pc-dossier-native-session">
      <h4 className="pc-dossier__h">
        Native Session
        <span className="pc-dossier__badge-count">{nativeSession.backend}</span>
        {!nativeSession.exactResumeSupported && nativeSession.missingReason ? (
          <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {nativeSession.missingReason}</span>
        ) : null}
      </h4>
      <CappedRows
        noun="detail rows"
        open={open}
        onToggle={onToggle}
        testId="dossier-native-session-rows"
        rows={metaRows([
          // WI-5226: only offer a copy-pasteable command when exactResumeSupported —
          // the server verifies (and best-effort restores) the session's on-disk
          // transcript before setting this true, so a false here means the command
          // would ENOENT; the header's missingReason note already explains why.
          // It leads because it is the only ACTIONABLE row in the section.
          ['resume', nativeSession.exactResumeSupported ? nativeSessionCommand(nativeSession) : null],
          ['exact resume', nativeSession.exactResumeSupported ? 'supported' : 'not ready'],
          ['source', nativeSession.source],
          ...(nativeSession.backend === 'claude'
            ? ([['session', nativeSession.sessionId ?? 'not recorded']] as Array<[string, React.ReactNode]>)
            : []),
          ...(nativeSession.backend === 'codex'
            ? ([
                ['home', nativeSession.codexHome || 'not recorded'],
                ['rollout', nativeSession.rolloutId ?? 'not recorded yet'],
              ] as Array<[string, React.ReactNode]>)
            : []),
          ...(nativeSession.backend === 'omp'
            ? ([
                ['thread', nativeSession.ompThreadId ?? 'not linked yet'],
                ['agent home', nativeSession.agentHome],
              ] as Array<[string, React.ReactNode]>)
            : []),
        ])}
      />
    </section>
  );
}

/** Codex-specific runtime diagnostics — eleven rows, the single tallest block in
 *  the old rail, and pure reference. Capped like everything else (Rail R1 P-008). */
function CodexSection({
  codex,
  open,
  onToggle,
}: {
  codex: NonNullable<AgentDetail['codex']>;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <section className="pc-dossier__section" id="pc-dossier-codex">
      <h4 className="pc-dossier__h">
        Codex Runtime
        <span className="pc-dossier__badge-count">advanced</span>
        {codex.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {codex.error}</span> : null}
      </h4>
      <CappedRows
        noun="diagnostics"
        open={open}
        onToggle={onToggle}
        testId="dossier-codex-rows"
        rows={metaRows([
          ['resume', codex.resumeCommand],
          ['home', codex.codexHome],
          ['rollout', codex.latestRolloutId ?? 'not recorded yet'],
          ['AGENTS.md', codex.agentsExists ? codex.agentsPath : 'missing'],
          ['config.toml', codex.configExists ? codex.configPath : 'missing'],
          ['hooks', codex.hooksExists ? 'configured' : 'missing'],
          ['auth', codex.authExists ? 'linked' : 'missing'],
          ['prompts', codex.promptsExists ? 'available' : 'missing'],
          ['lock status', codex.diagnostics?.lockEnforcement ?? 'unknown'],
          ['PreToolUse', codex.diagnostics?.codexPreToolUseStatus ?? 'unknown'],
          ['manual locks', codex.diagnostics?.requiresExplicitPapercuspLocks ? 'required' : 'not required'],
        ])}
      />
    </section>
  );
}

export default function AgentDossier({
  ownerId,
  entry,
  onClose,
  startingUp = false,
  launchFailed = false,
}: {
  ownerId: string;
  entry: RosterEntry | null;
  onClose: () => void;
  /** WI-6367: this agent was launched moments ago and has not registered yet.
   *  A never-started session and a long-ended one both arrive here as
   *  `entry: null`, so without this the rail tells the owner their brand-new
   *  session is "no longer in the live roster". */
  startingUp?: boolean;
  /** WI-6821: the launch was OBSERVED to die (terminal gone, never registered).
   *  Without this the rail keeps saying "starting up" about a corpse — the same
   *  lie as the banner, in the surface right next to it. */
  launchFailed?: boolean;
}): React.JSX.Element {
  const lex = useLexicon();
  const { detail, error, loading } = useAgentDetail(ownerId);
  const locks = detail?.locks;
  const coord = detail?.coord;
  // Normalised ONCE, here, rather than at each use: an operator older than the
  // `unread` field serves a coord state without it (see the render note below).
  const unreadRows = coord?.unread ?? [];
  const codex = detail?.codex;
  const signals = detail?.signals;
  const subs = detail?.subscriptions;
  // Same normalise-once rationale as `unreadRows`: `subscriptions` is a NEW
  // field, so an operator predating it serves a detail payload without one.
  const subRows = subs?.items ?? [];
  const nativeSession = detail?.nativeSession ?? entry?.nativeSession ?? null;

  const ctxPct = signals ? contextPct(signals.contextTokens, signals.compactionLimit) : null;

  // Rail R1 P-008 — the Coord section's four stacked lists flattened into ONE,
  // in urgency order. With a three-row preview the ORDER is what decides whether
  // you see "a peer is escalating at this agent" or the tail of a chat log.
  const coordRows = useMemo((): React.ReactNode[] => {
    if (!coord) return [];
    return [
      ...coord.openEscalations.map((e) => (
        <div key={`esc:${e.msgId}`} className="pc-dossier__coord-line">
          <span className="pc-dossier__dir pc-dossier__dir--esc" data-sev={e.severity}>
            {e.severity}
          </span>
          <span className="pc-dossier__coord-text">{e.summary || '(escalation)'}</span>
          <span className="pc-dossier__coord-ts">{formatRelativeUpdated(e.ts)}</span>
        </div>
      )),
      ...coord.openHandoffs.map((h) => (
        <div key={`ho:${h.msgId}`} className="pc-dossier__coord-line">
          <span className="pc-dossier__dir" data-dir={h.direction}>
            {h.direction === 'outbound' ? 'handoff →' : 'handoff ←'}
          </span>
          <span className="pc-dossier__coord-text">{h.summary || '(handoff)'}</span>
          <span className="pc-dossier__coord-ts">{h.accepted ? 'accepted' : 'open'}</span>
        </div>
      )),
      ...(coord.lastMessage
        ? [
            <div key="last" className="pc-dossier__coord-line">
              <span className="pc-dossier__dir" data-dir={coord.lastMessage.direction}>
                {coord.lastMessage.direction === 'outbound' ? '→' : '←'}
              </span>
              <span className="pc-dossier__coord-text">{coord.lastMessage.summary || '(no summary)'}</span>
              <span className="pc-dossier__coord-ts">{formatRelativeUpdated(coord.lastMessage.ts)}</span>
            </div>,
          ]
        : []),
      ...unreadRows.map((m) => (
        <div key={`un:${m.msgId}`} className="pc-dossier__coord-line" data-testid="dossier-coord-unread-row">
          <span className="pc-dossier__dir" data-dir={m.direction}>
            {m.direction === 'outbound' ? '→' : '←'}
          </span>
          <span className="pc-dossier__coord-from">{m.from}</span>
          <span className="pc-dossier__coord-text">{m.summary || '(no summary)'}</span>
          <span className="pc-dossier__coord-ts">{formatRelativeUpdated(m.ts)}</span>
        </div>
      )),
    ];
  }, [coord, unreadRows]);

  /** Unread the operator COUNTED but did not send us. Expanding cannot reveal
   *  these, so CappedRows names the gap instead of pretending it closed it. */
  const coordUnsentCount = coord ? Math.max(0, coord.unreadCount - unreadRows.length) : 0;

  // Files this agent holds / waits on — to cross-mark the file list.
  const heldPaths = new Set(locks?.held.map((l) => l.path) ?? []);
  const waitPaths = new Set(locks?.waiting.flatMap((w) => w.paths) ?? []);
  const fileMark = (f: string): 'held' | 'waiting' | null =>
    heldPaths.has(f) ? 'held' : waitPaths.has(f) ? 'waiting' : null;

  const client = entry?.agent ?? shortSource(entry?.source ?? '');

  // Rail R1 P-008 — which capped sections are currently expanded, as ONE nuqs
  // scalar (a comma list of section keys) rather than five separate booleans.
  // Per the repo's nuqs rule this is user-meaningful state, so it belongs in the
  // URL where the agent→UI control surface (ui:get_state / ui:dispatch) can read
  // and drive it; `useState` would be invisible to that surface. A short scalar
  // rather than parseAsJson for the same reason the rule gives — keep the URL
  // readable.
  const [railOpenRaw, setRailOpenRaw] = useQueryState('railOpen', parseAsString);
  const railOpen = useMemo(() => railExpandKeys(railOpenRaw), [railOpenRaw]);
  const toggleRail = useCallback(
    (key: string) => {
      const next = railExpandKeys(railOpenRaw);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void setRailOpenRaw(next.size > 0 ? [...next].join(',') : null);
    },
    [railOpenRaw, setRailOpenRaw],
  );

  return (
    <aside className="pc-dossier" aria-label="Agent detail">
      <header className="pc-dossier__head">
        <div className="pc-dossier__head-main">
          {entry ? <LivenessDot liveness={entry.liveness} /> : null}
          <span className="pc-roster__badge" data-client={client}>
            {client || '—'}
          </span>
          {entry?.role ? <span className="pc-roster__chip">{agentRoleLabel(entry.role, lex)}</span> : null}
          {entry?.feature ? (
            <span className="pc-roster__chip pc-roster__chip--feature">{entry.feature}</span>
          ) : null}
          {entry?.revoked ? (
            <span className="pc-roster__chip pc-roster__chip--warn">revoked</span>
          ) : null}
        </div>
        <button type="button" className="pc-dossier__close" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </header>

      <div className="pc-dossier__id" title={ownerId}>
        {entry?.label ? agentDisplayLabel(entry.label, lex) : ownerId}
      </div>

      {entry ? (
        <div className="pc-dossier__intent">{entry.intent || '(no declared intent)'}</div>
      ) : launchFailed ? (
        <div className="pc-dossier__note">This session's launch failed — it never came online.</div>
      ) : startingUp ? (
        <div className="pc-dossier__note">Starting up — this agent hasn't registered yet.</div>
      ) : (
        <div className="pc-dossier__note">This agent is no longer in the live roster.</div>
      )}

      {/* Rail R1 P-008 — the ten Tier-1/2 reference rows used to sit HERE, above
          everything operational. They now live in the Reference section at the
          bottom, previewed three-at-a-time behind one drill-in: [deck R1]
          "Ten reference rows (host, pid, cwd, window, thread, user) collapse to
          one link. Nobody reads those while watching a conversation." The
          sections below are ordered by operational urgency instead of
          declaration order. */}

      {/* ── Health signals (hud-first-nav-and-dossier-2026-07-26 P-005):
          "is this agent healthy and will it keep going?", in priority order —
          loop, current claim, context pressure, last checkpoint, unanswered
          directed, last tool call. Each field is sourced from an existing
          roster/sync primitive; see adv-agent-detail.ts's AgentSignals doc. ── */}
      {entry ? (
        <section className="pc-dossier__section" id="pc-dossier-signals">
          <h4 className="pc-dossier__h">
            Health
            {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          </h4>
          <MetaRow
            label="loop"
            value={
              signals?.loop
                ? signals.loop.active
                  ? [
                      'armed',
                      signals.loop.intervalSec != null ? `every ${signals.loop.intervalSec}s` : null,
                      signals.loop.stalled
                        ? '⚠ stalled'
                        : signals.loop.nextFireAt
                          ? `next ${expiresIn(signals.loop.nextFireAt)}`
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'not armed'
                : // EI-18694403367371331: a THROWN read must read distinctly from a
                  // genuine "never armed" — "no loop" invites a leader to (wrongly)
                  // treat this agent as idle instead of re-checking.
                  signals?.unavailableSignals.includes('loop')
                  ? '⚠ unavailable (read failed)'
                  : detail
                    ? 'no loop'
                    : null
            }
          />
          <MetaRow
            label="claim"
            value={
              signals?.currentClaim
                ? `${signals.currentClaim.id}${signals.currentClaim.title ? ` — ${signals.currentClaim.title}` : ''}`
                : // EI-18694403367371331: the bug this fixed — a live agent holding a
                  // real work-item rendered "none held" because the read threw, not
                  // because it genuinely held nothing.
                  signals?.unavailableSignals.includes('currentClaim')
                  ? '⚠ unavailable (read failed)'
                  : detail
                    ? 'none held'
                    : null
            }
          />
          {ctxPct != null ? (
            <div className="pc-dossier__meta-row">
              <span className="pc-dossier__meta-key">context</span>
              <span className="pc-dossier__meta-val pc-dossier__ctxbar-row">
                <span className="pc-dossier__ctxbar">
                  <span
                    className="pc-dossier__ctxbar-fill"
                    data-risk={contextRisk(ctxPct)}
                    style={{ width: `${ctxPct}%` }}
                  />
                </span>
                <span className="pc-dossier__ctxbar-pct">
                  {signals?.contextTokens?.toLocaleString()} / {signals?.compactionLimit?.toLocaleString()} ·{' '}
                  {ctxPct}%
                </span>
              </span>
            </div>
          ) : null}
          {signals?.lastCheckpoint ? (
            <div className="pc-dossier__meta-row">
              <span className="pc-dossier__meta-key">checkpoint</span>
              <span className="pc-dossier__meta-val">
                <div className="pc-dossier__checkpoint">{truncateCheckpoint(signals.lastCheckpoint.text)}</div>
                {signals.lastCheckpoint.updatedAtMs != null ? (
                  <span className="pc-dossier__ctxbar-pct">
                    {formatRelativeUpdated(signals.lastCheckpoint.updatedAtMs)}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}
          <MetaRow
            label="unanswered"
            value={
              signals && signals.unansweredDirectedCount > 0
                ? `${signals.unansweredDirectedCount} peer${signals.unansweredDirectedCount === 1 ? '' : 's'} waiting on a reply`
                : null
            }
          />
          <MetaRow
            label="last tool call"
            value={signals?.lastToolCallAt ? formatRelativeUpdated(signals.lastToolCallAt) : null}
          />
        </section>
      ) : null}

      {/* ── Waiting on ── */}
      {/* [owner 2026-07-28, verbatim] "are the events an agent currently
          subscribed to listed in their chat popup? If not add that". They were
          not. The rail showed what the agent HELD (locks) and what it had SAID
          (coord), but never what it was WAITING FOR — and an agent parked on an
          await is indistinguishable from a dead one until you can see the await.

          Rail R1 P-008 promotes it from LAST to second, and renames the heading
          to what it answers: [deck R1] "Waiting on is promoted to second — it is
          the answer to 'is this thing stuck or just parked?'", and the section
          intro, "Events (what the agent is waiting on) is never buried behind a
          message list". The owner's ask was that the subscriptions be listed;
          they still are, under a heading that says why you'd look.

          `subs?.items ?? []` is the wire contract, not defensive noise, for
          exactly the reason the coord `unread` list documents below: this is a
          NEW field, the SPA rebuilds on the vite hot path while the sidecar only
          rebuilds on restart, so a fresh bundle can genuinely be served a
          `subscriptions`-less payload. Reading `.length` off it there would take
          down the whole HUD tab over one optional list. */}
      <section className="pc-dossier__section" id="pc-dossier-events">
        <h4 className="pc-dossier__h">
          Waiting on
          {subs && subs.count > 0 ? (
            <span className="pc-dossier__badge-count">{subs.count} subscribed</span>
          ) : null}
          {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          {subs?.error ? (
            <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {subs.error}</span>
          ) : null}
        </h4>
        {subRows.length > 0 ? (
          <CappedRows
            noun="events"
            open={railOpen.has('events')}
            onToggle={() => toggleRail('events')}
            testId="dossier-events-list"
            rows={subRows.map((s) => (
              <div
                key={`${s.eventKey}:${s.createdAt}`}
                className="pc-dossier__coord-line"
                data-testid="dossier-events-row"
              >
                {/* A standing watch keeps waking the agent; a one-shot fires
                    once and is consumed. Opposite implications for "will this
                    agent wake again", so the distinction is shown, not implied. */}
                <span className="pc-dossier__dir" title={s.once ? 'one-shot await' : 'standing watch'}>
                  {s.once ? '◉' : '↻'}
                </span>
                <span className="pc-dossier__coord-text">
                  {s.eventKey}
                  {s.note ? <span className="pc-dossier__h-note"> · {s.note}</span> : null}
                  {!s.wakes ? <span className="pc-dossier__h-note"> · no wake</span> : null}
                  {s.urgent ? <span className="pc-dossier__h-note"> · urgent</span> : null}
                </span>
                <span className="pc-dossier__coord-ts">{formatRelativeUpdated(s.createdAt)}</span>
              </div>
            ))}
          />
        ) : (
          <div className="pc-dossier__empty-line">
            {subs?.error ? `Couldn’t load subscriptions: ${subs.error}` : 'Not waiting on any event.'}
          </div>
        )}
      </section>

      {/* Rail R1 P-008 — Native Session + Codex Runtime moved to the BOTTOM, below
          Reference. Both are runtime provenance, not "is this agent stuck", and
          between them they were 16 rows sitting above Locks and Coord. */}

      {/* ── Locks ── */}
      {/* hud-first-nav-and-dossier-2026-07-26 P-004: id is the scroll target
          for the footer's "⚠ N locks / M unread" summary chip (D-002's one
          deliberate duplicate) — clicking it opens this rail + scrolls here. */}
      <section className="pc-dossier__section" id="pc-dossier-locks">
        <h4 className="pc-dossier__h">
          Locks
          {locks && locks.held.length + locks.waiting.length > 0 ? (
            <span className="pc-dossier__badge-count">{locks.held.length + locks.waiting.length}</span>
          ) : null}
          {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          {locks?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {locks.error}</span> : null}
        </h4>
        {locks && (locks.held.length > 0 || locks.waiting.length > 0) ? (
          <CappedRows
            noun="locks"
            open={railOpen.has('locks')}
            onToggle={() => toggleRail('locks')}
            testId="dossier-locks-list"
            rows={[
              // Waiting rows lead: a lock you are BLOCKED on is the one that
              // explains a stalled agent, and with a 3-row cap whichever kind
              // comes first is the kind you see. Held locks are the calm case.
              ...locks.waiting.map((w) => (
                <div key={w.ticketId} className="pc-dossier__lock">
                  <span className="pc-dossier__lockmark pc-dossier__lockmark--wait">W</span>
                  <span className="pc-dossier__file-path">{w.paths.join(', ')}</span>
                  <span className="pc-dossier__lock-exp">
                    {w.aheadCount === 0 ? 'next' : `${w.aheadCount} ahead`}
                  </span>
                  {w.blockedBy.length > 0 ? (
                    <span className="pc-dossier__lock-intent">
                      blocked by {w.blockedBy.map((b) => b.holderLabel || b.holder).join(', ')}
                    </span>
                  ) : null}
                </div>
              )),
              ...locks.held.map((l) => (
                <div key={l.path} className="pc-dossier__lock">
                  <span className="pc-dossier__lockmark pc-dossier__lockmark--held">L</span>
                  <span className="pc-dossier__file-path">{l.path}</span>
                  <span className="pc-dossier__lock-exp">{expiresIn(l.expiresAt)}</span>
                  {l.intent ? <span className="pc-dossier__lock-intent">{l.intent}</span> : null}
                </div>
              )),
            ]}
          />
        ) : (
          <div className="pc-dossier__empty-line">{detail ? 'No locks held or waiting.' : '—'}</div>
        )}
      </section>

      {/* ── Coord ── */}
      {/* hud-first-nav-and-dossier-2026-07-26 P-004: scroll target for the
          footer's summary chip, same rationale as #pc-dossier-locks above. */}
      <section className="pc-dossier__section" id="pc-dossier-coord">
        <h4 className="pc-dossier__h">
          Coord
          {coord && coord.unreadCount > 0 ? (
            <span className="pc-dossier__badge-count">{coord.unreadCount} unread</span>
          ) : null}
          {coord?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {coord.error}</span> : null}
        </h4>
        {coord ? (
          coordRows.length > 0 ? (
            /* Rail R1 P-008: ONE capped list rather than four stacked ones, in
               urgency order — escalations, open handoffs, the latest message,
               then the unread backlog. With a 3-row preview the ORDER decides
               what you see, so the rows that mean "someone needs something from
               this agent" have to come first.

               `totalCount` is what makes the cap safe here. The operator sends a
               BOUNDED slice of unread while `unreadCount` is the true total, so
               the drill-in says "Showing the N most recent of M" rather than
               implying it reached them all. That distinction is the whole reason
               this list exists: [owner 2026-07-28] "it says in the COORD section
               38 unread, but I only see 2 messages" was a count naming rows the
               section could not show, and a cap re-creates that bug exactly
               unless the control both expands AND stays honest about the gap.

               (`unread` itself is read as `?? []` where it is derived, and that
               is the wire contract rather than defensive noise: it is a NEW
               field, the SPA rebuilds on the vite hot path while the sidecar
               only rebuilds on restart, so a fresh bundle can genuinely be
               served a `subscriptions`/`unread`-less payload. Reading `.length`
               off it threw "undefined is not an object" and took down the WHOLE
               hud tab — an error boundary away from the entire surface, over one
               optional list.) */
            <CappedRows
              noun="messages"
              open={railOpen.has('coord')}
              onToggle={() => toggleRail('coord')}
              testId="dossier-coord-list"
              totalCount={coordRows.length + coordUnsentCount}
              rows={coordRows}
            />
          ) : (
            <div className="pc-dossier__empty-line">No recent messages.</div>
          )
        ) : (
          <div className="pc-dossier__empty-line">{error ? `Couldn’t load coord: ${error}` : '—'}</div>
        )}
      </section>

      {/* ── Files in play (cross-marked with this agent's lock state) ── */}
      {entry && entry.currentFiles.length > 0 ? (
        <section className="pc-dossier__section" id="pc-dossier-files">
          <h4 className="pc-dossier__h">
            Files
            <span className="pc-dossier__badge-count">{entry.currentFiles.length}</span>
          </h4>
          <CappedRows
            noun="files"
            open={railOpen.has('files')}
            onToggle={() => toggleRail('files')}
            testId="dossier-files-list"
            rows={entry.currentFiles
              // Contended files first: with a 3-row preview, "which file is this
              // agent BLOCKED on" must survive the cap. Held next, then quiet.
              .slice()
              .sort((a, b) => fileRank(fileMark(a)) - fileRank(fileMark(b)))
              .map((f) => {
                const mark = fileMark(f);
                return (
                  <div key={f} className="pc-dossier__file" title={f}>
                    <span className="pc-dossier__file-path">{f}</span>
                    {mark === 'held' ? (
                      <span className="pc-dossier__lockmark pc-dossier__lockmark--held">L</span>
                    ) : null}
                    {mark === 'waiting' ? (
                      <span className="pc-dossier__lockmark pc-dossier__lockmark--wait">W</span>
                    ) : null}
                  </div>
                );
              })}
          />
        </section>
      ) : null}

      {/* ── Reference (Rail R1 P-008) ──
          The ten Tier-1/2 rows that used to head the rail. Three previewed,
          the rest one click away: [deck R1] "Nobody reads those while watching
          a conversation." */}
      {entry ? (
        <section className="pc-dossier__section" id="pc-dossier-reference">
          <h4 className="pc-dossier__h">Reference</h4>
          <CappedRows
            noun="detail rows"
            open={railOpen.has('reference')}
            onToggle={() => toggleRail('reference')}
            testId="dossier-reference-rows"
            rows={metaRows([
              // The three the deck previews, in its order — the operational
              // subset of the reference set.
              ['plan', entry.currentPlanSlug],
              ['started', formatRelativeUpdated(entry.startedAt)],
              ['host · pid', [entry.host, entry.pid != null ? String(entry.pid) : null].filter(Boolean).join(' · ')],
              // …and the rest, one click away.
              ['liveness', `${entry.liveness} · active ${formatRelativeUpdated(entry.heartbeatAt)}`],
              ['mode', entry.mode],
              ['cwd', entry.cwd],
              ['window', entry.windowId],
              ['omp thread', entry.ompThreadId],
              ['user', entry.userId],
            ])}
          />
        </section>
      ) : null}

      {nativeSession ? (
        <NativeSessionSection
          nativeSession={nativeSession}
          open={railOpen.has('native')}
          onToggle={() => toggleRail('native')}
        />
      ) : null}

      {codex ? (
        <CodexSection codex={codex} open={railOpen.has('codex')} onToggle={() => toggleRail('codex')} />
      ) : null}
    </aside>
  );
}
