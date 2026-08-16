/**
 * LearningLoopControl — the Learning tab header's pause/resume + spend control
 * (WI-39501, owner ask 2026-08-16: "a single small place … in the header at the
 * same level as the [stage tabs] for the pause/resume button and overall spend
 * tracking", + dialog refinements: chip shows "learning" with an ANIMATED
 * ellipsis while active, and a pause/resume button sits right next to the chip).
 *
 * One small slot on the stage row — the header element every step shares:
 *   [ ● learning… · $4.62 ▾ ] [⏸]
 * The chip opens a popover control center (run/pause switch, spend breakdown,
 * what resume restores, link to the full token report); the adjacent icon
 * button is the one-click pause/resume.
 *
 * Reads `learning.loopControl` (self-improvement routine group state + the
 * loop's own spend — scout/gym/llm-testing roles only, owner scope ruling).
 * Writes through the SAME gated + audited bridge the Automation pane uses
 * (`/api/agent-mcp/run-tool` → routines:group-set), whose group-pause stamps
 * make resume restore EXACTLY the routines the pause held — a deliberate
 * pre-existing hold (IQ battery, template gym, …) is never revived.
 *
 * Styles are scoped here (pc-lloop__*) so the LearningTab wiring stays small;
 * the paused stepper treatment keys off `.pc-lloop--paused` via :has() in
 * LearningStyles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryState, parseAsBoolean, parseAsString } from "nuqs";
import { ChevronDown, Pause, Play } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import { useFlag } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import type { LearningLoopControl as LoopSnapshot } from "@papercusp/operator-core/lib/harness/improvements/loop-control";

/** Human labels for the loop's spend roles. */
const ROLE_LABELS: Record<string, string> = {
  scout: "Scout",
  gym: "Gym",
  "llm-testing": "Judges",
};

function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function agoLabel(atMs: number, nowMs: number): string {
  const min = Math.max(0, (nowMs - atMs) / 60_000);
  if (min < 1) return "just now";
  if (min < 90) return `${Math.round(min)}m ago`;
  if (min < 60 * 36) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

/** Fire routines:group-set through the gated + audited run-tool bridge (the
 *  Automation pane's exact contract — 'loopback' actor, confirmed:true). */
async function runGroupSet(args: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/agent-mcp/run-tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "routines:group-set", args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  if (text) {
    const payload = JSON.parse(text) as { ok?: boolean; message?: string };
    if (payload.ok === false) throw new Error(payload.message ?? "routines:group-set refused");
  }
}

export default function LearningLoopControl() {
  const enabled = useFlag(FLAGS.LEARNING_LOOP_CONTROL);
  const sync = useSyncQuery<LoopSnapshot>({
    queryName: "learning.loopControl",
    args: {},
    staleTime: 30_000,
  });
  const [open, setOpen] = useQueryState("lloop", parseAsBoolean.withDefault(false));
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setInsightView] = useQueryState("insightView", parseAsString);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-click / Escape close for the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) void setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const snap = sync.data?.[0];
  const paused = snap?.status === "paused";

  const setActive = useCallback(
    async (nextActive: boolean) => {
      if (!snap || busy) return;
      setBusy(true);
      setError(null);
      try {
        await runGroupSet(
          nextActive
            ? { group: snap.group, active: true }
            : { group: snap.group, active: false, reason: "Paused from the Learning tab" },
        );
        // The server emits an SSE invalidate too, but its 90s source-side dedupe
        // can swallow a quick pause→resume — the clicker always refetches locally.
        sync.invalidate();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [snap, busy, sync],
  );

  // Shape-guard, not just presence: a row without `spend` (a stale cache, a
  // generic test mock, a server predating the learning.loopControl resolver)
  // must read as "no snapshot yet", never crash the whole Learning tab
  // (WI-39530 — 11 LearningTab.test.tsx reds from `snap.spend.todayUsd`).
  if (!enabled || !snap || !snap.spend) return null;

  const spendToday = usd(snap.spend.todayUsd);
  const holdNote = paused
    ? `Held${snap.pausedAtMs ? ` ${agoLabel(snap.pausedAtMs, snap.evaluatedAt)}` : ""}${
        snap.pausedBy ? ` by ${snap.pausedBy}` : ""
      }. Resume restores the ${snap.heldCount} routine${snap.heldCount === 1 ? "" : "s"} this pause held — deliberate holds stay held.`
    : `Pausing holds the ${snap.activeCount} active routine${snap.activeCount === 1 ? "" : "s"} in the ${snap.group} group. Resume restores exactly those — loops paused deliberately stay paused.`;

  return (
    <div ref={rootRef} className={`pc-lloop${paused ? " pc-lloop--paused" : ""}`}>
      <button
        type="button"
        className="pc-lloop__chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={error ?? "Learning loops — spend & pause"}
        onClick={() => void setOpen(!open)}
      >
        <span className="pc-lloop__dot" aria-hidden />
        {paused ? (
          <span className="pc-lloop__word">paused</span>
        ) : (
          <span className="pc-lloop__word">
            learning
            <span className="pc-lloop__ell" aria-hidden>
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </span>
        )}
        <span className="pc-lloop__amt">{spendToday}</span>
        <ChevronDown size={10} aria-hidden />
      </button>
      <button
        type="button"
        className="pc-lloop__pp"
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={paused ? "Resume all learning loops" : "Pause all learning loops"}
        title={
          error ??
          (paused
            ? `Resume the ${snap.heldCount} held learning loop${snap.heldCount === 1 ? "" : "s"}`
            : `Pause all ${snap.activeCount} learning loop${snap.activeCount === 1 ? "" : "s"}`)
        }
        onClick={() => void setActive(paused)}
      >
        {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
      </button>

      {open ? (
        <div className="pc-lloop__pop" role="dialog" aria-label="Learning loops">
          <div className="pc-lloop__pophead">
            Learning loops
            <span className={`pc-lloop__state pc-lloop__state--${snap.status}`}>{snap.status}</span>
          </div>
          <label className="pc-lloop__swrow">
            <span>Run the loop</span>
            <span className="pc-lloop__sw">
              <input
                type="checkbox"
                checked={!paused}
                disabled={busy}
                onChange={(e) => void setActive(e.target.checked)}
              />
              <span className="pc-lloop__swtrack" aria-hidden />
              <span className="pc-lloop__swthumb" aria-hidden />
            </span>
          </label>
          <p className="pc-lloop__fine">{holdNote}</p>
          {error ? (
            <p className="pc-lloop__err" role="alert">
              {error}
            </p>
          ) : null}
          <hr className="pc-lloop__hr" />
          <div className="pc-lloop__srow">
            <span>Today</span>
            <b>{spendToday}</b>
          </div>
          <div className="pc-lloop__srow">
            <span>Last 7 days</span>
            <b>{usd(snap.spend.weekUsd)}</b>
          </div>
          {snap.spend.byRole.map((r) => (
            <div key={r.role} className="pc-lloop__srow pc-lloop__srow--sub">
              <span>{ROLE_LABELS[r.role] ?? r.role}</span>
              <span>{usd(r.todayUsd)}</span>
            </div>
          ))}
          <p className="pc-lloop__fine">The loop's own roles only — implement workers are not counted.</p>
          <button
            type="button"
            className="pc-lloop__link"
            onClick={() => {
              void setOpen(false);
              void setTab("insights");
              void setInsightView("tokens");
            }}
          >
            Full token report →
          </button>
        </div>
      ) : null}

      <style>{`
        .pc-lloop { position: absolute; right: 0; top: 4px; display: flex; align-items: center; gap: 6px; z-index: 2; }
        .pc-lloop__chip {
          display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
          border: 1px solid var(--border-strong); border-radius: 999px;
          background: var(--bg-1); color: var(--fg-dim); cursor: pointer; font: inherit;
          font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap;
        }
        .pc-lloop__chip:hover { color: var(--fg); background: var(--bg-2); }
        .pc-lloop__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
        .pc-lloop--paused .pc-lloop__dot { background: var(--warn); }
        .pc-lloop--paused .pc-lloop__chip {
          color: var(--warn);
          border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
          background: color-mix(in srgb, var(--warn) 9%, var(--bg-1));
        }
        .pc-lloop__word { font-weight: 650; }
        .pc-lloop__ell { display: inline-flex; }
        .pc-lloop__ell i { font-style: normal; animation: pc-lloop-ell 1.4s infinite both; }
        .pc-lloop__ell i:nth-child(2) { animation-delay: .2s; }
        .pc-lloop__ell i:nth-child(3) { animation-delay: .4s; }
        @keyframes pc-lloop-ell { 0%, 20% { opacity: .15; } 40% { opacity: 1; } 100% { opacity: .15; } }
        @media (prefers-reduced-motion: reduce) { .pc-lloop__ell i { animation: none; } }
        .pc-lloop__amt { color: var(--fg-mute); }
        .pc-lloop--paused .pc-lloop__amt { color: inherit; opacity: .8; }
        .pc-lloop__pp {
          display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px;
          border: 1px solid var(--border-strong); background: var(--bg-1);
          color: var(--fg-dim); cursor: pointer; padding: 0;
        }
        .pc-lloop__pp:hover { color: var(--fg); background: var(--bg-2); }
        .pc-lloop__pp[disabled] { opacity: .5; cursor: default; }
        .pc-lloop--paused .pc-lloop__pp {
          color: var(--warn);
          border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
        }
        .pc-lloop__pop {
          position: absolute; right: 0; top: 30px; z-index: 30; width: 256px;
          background: var(--bg-2); border: 1px solid var(--border-strong);
          border-radius: 10px; padding: 12px 14px;
          box-shadow: 0 12px 32px color-mix(in srgb, var(--fg) 12%, transparent);
          font-size: 12px; color: var(--fg-dim); text-align: left;
        }
        .pc-lloop__pophead {
          display: flex; justify-content: space-between; align-items: center;
          font-weight: 700; color: var(--fg); margin-bottom: 6px;
        }
        .pc-lloop__state { font-size: 10px; font-weight: 700; text-transform: uppercase; }
        .pc-lloop__state--running { color: var(--good); }
        .pc-lloop__state--paused { color: var(--warn); }
        .pc-lloop__swrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 0 8px; cursor: pointer; }
        .pc-lloop__sw { position: relative; display: inline-flex; flex: none; }
        .pc-lloop__sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
        .pc-lloop__swtrack { width: 30px; height: 17px; border-radius: 999px; background: var(--border-strong); transition: background var(--dur-fast); pointer-events: none; }
        .pc-lloop__swthumb { position: absolute; top: 2.5px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--fg); transition: transform var(--dur-fast); pointer-events: none; }
        .pc-lloop__sw input:checked + .pc-lloop__swtrack { background: var(--accent); }
        .pc-lloop__sw input:checked ~ .pc-lloop__swthumb { transform: translateX(12px); }
        .pc-lloop__sw input:focus-visible + .pc-lloop__swtrack { outline: 2px solid var(--accent); outline-offset: 2px; }
        .pc-lloop__fine { margin: 0 0 6px; font-size: 11px; line-height: 1.45; color: var(--fg-mute); }
        .pc-lloop__err { margin: 0 0 6px; font-size: 11px; line-height: 1.45; color: var(--bad, #fb7185); }
        .pc-lloop__hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
        .pc-lloop__srow { display: flex; justify-content: space-between; padding: 2px 0; font-variant-numeric: tabular-nums; }
        .pc-lloop__srow b { color: var(--fg); font-weight: 650; }
        .pc-lloop__srow--sub { color: var(--fg-mute); font-size: 11.5px; }
        .pc-lloop__link { display: inline-block; margin-top: 6px; font-size: 12px; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit; }
        .pc-lloop__link:hover { text-decoration: underline; text-underline-offset: 3px; }
      `}</style>
    </div>
  );
}
