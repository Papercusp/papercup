'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';
import { TONE } from './theme';
import {
  useAgentThinkingStream,
  Entry,
  waitingMessage,
  groupEntriesIntoTurns,
  ThinkingDot,
  fmtEntryTime,
  type Turn,
} from './AgentThinkingStream';

/**
 * AgentInspectorModal — the pinned, full-height view of a run's live thinking
 * stream. Opened by clicking a running agent's row in the AgentsRoster
 * (operator-vite's AgentsRunningPill → onInspect), the LIVE surface for this
 * — NOT a hover popover (EI-5917/WI-2346: AgentThinkingStream.tsx used to also
 * export a default `AgentThinkingPopover` hover component with no JSX caller
 * anywhere in the tree; it was deleted and only its shared hook/renderer
 * exports below survive, reused here).
 *
 * It does NOT dismiss on mouse-leave, so the whole transcript can be read +
 * scrolled. It reuses the shared stream hook + Entry renderer, but presents
 * the timeline grouped into TURNS, NEWEST-FIRST: the turn the agent is
 * currently working streams live at the TOP as "● Live turn" (with a pulsing
 * thinking indicator), and when it completes it becomes the top of the
 * completed-turns list below it — each older turn beneath, latest highest.
 *
 * Empty-timeline state reuses the shared `waitingMessage` helper (WI-1325): a
 * live run producing ZERO output for STALL_AFTER_MS escalates from a hopeful
 * "Waiting…" to a "⚠ no output for {elapsed} — stalled/rate-limited" warning +
 * a "stalled?" header, so a wedged agent stops reading as an eternal green
 * "live · No output yet".
 */
export default function AgentInspectorModal({
  slug,
  phase,
  runId,
  role,
  open,
  onClose,
  startedAtMs,
  streamUrl,
  focusTarget,
  resumeTarget,
  highlightTerm,
}: {
  slug: string;
  phase: string;
  runId: string;
  role: string;
  open: boolean;
  onClose: () => void;
  /** Run start (epoch-ms). Drives the elapsed counter + stall detection while
   *  the timeline is still empty. Optional — defaults to when the inspector was
   *  opened, so a wedged run still escalates from "waiting" to "stalled?". */
  startedAtMs?: number;
  /** Explicit stream URL — set for interactive-session transcripts; omit to use
   *  the bee run-log stream keyed by slug/runId. */
  streamUrl?: string;
  /** The agent's OS terminal-window handle — passed ONLY when focus will work (a
   *  stored X11 `windowId`). Present ⇒ a "Focus window" button that raises the
   *  agent's terminal via `POST /api/adv/sessions/focus`; absent ⇒ no button. */
  focusTarget?: { advSessionId?: number | null; windowId?: string | null; pid?: number | null };
  /**
   * WI-3882 (P-012, adv-sessions-live-roster): the session id to fork/resume
   * into a NEW terminal via `POST /api/agent-mcp/console/launch`'s
   * `resumeSessionId` (plan-agent-launch P-023 — `<agent-cli> -r <id>`,
   * console-launcher.ts). Present ⇒ a state-aware button: `live:true` (the
   * source agent is still running — this OPENS A PARALLEL window on the same
   * transcript, the original keeps going) labels it "Fork in new terminal";
   * `live:false` (the source session has ENDED) labels it "Resume in new
   * terminal". Absent ⇒ no button (never a dead one) — only claude/omp
   * sessions accept `-r`, so callers gate on that before passing this.
   * WI-4009: `live:true` additionally requires the source to be a CLAUDE
   * session — `--fork-session` is claude-only (console-launcher.ts), and an
   * omp session has no fork command, so callers never set `live:true` for a
   * live omp/codex agent (see `canForkLive` in AgentsRunningPill.tsx).
   * Linux-only for now, same constraint as the primary /console/launch spawn
   * path itself (see native-console.ts) — mirrors focusTarget's posture.
   */
  resumeTarget?: { sessionId: string; live: boolean; label?: string | null } | null;
  /** Search-hit deep-link (agents-pill-inactive-search-2026-07-09 P-005): the
   *  term to highlight throughout the transcript. Pair with a streamUrl that
   *  carries `find`/`anchorTs` — the stream's `anchor` event then names the
   *  matched backfill entry and the pane auto-scrolls to it. */
  highlightTerm?: string;
}) {
  const { events, status, thinking, anchor } = useAgentThinkingStream(slug, phase, runId, streamUrl);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Elapsed baseline: the run start when known, else when this inspector opened
  // (captured once). Feeds the stall escalation while the timeline is empty.
  const openedAtRef = useRef<number>(Date.now());
  const [now, setNow] = useState(() => Date.now());
  // Tick a 1s clock ONLY while still waiting on the first output (empty timeline,
  // not terminal) so the elapsed counter + stall escalation update live.
  useEffect(() => {
    if (events.length > 0 || status === 'done') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [events.length, status]);

  // Group the flat timeline into turns and show them NEWEST-FIRST (latest highest).
  // The newest turn is the "live" one while the agent is actively thinking; when a
  // turn completes it just becomes the top of the completed list below.
  const turns = useMemo(() => groupEntriesIntoTurns(events), [events]);
  const ordered = useMemo(() => [...turns].reverse(), [turns]);

  // Search-hit anchor: the matched backfill entry (by identity — backfill
  // entries keep their array positions as live `event` deltas append after).
  const anchorEntry = anchor?.found && anchor.index != null ? events[anchor.index] ?? null : null;

  // Newest turn is at the TOP, so keep the scroll pinned to the top as new turns /
  // entries stream in — unless the user scrolled DOWN to read history, or the
  // pane is anchored to a search match (the match owns the scroll position).
  const atTopRef = useRef(true);
  useEffect(() => {
    if (anchorEntry) return;
    const el = scrollRef.current;
    if (el && atTopRef.current) el.scrollTop = 0;
  }, [events, anchorEntry]);

  // Scroll to the anchored (matched) entry ONCE per stream — after the backfill
  // renders. The wrapper div carries data-anchor="true" (see TurnBlock).
  const anchorScrolledRef = useRef(false);
  useEffect(() => { anchorScrolledRef.current = false; }, [streamUrl, runId]);
  useEffect(() => {
    if (!anchorEntry || anchorScrolledRef.current) return;
    const el = scrollRef.current?.querySelector('[data-anchor="true"]');
    if (!el) return;
    anchorScrolledRef.current = true;
    atTopRef.current = false;
    (el as HTMLElement).scrollIntoView({ block: 'center' });
  }, [anchorEntry, events.length]);

  // "Focus window" — raise the agent's OS terminal via the existing wmctrl-backed
  // endpoint. Only wired when the caller passed a focusTarget (i.e. focus will work).
  const [focusState, setFocusState] = useState<'idle' | 'busy' | 'err'>('idle');
  const focusWindow = useCallback(async () => {
    if (!focusTarget) return;
    setFocusState('busy');
    try {
      const res = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        // text/plain → CORS "simple request", no preflight OPTIONS (webkit2gtk in
        // the desktop build fails preflight handshakes silently — see the resume
        // handler below + native-console.ts). The route parses the raw body as
        // JSON regardless of content-type.
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          id: focusTarget.advSessionId ?? undefined,
          windowId: focusTarget.windowId ?? undefined,
          pid: focusTarget.pid ?? undefined,
        }),
      });
      setFocusState(res.ok ? 'idle' : 'err');
    } catch {
      setFocusState('err');
    }
  }, [focusTarget]);

  // "Fork/Resume in new terminal" (WI-3882) — reuse the existing capability:
  // terminal + psu-session-resume path (plan-agent-launch P-023) via the same
  // console-launch route the "+" console button / capability:terminal use.
  const [resumeState, setResumeState] = useState<'idle' | 'busy' | 'err'>('idle');
  // The server's actual failure reason (WI-3988/WI-3989) — shown as the button
  // tooltip so a failure is diagnosable instead of a bare "fork failed".
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  const resumeInNewTerminal = useCallback(async () => {
    if (!resumeTarget) return;
    setResumeState('busy');
    setResumeErr(null);
    try {
      const res = await fetch('/api/agent-mcp/console/launch', {
        method: 'POST',
        // WI-3988/WI-3989: use text/plain, NOT application/json. application/json
        // is not a CORS "simple request", so it triggers a preflight OPTIONS —
        // which webkit2gtk in the desktop build fails SILENTLY, so the POST never
        // reached the server and Fork/Resume died with a bare "failed" (the
        // console-launch debug log showed no browser request at all). text/plain
        // is a simple request (no preflight); the route parses the raw body as
        // JSON regardless of content-type. Mirrors the proven native-console.ts
        // console-launch path (the working "+" console button uses text/plain).
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          resumeSessionId: resumeTarget.sessionId,
          // WI-3882: a LIVE source session FORKS (branch into a new session —
          // the original keeps running); an ENDED one resumes in place. Without
          // this the Fork button would resume the still-live session in place
          // and collide with it (a second CLI on the same transcript).
          fork: resumeTarget.live === true,
          label: resumeTarget.label ?? `${resumeTarget.live ? 'fork' : 'resume'} · ${role}`,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.status === 'ok') {
        setResumeState('idle');
      } else {
        setResumeErr(data?.error ?? `HTTP ${res.status}`);
        setResumeState('err');
      }
    } catch (e) {
      setResumeErr(e instanceof Error ? e.message : 'request failed');
      setResumeState('err');
    }
  }, [resumeTarget, role]);

  const elapsedMs = Math.max(0, now - (startedAtMs ?? openedAtRef.current));
  const waiting = waitingMessage(status, elapsedMs);
  // A live run sitting on zero output past the stall threshold reads as
  // "stalled?" instead of a reassuring green "live" (shared waitingMessage logic).
  const stalledNow = events.length === 0 && status === 'live' && waiting.stalled;
  const statusLabel = stalledNow ? 'stalled?' : status === 'connecting' ? 'connecting…' : status;
  const statusColor = stalledNow ? TONE.warn
    : status === 'live' ? TONE.good
    : status === 'error' ? TONE.bad
    : TONE.neutral;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Agent inspector — ${role}`}
      srOnlyTitle
      contentStyle={{
        width: 'min(880px, 94vw)',
        height: 'min(78vh, 900px)',
        padding: 0,
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'var(--fg)',
      }}
    >
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--bg-2)',
        fontSize: 12,
      }}>
        <span style={{ color: 'var(--fg-mute)' }}>
          <strong style={{ color: 'var(--fg)' }}>{role}</strong>
          {' · '}<code style={{ fontSize: 11 }}>{runId}</code>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {resumeTarget ? (
            // EI-9449: a Radix <Tooltip label={...}> whose label toggles falsy⇄truthy
            // AFTER MOUNT (here: undefined → resumeErr once the launch POST fails)
            // structurally swaps Tooltip's own render tree (its `if (!label) return
            // <>{children}</>` guard branches from a bare Fragment to the full
            // Provider/Root/Trigger/Portal tree — a different element TYPE at this
            // JSX position), so React unmounts + remounts the whole subtree, INCLUDING
            // this button — any DOM reference held across that transition (a prior
            // `getByTestId`/focus/ref) goes stale mid-flight, silently pointing at a
            // detached node forever. A native `title` attribute carries the same
            // "server reason as tooltip" intent (see the getAttribute('title') assert
            // below) without ever changing this element's type, so the button node
            // never remounts. (Tooltip.tsx's guard is intentional + tested for STATIC
            // per-usage labels — this is the one call site that toggles the label at
            // runtime; fix the toggling call site, not the shared component's contract.)
            <button
              type="button"
              data-testid="resume-terminal-btn"
              onClick={resumeInNewTerminal}
              disabled={resumeState === 'busy'}
              title={resumeState === 'err' && resumeErr ? resumeErr : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: resumeState === 'busy' ? 'default' : 'pointer',
                color: resumeState === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>{resumeTarget.live ? '⑂' : '↻'}</span>
              {resumeState === 'busy'
                ? (resumeTarget.live ? 'forking…' : 'resuming…')
                : resumeState === 'err'
                  ? (resumeTarget.live ? 'fork failed' : 'resume failed')
                  : (resumeTarget.live ? 'Fork in new terminal' : 'Resume in new terminal')}
            </button>
          ) : null}
          {focusTarget ? (
            <button
              type="button"
              data-testid="focus-window-btn"
              onClick={focusWindow}
              disabled={focusState === 'busy'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: focusState === 'busy' ? 'default' : 'pointer',
                color: focusState === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>⤢</span>
              {focusState === 'busy' ? 'focusing…' : focusState === 'err' ? 'focus failed' : 'Focus window'}
            </button>
          ) : null}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {thinking ? <ThinkingDot size={7} /> : (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
            )}
            <span style={{ color: thinking ? TONE.good : statusColor }}>{thinking ? 'thinking…' : statusLabel}</span>
            <span style={{ color: 'var(--fg-mute)' }}>· {turns.length} turn{turns.length === 1 ? '' : 's'} · {events.length} event{events.length === 1 ? '' : 's'}</span>
            {highlightTerm && anchor ? (
              <span
                data-testid="anchor-status"
                style={{ color: anchor.found ? 'var(--accent-strong, #7dd3fc)' : TONE.warn }}
              >
                {anchor.found
                  ? `· ⚓ jumped to match`
                  : '· match not in transcript — showing latest'}
              </span>
            ) : null}
          </span>
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atTopRef.current = el.scrollTop < 40;
        }}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: waiting.stalled ? TONE.warn : 'var(--fg-mute)', fontStyle: 'italic' }}>
            {waiting.text}
          </div>
        ) : (
          ordered.map((turn, i) => (
            <TurnBlock
              key={turn.seq}
              turn={turn}
              live={thinking && i === 0}
              highlightTerm={highlightTerm}
              anchorEntry={anchorEntry}
            />
          ))
        )}
      </div>
    </Modal>
  );
}

/**
 * One turn rendered as a bordered block: a header (● Live turn while streaming,
 * else "Turn N" + its time) over the turn's prompt + activity. The live turn sits
 * at the TOP of the pane (newest-first) and is accented + pulsing. When the pane
 * is anchored to a search hit, the matched entry's wrapper carries
 * data-anchor="true" (the auto-scroll target) + an accent outline, and every
 * entry highlights `highlightTerm` occurrences.
 */
function TurnBlock({
  turn,
  live,
  highlightTerm,
  anchorEntry,
}: {
  turn: Turn;
  live: boolean;
  highlightTerm?: string;
  anchorEntry?: import('./AgentThinkingStream').TimelineEntry | null;
}) {
  const time = fmtEntryTime(turn.startTs);
  const accent = live ? 'var(--accent, #38bdf8)' : 'var(--border)';
  return (
    <div
      data-testid={live ? 'turn-live' : `turn-${turn.seq}`}
      style={{
        marginBottom: 12,
        border: `1px solid ${accent}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 94%)' : 'transparent',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'var(--bg-2)',
        borderBottom: '1px solid var(--border)', fontSize: 11,
      }}>
        {live ? <ThinkingDot size={7} /> : (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fg-mute)', display: 'inline-block' }} />
        )}
        <strong style={{ color: live ? 'var(--accent-strong, #7dd3fc)' : 'var(--fg)' }}>
          {live ? 'Live turn' : `Turn ${turn.seq + 1}`}
        </strong>
        {time ? <span style={{ color: 'var(--fg-mute)', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span> : null}
      </div>
      <div style={{ padding: 8 }}>
        {/* Newest-first WITHIN the turn too, so the current streamed line is the
            highest thing in the (top) live turn — not buried at the bottom. The
            prompt is the oldest event of the turn, so it falls to the foot. */}
        {[...(turn.prompt ? [turn.prompt, ...turn.entries] : turn.entries)]
          .reverse()
          .map((e, i) => {
            const anchored = Boolean(anchorEntry && e === anchorEntry);
            return (
              <div
                key={i}
                data-anchor={anchored ? 'true' : undefined}
                style={anchored
                  ? { outline: '2px solid var(--accent, #38bdf8)', outlineOffset: 2, borderRadius: 4 }
                  : undefined}
              >
                <Entry entry={e} highlightTerm={highlightTerm} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
