/**
 * SignalsPanel — the Observe-stage "what is the pipeline fed?" view
 * (learning-tab-visibility-2026-07-18 P-006, owner ask 2026-07-18: "there are
 * other signals that the learning pipeline looks at as well, shouldn't they be
 * surfaced somehow in the observe tab?").
 *
 * Three sections, all derived from the `learning.scout` snapshot (the gate's
 * own readers — never a UI-side re-derivation):
 *
 *   1. TRIGGER lanes — the 6 signal-accumulator lanes whose weighted score
 *      fires a cycle (live pending counts, the same numbers the volume gate
 *      judges).
 *   2. FED lanes — the digest grounding-lane composition of the newest ran
 *      cycles (`detail.groundingLanes`): what each cycle's corpus actually
 *      contained, per lane.
 *   3. The lane taxonomy — every input lane named + explained in one line, so
 *      the full signal surface is legible without reading the engine.
 *
 * Self-contained (own sync query + pc-signals__* styles, the panel idiom).
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { Rss, RefreshCw } from "lucide-react";
import type { ScoutSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-scout-read";
import {
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";

/** One-line description per TRIGGER (accumulator) lane — mirrors the
 *  signal-accumulator module docs; counts are "new since the last cycle". */
const TRIGGER_LANE_DOCS: Record<string, string> = {
  "scorecard-rating-changes":
    "A rubric criterion whose new grade DIFFERS from its previous one (a re-grade at the same rating is not signal; a first-ever grade is).",
  observations: "New agent-filed observations (engineer_issues rows carrying an observation).",
  captures: "New bug / feature / improvement filings (engineer_issues rows without an observation).",
  reverts: "Work released back after being claimed — bounced work is the revert-shaped signal.",
  deferrals: "Work items newly blocked / deprecated / needs-human — the colony getting stuck.",
  completions: "Work items reaching a terminal-success state.",
};

/** One-line description per FED (digest grounding) lane — what the corpus
 *  synthesis reads and ideas cite as grounding. Mirrors the FULL flattenDigest
 *  lane list (lenses.ts) — every lane the ideator prompt actually renders, so
 *  "the full lane taxonomy" below is really full (owner ask 2026-07-18: the
 *  watchdog lane was fed but invisible here). */
const FED_LANE_DOCS: Record<string, string> = {
  corpus: "The standing MetaPattern corpus — recurring friction patterns distilled from the whole signal history.",
  "recurring-friction": "Recurring friction patterns — the same breakage/annoyance surfacing across many signals.",
  "time-token-sink": "Time / token sinks — where agent hours and LLM spend chronically pool.",
  "chronic-deferral": "Chronically deferred work — items the colony keeps pushing off.",
  "capability-gap": "Capability gaps — things agents repeatedly could not do.",
  "rubric-rating": "Rubric criterion grades — quality verdicts on live behavior.",
  "spend-anomaly": "Spend anomalies — cost spikes worth ideating on.",
  "niche-map": "The quality-diversity niche map — where idea-space is unexplored.",
  "standing-fact": "Standing facts (facts:assert) — durable conclusions agents have pinned.",
  "watchdog-health": "Watchdog health — chronic measured infrastructure signal from the 15-min collectors + standing open alarm conditions (watchdog_ticks).",
  "gate-pipeline-health": "Gate / pipeline health — release ship-path incidents: standing reds, promotion/deploy stalls, chronic pipeline failures.",
  "coord-health": "Coordination health — escalation storms, unanswered directed mail, inbox/wake floods, claim conflicts.",
  "tool-telemetry": "Tool telemetry — measured DX friction: per-tool error rates, arg-limit rejections, retry loops, chronic p95 latency.",
  "knowledge-reuse-gap": "Knowledge-reuse gaps — lessons that exist but keep not being found/applied.",
  "plan-health": "Plan-health signals — stalled / drifting plans.",
  "owner-correction": "Owner corrections — every time you redirect an agent, that becomes learning input.",
  "recent-commit": "Recent-commit churn hotspots — where the tree is actively morphing right now.",
};

export function SignalsPanel({
  onStatus,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
} = {}) {
  const sync = useSyncQuery<ScoutSnapshot>({
    queryName: "learning.scout",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const cadence = snap?.cadence ?? null;
  const ranTicks = (snap?.ticks ?? []).filter((t) => t.status === "ran");
  // P-008: the newest fired cycle's persisted digest (delta + standing corpus).
  const digest = snap?.digest ?? null;

  const status: "neutral" | "good" | "warn" | "bad" = sync.error
    ? "bad"
    : cadence == null && ranTicks.length === 0
      ? "neutral"
      : "good";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  return (
    <section className="pc-learning__section pc-signals" aria-label="Learning pipeline input signals">
      <LearningPageHeader
        icon={Rss}
        title="Signals"
        question="What is the learning pipeline being fed — and what will make it fire next?"
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload signals"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      {sync.error ? (
        <LearningVisualError title="The signals read failed" onRetry={() => sync.invalidate()} />
      ) : sync.loading && !snap ? (
        <p className="pc-learning__quietempty">Loading signal state…</p>
      ) : cadence == null && ranTicks.length === 0 ? (
        <LearningVisualEmpty icon={Rss} title="No signal state recorded yet — the accumulator sweep has not run on this workspace." />
      ) : (
        <>
          {cadence ? (
            <>
              <div className="pc-signals__sectionhead">
                <h3>Trigger lanes — new signal since the last cycle</h3>
                <span title={`The weighted score over these lanes fires a cycle at ≥${cadence.threshold}; zero withholds everything (spend drops to zero in quiet periods).`}>
                  score {Math.round(cadence.score * 10) / 10} / {cadence.threshold}
                </span>
              </div>
              <ul className="pc-signals__lanes" aria-label="Trigger lanes">
                {cadence.lanes.map((l) => (
                  <li key={l.lane} className={l.count > 0 ? "is-live" : undefined}>
                    <strong>{l.count}</strong>
                    <span className="pc-signals__lane">{l.lane.replace(/-/g, " ")}</span>
                    <em title={TRIGGER_LANE_DOCS[l.lane] ?? ""}>
                      ×{l.weight} → {Math.round(l.count * l.weight * 10) / 10}
                    </em>
                    <p>{TRIGGER_LANE_DOCS[l.lane] ?? ""}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {ranTicks.length > 0 ? (
            <>
              <div className="pc-signals__sectionhead">
                <h3>What recent cycles were fed</h3>
                <span>digest composition per fired cycle, newest first</span>
              </div>
              <ul className="pc-signals__fed" aria-label="Recent cycle digest composition">
                {ranTicks.slice(0, 6).map((t, i) => {
                  const lanes = Object.entries(t.groundingLanes ?? {}).sort((a, b) => b[1] - a[1]);
                  const atMs = t.at ? Date.parse(t.at) : NaN;
                  return (
                    <li key={t.cycleId ?? `${t.at ?? "tick"}-${i}`}>
                      <span className="pc-signals__fedwhen">
                        {Number.isNaN(atMs)
                          ? "—"
                          : new Date(atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {lanes.length === 0 ? (
                        <em title="This tick's recorder predates the groundingLanes field, or the cycle was fed no lane-tagged entries.">
                          composition not recorded
                        </em>
                      ) : (
                        lanes.map(([lane, n]) => (
                          <span key={lane} className="pc-signals__fedchip" title={FED_LANE_DOCS[lane] ?? lane}>
                            {lane.replace(/-/g, " ")} <strong>{n}</strong>
                          </span>
                        ))
                      )}
                      <em className="pc-signals__fedout">→ {t.generated} ideas, {t.routed} routed</em>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {digest ? (
            <>
              <div className="pc-signals__sectionhead">
                <h3>The digest the last cycle read</h3>
                <span title="The persisted corpus digest the fired cycle's ideators were prompted with — the delta leg ('NEW since your last cycle') leads the prompt, exactly as shown here.">
                  {digest.totalEntries} entries
                  {digest.cycleId ? ` · ${digest.cycleId}` : ""}
                </span>
              </div>
              {digest.newEntries.length > 0 ? (
                <ul className="pc-signals__digest" aria-label="New digest entries since the previous cycle">
                  {digest.newEntries.map((e) => (
                    <li key={e.ref} className="is-new">
                      <span className="pc-signals__fedchip" title={`Lane: ${e.lane.replace(/-/g, " ")}`}>
                        new · {e.lane.replace(/-/g, " ")}
                      </span>
                      <span className="pc-signals__digest-summary" title={e.ref}>
                        {e.summary}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pc-signals__digest-none">
                  No new entries vs the previous cycle — the delta leg was empty; the cycle ran on standing corpus.
                </p>
              )}
              {digest.standingEntries.length > 0 ? (
                <details className="pc-signals__digest-standing">
                  <summary>
                    Standing corpus ({Object.entries(digest.laneCounts)
                      .map(([l, n]) => `${l.replace(/-/g, " ")} ${n}`)
                      .join(" · ")})
                  </summary>
                  <ul className="pc-signals__digest" aria-label="Standing digest entries">
                    {digest.standingEntries.map((e) => (
                      <li key={e.ref}>
                        <span className="pc-signals__fedchip" title={`Lane: ${e.lane.replace(/-/g, " ")}`}>
                          {e.lane.replace(/-/g, " ")}
                        </span>
                        <span className="pc-signals__digest-summary" title={e.ref}>
                          {e.summary}
                        </span>
                      </li>
                    ))}
                    {digest.truncated ? (
                      <li>
                        <em>…capped for display — the full digest is in scout_digest_snapshots.</em>
                      </li>
                    ) : null}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}

          <div className="pc-signals__sectionhead">
            <h3>The full lane taxonomy</h3>
            <span>every input the pipeline reads</span>
          </div>
          <ul className="pc-signals__taxonomy" aria-label="All signal lanes explained">
            {Object.entries(FED_LANE_DOCS).map(([lane, doc]) => (
              <li key={lane}>
                <span className="pc-signals__lane">{lane.replace(/-/g, " ")}</span>
                <p>{doc}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{`
      .pc-signals__sectionhead {
        display: flex; align-items: baseline; gap: 10px; margin: 14px 2px 6px;
      }
      .pc-signals__sectionhead h3 {
        margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-signals__sectionhead > span { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-signals__lanes, .pc-signals__taxonomy, .pc-signals__fed {
        list-style: none; margin: 0; padding: 0;
        display: flex; flex-direction: column; gap: 4px;
      }
      .pc-signals__lanes li, .pc-signals__taxonomy li {
        display: grid; grid-template-columns: 34px 170px 1fr; align-items: baseline; gap: 8px;
        padding: 4px 8px; border-radius: 6px; font-size: 11.5px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-signals__taxonomy li { grid-template-columns: 170px 1fr; }
      .pc-signals__lanes li.is-live { color: var(--fg-dim, #b9d4e8); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
      .pc-signals__lanes li strong { font-weight: 740; font-variant-numeric: tabular-nums; text-align: right; }
      .pc-signals__lane { font-weight: 650; }
      .pc-signals__lanes li em { font-style: normal; font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-signals__lanes li p, .pc-signals__taxonomy li p {
        margin: 0; grid-column: 1 / -1; font-size: 10.5px; color: var(--fg-mute, #7f9bb4);
      }
      @media (min-width: 900px) {
        .pc-signals__lanes li p { grid-column: 3; }
        .pc-signals__taxonomy li p { grid-column: 2; }
      }
      .pc-signals__fed li {
        display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
        padding: 4px 8px; border-radius: 6px; font-size: 11px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-signals__fedwhen { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; min-width: 42px; }
      .pc-signals__fedchip {
        display: inline-flex; gap: 4px; padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); font-size: 10px;
      }
      .pc-signals__fedchip strong { font-weight: 740; font-variant-numeric: tabular-nums; }
      .pc-signals__fedout { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); margin-left: auto; white-space: nowrap; }
      .pc-signals__digest { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .pc-signals__digest li {
        display: flex; align-items: baseline; gap: 7px; padding: 3px 8px;
        border-radius: 6px; font-size: 11px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.10));
      }
      .pc-signals__digest li.is-new { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
      .pc-signals__digest li .pc-signals__fedchip { flex-shrink: 0; }
      .pc-signals__digest-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-signals__digest-none { margin: 2px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-signals__digest-standing summary {
        cursor: pointer; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); padding: 3px 2px;
      }
      .pc-signals__digest-standing[open] summary { margin-bottom: 4px; }
      `}</style>
    </section>
  );
}
