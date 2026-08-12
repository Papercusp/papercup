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
 *
 * RAIL R1 (session-chat-popup-direction-d-2026-08-02 P-008, the owner's own pick
 * over the authoring agent's B+R2 recommendation) reshaped the layout:
 *
 *   - Every section previews at most DOSSIER_ROW_CAP rows, then drills in. The
 *     rail is a fixed height BY CONSTRUCTION — previously one agent holding 32
 *     locks made it ~2,000px tall, and it was 2.3 screens even when calm.
 *   - Sections are ordered by OPERATIONAL URGENCY, not declaration order:
 *     Health, Waiting on, Locks, Coord, Dynamically pushed context, Files, then
 *     reference material. "Waiting on" is second because it answers "is this
 *     thing stuck or just parked?", and it is never again buried below a message
 *     list. "Dynamically pushed context" sits directly under Coord [owner
 *     2026-08-03, context-injection-…-2026-08-03 P-011] because the two answer
 *     the same question one layer apart: Coord is what other AGENTS sent this
 *     one, that is what the SYSTEM pushed into it unasked.
 *   - The ten Tier-1/2 reference rows (host, pid, cwd, window, thread, user)
 *     collapsed into one Reference section previewing three.
 *   - The drill-in expands IN PLACE to a scrolling sub-list. That is the answer
 *     to the deck's one open R1 cost ("Open all 32 needs somewhere to go"): no
 *     separate destination surface, and expanding cannot re-grow the rail.
 */

import { useCallback, useMemo } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import {
  formatAbsoluteUpdated,
  formatRelativeUpdated,
  formatIdleAge,
} from '@papercusp/operator-core/lib/format/relative-time';
import { LivenessDot } from '@/app/coord/presence-ui';
import { useLexicon } from '@/lib/useLexicon';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
import { contextPct } from '../hud/hud-board-model';
import type { NativeSessionHandle, RosterEntry } from './SessionsRosterView';
import {
  useAgentDetail,
  type AgentDetail,
  type PushedContextRef,
  type PushedContextEvent,
  type PushedContextLegDetail,
} from './use-agent-detail';
import { RailCluster, RailQuiet, RailSectionHead, useRailCollapse } from './rail-sections';
import { HoverDetail } from '@/app/harness/HoverDetail';
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

/**
 * Render one retrieval leg's did-it-run state for the pushed-context rows.
 *
 * THREE glyphs for THREE states, deliberately — `null` means the row never
 * recorded the leg (a pre-P-002 injection), which is our blind spot, while
 * `false` means the leg was recorded and did NOT execute (the cosine-gated
 * short-circuit), which is a finding about retrieval health. Rendering the
 * unmeasured case as `✗` would report a degradation that was never observed;
 * that inversion is exactly what this section is supposed to expose.
 */
function legMark(label: string, ran: boolean | null): string {
  return `${label} ${ran === true ? '✓' : ran === false ? '✗' : '?'}`;
}

/**
 * A surfaced handle, shortened to fit the rail — with a VISIBLE ellipsis, so a
 * shortened value can never be mistaken for the handle itself. Corpus refs
 * (`WI-6512`) are already short and pass through untouched; mem0 refs are
 * 36-char uuids. The full value always rides in the hover panel's header, so
 * the shortening costs display only, never the lookup.
 */
function shortRef(ref: string): string {
  return ref.length > 12 ? `${ref.slice(0, 8)}…` : ref;
}

/**
 * What a pushed-context row SAYS: the resolved title, or the raw handle when
 * there is none.
 *
 * The fallback is the HANDLE and not a placeholder like "(untitled)", because
 * an unresolvable pointer is still the only identifier the operator has — the
 * row must stay actionable when the lookup could not help. It is prefixed
 * `mem`/`ptr` only in that fallback, where the kind is the only thing left to
 * say about it; a resolved title speaks for itself and the kind is in the panel
 * header.
 */
function pushedRefLabel(r: PushedContextRef): string {
  if (r.title) return r.title;
  return `${r.kind === 'memory' ? 'mem' : 'ptr'} ${shortRef(r.ref)}`;
}

/**
 * The hover panel's body.
 *
 * The two failure states get DIFFERENT prose, not one shrug, for the same
 * reason `legMark` above has three glyphs: `unresolved` is a finding about the
 * pointer (the agent was handed a handle to something that is no longer there),
 * while `unavailable` is a gap in our own read and says nothing about the row.
 * Collapsing them would report our outage as the system's data loss.
 */
function pushedRefDetail(r: PushedContextRef): string {
  if (r.detail) return r.detail;
  const noun = r.kind === 'memory' ? 'memory' : 'pointer';
  if (r.titleState === 'unresolved') {
    return `${r.ref}\n\nNo ${noun} row found for this handle. It was surfaced to the agent, so it existed then — it has most likely been deleted or superseded since.`;
  }
  if (r.titleState === 'unavailable') {
    return `${r.ref}\n\nThe title lookup failed, so this says nothing about whether the ${noun} still exists. The handle above is unaffected.`;
  }
  return r.ref;
}

/**
 * Utilization at or above this fraction of the cap reads as "the budget was
 * genuinely exhausted".
 *
 * A RENDERING threshold chosen here, not a system constant: recall-stats.ts
 * describes the distinction as continuous ("spent ≈ budgetChars" vs "spent ≪
 * budgetChars") and names no number. The panel therefore always prints both raw
 * numbers beside the label, so a reader can judge a borderline row themselves
 * rather than inheriting this cutoff as if it were measured.
 */
const BUDGET_BOUND_FRACTION = 0.9;

/** One leg's line: whether it ran, then whatever the row actually recorded. */
function legPhrase(ran: boolean | null, leg?: PushedContextLegDetail): string {
  const head =
    ran === true ? 'ran' : ran === false ? 'did NOT run (short-circuited)' : 'not recorded';
  const bits: string[] = [];
  if (leg?.candidates !== undefined) bits.push(`${leg.candidates} candidates`);
  if (leg?.qualifying !== undefined) bits.push(`${leg.qualifying} qualifying`);
  if (leg?.depth !== undefined) bits.push(`depth ${leg.depth}`);
  return bits.length > 0 ? `${head} — ${bits.join(', ')}` : head;
}

/**
 * The injection row's hover panel: what "1 of 12 admitted · truncated · sem ✓
 * lex ✓" actually MEANS.
 *
 * [owner 2026-08-09] asked for the refs rows' tooltips "in the same way" on
 * these rows. The bar is higher here than for a ref, because a ref row hides
 * only an id while this row hides a six-stage funnel behind four glyphs: the
 * panel must EXPLAIN rather than restate, so every number it prints is either
 * given a plain-words reason or left out.
 *
 * ⚠ TWO ZEROS HERE ARE THE SPECIFICATION, NOT A DEFECT, and both have already
 * been filed as bugs once (D-074, and the D-063/D-073/D-076 family). A panel
 * that renders them as bare numbers invites the same misreading a third time,
 * so each carries its design intent inline:
 *   - `lexicalOnly: 0` is STRUCTURAL on the push path — `cosine-gated` fusion
 *     seeds the candidate set only from cosine hits.
 *   - the lexical leg's `qualifying: 0` is INTENDED on a prose query — the
 *     lexical score is normalized by query-token count, so the leg is for
 *     exact-identifier recall and "should contribute nothing rather than decide
 *     the outcome" (recall-admission.ts).
 * Neither is evidence the lexical arm is broken, and this panel must not imply
 * it is.
 */
export function pushedEventDetail(e: PushedContextEvent): string {
  const d = e.detail;
  const out: string[] = [];

  out.push(`${e.returned} returned by the index · ${e.admitted} reached the agent.`);

  if (d?.dropped && d.dropped.length > 0) {
    out.push('', 'Dropped before delivery:');
    for (const s of d.dropped) out.push(`  ${s.count} — ${s.why}`);
  }

  const spent = d?.spent;
  const cap = d?.budgetChars;
  if (spent !== undefined || cap !== undefined) {
    out.push('');
    if (spent !== undefined && cap !== undefined) {
      out.push(`Budget: ${spent} chars spent against a ${cap}-char cap.`);
      if (spent > cap) {
        // The third reading in recall-stats.ts's `spent` doc — and the one that
        // explains an admitted count of exactly 1.
        out.push(
          'Over the cap because the always-emit-one-row rule admits a single oversized entry whatever its length, so the budget never applied to this recall.',
        );
      } else if (e.truncated && spent >= cap * BUDGET_BOUND_FRACTION) {
        out.push('Budget-bound: the cap was genuinely exhausted, so a larger cap would deliver more.');
      } else if (e.truncated) {
        out.push(
          'Clamp-bound: the cap was NOT exhausted — each remaining entry was individually too large for the space left, so the lever is the per-entry clamp, not the budget.',
        );
      }
    } else if (spent !== undefined) {
      out.push(`Budget: ${spent} chars spent (the cap was not recorded on this row).`);
    } else {
      out.push(`Budget: a ${cap}-char cap (the spend was not recorded on this row).`);
    }
    out.push(
      'Caps are per-port and deliberately tight (mid-turn runs ~350 against a 16,000 default), so a low admit rate here is usually the design working.',
    );
  } else if (e.truncated) {
    out.push(
      '',
      'Truncated: the char budget cut the tail off an already-ranked list. Neither the spend nor the cap was recorded on this row, so which of the two was binding cannot be told from here.',
    );
  }

  out.push('', 'Retrieval legs:');
  if (d?.mode) out.push(`  mode ${d.mode}${d.fused !== undefined ? ` · ${d.fused} fused` : ''}`);
  else if (d?.fused !== undefined) out.push(`  ${d.fused} fused`);
  out.push(`  semantic (cosine): ${legPhrase(e.semanticRan, d?.cosine)}`);
  out.push(`  lexical: ${legPhrase(e.lexicalRan, d?.lexical)}`);

  if (e.semanticRan === null || e.lexicalRan === null) {
    out.push(
      '"Not recorded" is not "did not run": this row predates per-leg provenance, so retrieval health was never measured here.',
    );
  }
  if (e.semanticRan === false || e.lexicalRan === false) {
    out.push(
      '"Did not run" is a recorded observation: cosine-gated fusion deliberately never starts the lexical leg when the cosine leg comes back empty.',
    );
  }
  if (e.lexicalRan === true && d?.lexical?.qualifying === 0 && (d.lexical.candidates ?? 0) > 0) {
    out.push(
      `The lexical leg supplied ${d.lexical.candidates} candidates and qualified none, so its ✓ does not mean it contributed. That is the intended shape on a prose query — the leg is scored for exact-identifier recall and should contribute nothing rather than decide the outcome. Not a defect.`,
    );
  }

  if (d?.byLeg) {
    out.push(
      '',
      `Admitted by leg: ${d.byLeg.cosineOnly} cosine-only · ${d.byLeg.both} both · ${d.byLeg.lexicalOnly} lexical-only.`,
    );
    if (d.byLeg.lexicalOnly === 0) {
      out.push(
        'Lexical-only is structurally zero on this path: cosine-gated fusion seeds candidates only from cosine hits. Moving it off zero means reverting to floored-union, which is the defect D-010 fixed.',
      );
    }
  }

  return out.join('\n');
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
  sessionEnded = false,
  sessionEndedAt = null,
  unknownSession = false,
  zoneTitle = false,
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
  /** The owner is known from session history, but its session is terminal. */
  sessionEnded?: boolean;
  /** The server-observed terminal timestamp, when the roster supplied one. */
  sessionEndedAt?: string | null;
  /** The roster and session-history reads completed without finding this id. */
  unknownSession?: boolean;
  /** Renders the rail's ZONE title bar — "Activity — what they're doing" — the
   *  vertical half of the Framed vocabulary [owner-approved 2026-08-02, artifact
   *  6379bb65]. A PROP rather than always-on, because this component has two
   *  homes: inside the session popup it is one of six named zones and needs its
   *  name; in the /adv two-pane it is the detail pane of a board that already
   *  says what it is, where a second title bar is noise. */
  zoneTitle?: boolean;
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
  const pushed = detail?.pushedContext;
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

  /** R1+ P-009 leg (b): gates declared in this agent's scopes that it is NOT
   *  listening for. The server already flagged each one (exact-key match), so
   *  this is a partition, not a re-derivation. `?? []` for the same wire reason
   *  the subscriptions list documents: a fresh SPA bundle can be served by an
   *  older sidecar that has never heard of this field. */
  const availableGates = useMemo(
    () => (signals?.announcedGates ?? []).filter((g) => !g.awaited),
    [signals],
  );

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
  /* A DIFFERENT axis from `railOpen` above, and deliberately a separate param:
     that one expands a capped LIST inside a section ("show all 12 locks"), this
     one folds the whole SECTION away [owner 2026-08-02: "make sure the sections
     that get big have a good way to collapse and expand them"]. Shared with the
     Orders rail — see rail-sections.tsx. */
  const rail = useRailCollapse();
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
      {/* The mirror of the Orders rail's title bar on the opposite edge, so the
          two columns read as a pair: told on the left, doing on the right. */}
      {zoneTitle ? (
        <header className="pc-zone-title" data-testid="dossier-zone-title">
          <span>Activity</span>
          {/* "they", not "it" — the same voice the Orders rail uses [owner
              2026-08-02]. */}
          <span className="pc-zone-title__sub">— what they’re doing</span>
        </header>
      ) : null}
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
      ) : sessionEnded ? (
        <div className="pc-dossier__note" data-testid="dossier-session-ended">
          This session ended{sessionEndedAt ? ` at ${formatAbsoluteUpdated(sessionEndedAt)}` : ''}. Resume or relaunch is available below.
        </div>
      ) : unknownSession ? (
        <div className="pc-dossier__note" data-testid="dossier-unknown-session">
          No agent with this id was found in the current roster or session history.
        </div>
      ) : (
        <div className="pc-dossier__note">This agent is no longer in the live roster.</div>
      )}

      {/* ── Fleet wind-down banner (R1+ P-009 leg d) ──────────────────────────
          TOP of the rail, above everything — because it reframes every signal
          below it. An agent in a winding-down fleet that is claiming nothing and
          looks idle is not broken; it is being REFUSED work by the scheduler,
          and without this line the reader diagnoses a healthy agent as stuck.

          It renders ONLY when the fleet is not plain 'active' (the server sends
          null otherwise), so its mere presence is the news — there is no
          "fleet: active" row to learn to ignore. */}
      {signals?.fleetControl ? (
        <div className="pc-dossier__windown" data-testid="dossier-fleet-control" role="status">
          <span className="pc-dossier__windown-state">
            {signals.fleetControl.fleet} · {signals.fleetControl.state}
          </span>
          {signals.fleetControl.reason ? (
            <span className="pc-dossier__windown-reason">{signals.fleetControl.reason}</span>
          ) : null}
          <span className="pc-dossier__h-note">
            {signals.fleetControl.by ? `by ${signals.fleetControl.by}` : null}
            {signals.fleetControl.by && signals.fleetControl.since != null ? ' · ' : null}
            {signals.fleetControl.since != null
              ? formatRelativeUpdated(signals.fleetControl.since)
              : null}
          </span>
        </div>
      ) : null}

      {/* Two clusters, mirroring the Orders rail (P-005 / Treatment C3). "Right
          now" is the agent's live posture; "Inbound" is what has arrived FOR it
          and is the only part of this rail another party controls — which is
          exactly why it earns its own group rather than sitting as a seventh
          peer card. Popup-only (`zoneTitle`), for the same reason P-008's type
          lift was: the /adv two-pane is a different density context and was not
          part of this ask. */}
      {zoneTitle ? <RailCluster label="Right now" /> : null}

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
        <section
          className="pc-dossier__section"
          id="pc-dossier-signals"
          data-collapsed={rail.closed('a-signals') ? 'true' : 'false'}
        >
          <RailSectionHead
            sectionId="a-signals"
            label="Health"
            className="pc-dossier__h"
            closed={rail.closed('a-signals')}
            onToggle={() => rail.toggle('a-signals')}
          >
            {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          </RailSectionHead>
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
          {/* R1+ P-009 leg (c): the claim id NEVER renders alone any more. Held
              looks identical whether it was taken 30 seconds or two hours ago,
              and "held" reads as "being worked on" — the wrong conclusion for
              the reader who matters here, a leader deciding whether to reclaim.
              The verdict rides on the SAME row, not a separate one, so it cannot
              be read apart from the id it qualifies. */}
          <MetaRow
            label="claim"
            value={
              signals?.currentClaim
                ? (() => {
                    const c = signals.currentClaim;
                    return (
                      <span data-testid="dossier-claim-row">
                        {c.id}
                        {c.title ? ` — ${c.title}` : ''}
                        <span
                          className="pc-dossier__claim-health"
                          data-progress={c.progress}
                          data-testid="dossier-claim-progress"
                        >
                          {' · '}
                          {c.progress === 'stalled' && c.idleSec != null
                            ? `stalled ${formatIdleAge(c.idleSec)}`
                            : c.progress === 'unknown'
                              ? // Not an accusation the data supports — say so.
                                'activity unknown'
                              : c.progress}
                        </span>
                      </span>
                    );
                  })()
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

      {/* ── Lane (R1+ P-009 leg a) ────────────────────────────────────────────
          Sits directly under Health, above Waiting on, because it is what makes
          everything below it interpretable: the rail could already say WHAT an
          agent holds but never what it is FOR, and a claim id divorced from its
          plan's `## Now` is unreadable to anyone who did not write the plan.

          `claimable` is deliberately shown even at 0 — "this plan is alive but
          has nothing pickable" is a real, distinct state that a lone "next up"
          row cannot express (it would simply be absent, which reads as no data). */}
      {/* Gated on `entry` (the roster row), NOT on `signals.lane` — i.e. present
          for every agent the rail can describe at all, exactly like Health above.
          It used to render only when a lane EXISTED, which meant an agent with no
          declared plan got no section at all. An absent section cannot say "this
          agent is not on a plan"; it reads as "this popup has no such feature",
          and that is precisely what it was read as: [owner 2026-08-02 23:28Z]
          "if the agent is working on a plan I dont see a place in the popup to
          show that. add that to the right side bar." — filed SIX HOURS
          after this very section shipped (plan D-006). The section's own comment
          below already makes this argument one level down, for `claimable` at 0
          ("it would simply be absent, which reads as no data"); the same argument
          simply had not been applied to the section itself. */}
      {entry ? (
        <section
          className="pc-dossier__section"
          id="pc-dossier-lane"
          data-collapsed={rail.closed('a-lane') ? 'true' : 'false'}
        >
          {/* "Plan", not "Lane": the owner's own word for the thing they came
              here to find, and the row this section leads with. `sectionId`
              stays `a-lane` so anyone's persisted collapse state survives the
              rename. */}
          <RailSectionHead
            sectionId="a-lane"
            label="Plan"
            className="pc-dossier__h"
            closed={rail.closed('a-lane')}
            onToggle={() => rail.toggle('a-lane')}
          >
            {/* Say WHICH leg answered when it is the weaker one. A launch-record
                plan is fixed at spawn, so it can be stale if the agent has since
                moved on — showing it unlabelled would assert more than we know. */}
            {signals?.lane?.source === 'launch' ? (
              <span className="pc-dossier__h-note"> · from launch record</span>
            ) : null}
          </RailSectionHead>
          {signals?.lane ? (
            <>
              {metaRows([
                ['plan', signals.lane.planSlug],
                ['now', signals.lane.nowState],
                [
                  'next up',
                  signals.lane.nextActionable
                    ? `${signals.lane.nextActionable.id} — ${signals.lane.nextActionable.title}`
                    : null,
                ],
              ])}
              <MetaRow
                label="claimable"
                value={
                  signals.lane.claimableCount > 0
                    ? `${signals.lane.claimableCount} item${signals.lane.claimableCount === 1 ? '' : 's'} in this lane`
                    : 'nothing pickable'
                }
              />
            </>
          ) : signals?.unavailableSignals.includes('lane') ? (
            // Same tri-state contract as every other signal: a read that THREW
            // must never look like an agent that simply declared no plan.
            <div className="pc-dossier__empty-line">⚠ unavailable (read failed)</div>
          ) : (
            // The third state, and the one this section used to express by
            // vanishing: no plan declared and none on the launch record. Said
            // out loud, the reader learns both that the agent is not on a plan
            // AND that this is where a plan would appear.
            <div className="pc-dossier__empty-line">
              {signals ? 'Not working on a plan.' : '—'}
            </div>
          )}
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
      {/* Quiet-empty (P-005): settled, this is one dim line rather than a card
          framing "Not waiting on any event." BOTH lists have to be empty — an
          available-but-unawaited gate is a finding, not a calm state. An `error`
          keeps the card: "couldn't read it" must never be quieter than "none". */}
      {zoneTitle && detail && !subs?.error && subRows.length === 0 && availableGates.length === 0 ? (
        <RailQuiet label="Waiting on" none="no event" testId="rail-quiet-events" />
      ) : (
      <section
        className="pc-dossier__section"
        id="pc-dossier-events"
        data-collapsed={rail.closed('a-events') ? 'true' : 'false'}
      >
        <RailSectionHead
          sectionId="a-events"
          label="Waiting on"
          className="pc-dossier__h"
          closed={rail.closed('a-events')}
          onToggle={() => rail.toggle('a-events')}
        >
          {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          {subs?.error ? (
            <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {subs.error}</span>
          ) : null}
          {subs && subs.count > 0 ? (
            <span className="pc-dossier__badge-count">{subs.count} subscribed</span>
          ) : null}
        </RailSectionHead>
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
                {/* WI-7310: the event KEY is machine text and the note is human
                    text; they were rendered in the same face, so the line read as
                    one undifferentiated string. `__id` / `__note` are the rail's
                    two text roles — see the TEXT ROLES block in
                    SessionsRosterView.css. `__h-note` is deliberately NOT reused
                    here: it styles notes riding on a HEADING, and borrowing it
                    for body prose is what left prose with no role of its own. */}
                <span className="pc-dossier__coord-text">
                  <span className="pc-dossier__id">{s.eventKey}</span>
                  {s.note ? (
                    <>
                      <span className="pc-dossier__sep" aria-hidden="true"> · </span>
                      <span className="pc-dossier__note">{s.note}</span>
                    </>
                  ) : null}
                  {!s.wakes ? (
                    <>
                      <span className="pc-dossier__sep" aria-hidden="true"> · </span>
                      <span className="pc-dossier__note">no wake</span>
                    </>
                  ) : null}
                  {s.urgent ? (
                    <>
                      <span className="pc-dossier__sep" aria-hidden="true"> · </span>
                      <span className="pc-dossier__note">urgent</span>
                    </>
                  ) : null}
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

        {/* R1+ P-009 leg (b) — the second half of this section, and the reason
            it is a HALF rather than its own section: neither list is diagnostic
            alone. An await on a key nobody ever declared looks perfectly healthy
            in the list above — it is simply a wait that will never end. A gate
            declared for this agent that it is not listening for looks like
            nothing at all. Only side by side does either failure become
            obvious, so they must not be separated by other sections. */}
        {availableGates.length > 0 ? (
          <>
            <div className="pc-dossier__subhead" data-testid="dossier-gates-subhead">
              available, not awaited
            </div>
            <CappedRows
              noun="gates"
              open={railOpen.has('gates')}
              onToggle={() => toggleRail('gates')}
              testId="dossier-available-gates"
              rows={availableGates.map((g) => (
                <div key={`gate:${g.event}`} className="pc-dossier__coord-line" data-testid="dossier-gate-row">
                  {/* Hollow, against the filled ◉/↻ above: this one is NOT armed. */}
                  <span className="pc-dossier__dir" title="declared, but this agent holds no await on it">
                    ○
                  </span>
                  {/* WI-7310: same two roles as the subscriptions list above —
                      the gate KEY is machine text, its note and scope are not. */}
                  <span className="pc-dossier__coord-text">
                    <span className="pc-dossier__id">{g.event}</span>
                    {g.note ? (
                      <>
                        <span className="pc-dossier__sep" aria-hidden="true"> · </span>
                        <span className="pc-dossier__note">{g.note}</span>
                      </>
                    ) : null}
                    <span className="pc-dossier__sep" aria-hidden="true"> · </span>
                    <span className="pc-dossier__note">{g.scope}</span>
                  </span>
                </div>
              ))}
            />
          </>
        ) : null}
      </section>
      )}

      {/* Rail R1 P-008 — Native Session + Codex Runtime moved to the BOTTOM, below
          Reference. Both are runtime provenance, not "is this agent stuck", and
          between them they were 16 rows sitting above Locks and Coord. */}

      {/* ── Locks ── */}
      {/* hud-first-nav-and-dossier-2026-07-26 P-004: id is the scroll target
          for the footer's "⚠ N locks / M unread" summary chip (D-002's one
          deliberate duplicate) — clicking it opens this rail + scrolls here. */}
      {zoneTitle && detail && locks && !locks.error && locks.held.length === 0 && locks.waiting.length === 0 ? (
        <RailQuiet label="Locks" none="none held" testId="rail-quiet-locks" />
      ) : (
      <section
        className="pc-dossier__section"
        id="pc-dossier-locks"
        data-collapsed={rail.closed('a-locks') ? 'true' : 'false'}
      >
        <RailSectionHead
          sectionId="a-locks"
          label="Locks"
          className="pc-dossier__h"
          closed={rail.closed('a-locks')}
          onToggle={() => rail.toggle('a-locks')}
        >
          {loading && !detail ? <span className="pc-dossier__h-note"> · loading…</span> : null}
          {locks?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {locks.error}</span> : null}
          {locks && locks.held.length + locks.waiting.length > 0 ? (
            <span className="pc-dossier__badge-count">{locks.held.length + locks.waiting.length}</span>
          ) : null}
        </RailSectionHead>
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
      )}

      {zoneTitle ? <RailCluster label="Inbound" /> : null}

      {/* ── Coord ── */}
      {/* hud-first-nav-and-dossier-2026-07-26 P-004: scroll target for the
          footer's summary chip, same rationale as #pc-dossier-locks above. */}
      {/* Quiet-empty (P-005). `unreadCount === 0` is part of the condition, not
          redundant with the row check: unread is a BOUNDED slice over a true
          total, so a nonzero count with an empty slice means messages exist that
          this rail cannot show — the one case where an apparently-empty section
          must keep its frame. */}
      {zoneTitle && coord && !coord.error && coordRows.length === 0 && coord.unreadCount === 0 ? (
        <RailQuiet label="Coord" none="no recent messages" testId="rail-quiet-coord" />
      ) : (
      <section
        className="pc-dossier__section"
        id="pc-dossier-coord"
        data-collapsed={rail.closed('a-coord') ? 'true' : 'false'}
        /* THE section the whole redesign started from [owner 2026-08-01: "the
           coord section and others take up huge vertical space if its a long
           list, thats bad"] — unread traffic is what makes this rail tall. */
        data-attn={coord && coord.unreadCount > 0 ? 'true' : undefined}
      >
        <RailSectionHead
          sectionId="a-coord"
          label="Coord"
          className="pc-dossier__h"
          closed={rail.closed('a-coord')}
          onToggle={() => rail.toggle('a-coord')}
        >
          {coord?.error ? <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {coord.error}</span> : null}
          {coord && coord.unreadCount > 0 ? (
            <span className="pc-dossier__badge-count">{coord.unreadCount} unread</span>
          ) : null}
        </RailSectionHead>
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
      )}

      {/* ── Dynamically pushed context ──
          [owner 2026-08-03] the HUD half of context-injection-retrieval-reach-
          and-visibility-2026-08-03 (P-011). Sits between Coord and Files: Coord
          is what other AGENTS sent this one, this is what the SYSTEM pushed into
          its context without anyone asking — the same "what is arriving at this
          agent" question, one layer down.

          The per-leg marks are the point of the section, not decoration (P-013):
          they turn "the agent was given context" into "the agent was given
          context, and here is whether retrieval was healthy when it happened".
          `semanticRan`/`lexicalRan` are TRI-STATE and rendered as three distinct
          glyphs — `?` (not recorded) must never render as `✗` (recorded, did not
          run), because the first is our blind spot and the second is a finding. */}
      {pushed && !pushed.error && pushed.count === 0 ? (
        <RailQuiet label="Dynamically pushed context" none="nothing pushed in 24h" testId="rail-quiet-pushed" />
      ) : pushed ? (
        <section
          className="pc-dossier__section"
          id="pc-dossier-pushed"
          data-collapsed={rail.closed('a-pushed') ? 'true' : 'false'}
        >
          <RailSectionHead
            sectionId="a-pushed"
            label="Dynamically pushed context"
            className="pc-dossier__h"
            closed={rail.closed('a-pushed')}
            onToggle={() => rail.toggle('a-pushed')}
          >
            {pushed.error ? (
              <span className="pc-dossier__h-note pc-dossier__h-note--err"> · {pushed.error}</span>
            ) : (
              <span className="pc-dossier__badge-count">{pushed.count}</span>
            )}
          </RailSectionHead>
          {pushed.error ? (
            <div className="pc-dossier__empty-line">Couldn’t load pushed context: {pushed.error}</div>
          ) : (
            <>
              {/* Split by KIND, never merged into one list: both ledgers use the
                  same port labels, so `mid-turn 30` from each would render as
                  one indistinguishable row (all 6 corpus ports collide). */}
              {(['memory', 'corpus'] as const).map((kind) => {
                const rows = pushed.refsByPort.filter((r) => r.kind === kind);
                if (rows.length === 0) return null;
                return (
                  <div
                    key={kind}
                    className="pc-dossier__empty-line"
                    data-testid={`dossier-pushed-refs-${kind}`}
                  >
                    {kind === 'memory' ? 'memories' : 'pointers'}{' '}
                    {rows.map((r) => `${r.port} ${r.refs}`).join(' · ')} surfaced
                  </div>
                );
              })}
              {pushed.unavailable && pushed.unavailable.length > 0 ? (
                /* An unreadable ledger is NOT a ledger that surfaced zero —
                   say so rather than letting it read as an absence. */
                <div className="pc-dossier__empty-line" data-testid="dossier-pushed-unavailable">
                  couldn’t read: {pushed.unavailable.join(' · ')}
                </div>
              ) : null}
              {/* P-013's "what was pushed": one row per HANDLE, not a per-port
                  tally. `kind` is rendered because it is also the LEG OF
                  ORIGIN — each ledger has exactly one writer — and it is the
                  only per-ref leg attribution that exists (D-085: the finer
                  cosine-vs-lexical split is recorded as COUNTS on the recall
                  row, never per ref, so inventing it here would be a claim the
                  ledgers cannot support). The `sem`/`lex` marks below stay on
                  the injection rows, where they are actually measured. */}
              <CappedRows
                noun="refs"
                open={railOpen.has('pushedRefs')}
                onToggle={() => toggleRail('pushedRefs')}
                testId="dossier-pushed-refs-list"
                /* True 24h ledger total, not the carried slice. */
                totalCount={pushed.refsTotal ?? 0}
                rows={(pushed.refs ?? []).map((r) => (
                  <div
                    key={`ref:${r.kind}:${r.epoch}:${r.ref}`}
                    className="pc-dossier__coord-line"
                    data-testid="dossier-pushed-ref-row"
                  >
                    <span className="pc-dossier__dir">{r.port}</span>
                    <span className="pc-dossier__coord-text">
                      {/* The row says WHAT was pushed, not which id it was filed
                          under [owner 2026-08-09: "the user doesn't care about
                          the ids"]. The handle is not hidden — it heads the
                          hover panel, where it is selectable — but it no longer
                          IS the row. The old native `title=` attribute is gone
                          on purpose: it carried more ids, could not be selected,
                          and would now race this panel to paint. */}
                      <HoverDetail
                        ariaLabel={`Detail for pushed ${r.kind === 'memory' ? 'memory' : 'pointer'} ${r.ref}`}
                        testId="dossier-pushed-ref-detail"
                        side="left"
                        align="start"
                        header={`${r.kind === 'memory' ? 'memory' : 'pointer'} · ${r.ref} · ${r.port} · epoch ${r.epoch}`}
                        detail={pushedRefDetail(r)}
                      >
                        {pushedRefLabel(r)}
                      </HoverDetail>
                    </span>
                    <span className="pc-dossier__coord-ts">{formatRelativeUpdated(r.at)}</span>
                  </div>
                ))}
              />
              <CappedRows
                noun="injections"
                open={railOpen.has('pushed')}
                onToggle={() => toggleRail('pushed')}
                testId="dossier-pushed-list"
                /* The true 24h total, not the carried slice — same honesty rule
                   the Coord cap above exists to keep. */
                totalCount={pushed.count}
                rows={pushed.events.map((e) => (
                  <div
                    key={`push:${e.at}:${e.surface}`}
                    className="pc-dossier__coord-line"
                    data-testid="dossier-pushed-row"
                  >
                    <span className="pc-dossier__dir">{e.surface}</span>
                    <span className="pc-dossier__coord-text">
                      {/* The row stays a summary; the panel carries the funnel
                          behind it [owner 2026-08-09: the refs tooltips "look
                          good but what about adding them in the same way to the
                          [injection] section"]. These glyphs are the most
                          cryptic thing in the dossier — "sem ✓ lex ✓" is
                          unreadable without the code comment, and "1 of 12
                          admitted" says eleven vanished without saying where. */}
                      <HoverDetail
                        ariaLabel={`Detail for ${e.surface} injection at ${e.at}`}
                        testId="dossier-pushed-detail"
                        side="left"
                        align="start"
                        header={`${e.surface} · ${e.at}`}
                        detail={pushedEventDetail(e)}
                      >
                        {e.admitted} of {e.returned} admitted
                        {e.truncated ? ' · truncated' : ''}
                        {' · '}
                        {legMark('sem', e.semanticRan)} {legMark('lex', e.lexicalRan)}
                      </HoverDetail>
                    </span>
                    <span className="pc-dossier__coord-ts">{formatRelativeUpdated(e.at)}</span>
                  </div>
                ))}
              />
            </>
          )}
        </section>
      ) : null}

      {/* ── Files in play (cross-marked with this agent's lock state) ── */}
      {entry && entry.currentFiles.length > 0 ? (
        <section
          className="pc-dossier__section"
          id="pc-dossier-files"
          data-collapsed={rail.closed('a-files') ? 'true' : 'false'}
        >
          <RailSectionHead
            sectionId="a-files"
            label="Files"
            className="pc-dossier__h"
            closed={rail.closed('a-files')}
            onToggle={() => rail.toggle('a-files')}
          >
            <span className="pc-dossier__badge-count">{entry.currentFiles.length}</span>
          </RailSectionHead>
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
        <section
          className="pc-dossier__section"
          id="pc-dossier-reference"
          data-collapsed={rail.closed('a-reference') ? 'true' : 'false'}
        >
          <RailSectionHead
            sectionId="a-reference"
            label="Reference"
            className="pc-dossier__h"
            closed={rail.closed('a-reference')}
            onToggle={() => rail.toggle('a-reference')}
          />
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
