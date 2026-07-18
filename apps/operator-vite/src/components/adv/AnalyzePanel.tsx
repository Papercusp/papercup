/**
 * AnalyzePanel — the Analyze-stage "what happens inside idea generation?" view
 * (learning-tab-visibility-2026-07-18 P-009 / D-001, owner ask 2026-07-18:
 * "I want the user to be able to see the advanced things happening as part of
 * idea generation, I dont want to hide it").
 *
 * One disclosure per fired cycle (newest first, `learning.analyze` snapshot —
 * migration 623 stage artifacts joined to tick economics + routed rows):
 *
 *   1. Ideation roster — per-slot ideator outcomes + the raw per-ideator
 *      ideas, each with the creative lens it rode.
 *   2. Adversarial critique — every idea's keep/moonshot/reject verdict,
 *      novelty/feasibility scores, and the critics' notes.
 *   3. Fusions — debate/recombine proposals with their source-idea chains and
 *      the routed artifact each became (the same refs the Ideas view traces).
 *
 * Self-contained (own sync query + pc-analyze__* styles, the panel idiom).
 * Cycle bodies live inside Radix Collapsible (LearningDisclosure) so closed
 * cycles stay UNMOUNTED — 8 full pipelines never render at once.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { Workflow, RefreshCw } from "lucide-react";
import type {
  AnalyzeSnapshot,
  AnalyzeCycle,
} from "@papercusp/operator-core/lib/sync-resolver/learning-analyze-read";
import { useLexicon } from "@/lib/useLexicon";
import {
  LearningDisclosure,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";

function cycleWhen(at: string | null): string {
  const ms = at ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** Compact funnel summary for the cycle disclosure label. */
function cycleSummary(c: AnalyzeCycle): string {
  const kept = c.scored.filter((s) => s?.verdict === "keep").length;
  const moon = c.scored.filter((s) => s?.verdict === "moonshot").length;
  const parts = [
    `${c.ideas.length} ideas`,
    c.scored.length > 0 ? `${kept} keep · ${moon} moonshot` : null,
    `${c.proposals.length} fusions`,
    `${c.routed.length} routed`,
  ].filter(Boolean);
  const spend = c.tick?.spendUsd;
  return `${cycleWhen(c.at)} — ${parts.join(" → ")}${spend != null ? ` · $${spend.toFixed(2)}` : ""}`;
}

export function AnalyzePanel({
  onStatus,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
} = {}) {
  const t = useLexicon();
  const sync = useSyncQuery<AnalyzeSnapshot>({
    queryName: "learning.analyze",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const cycles = snap?.cycles ?? [];

  const status: "neutral" | "good" | "warn" | "bad" = sync.error
    ? "bad"
    : cycles.length === 0
      ? "neutral"
      : "good";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  return (
    <section
      className="pc-learning__section pc-analyze"
      aria-label="Idea-generation pipeline per cycle"
    >
      <LearningPageHeader
        icon={Workflow}
        title="Pipeline"
        question={`What actually happens inside ${t("scout")} idea generation — per fired cycle?`}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload pipeline artifacts"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      {sync.error ? (
        <LearningVisualError
          title="The pipeline read failed"
          onRetry={() => sync.invalidate()}
        />
      ) : sync.loading && !snap ? (
        <p className="pc-learning__quietempty">Loading cycle artifacts…</p>
      ) : cycles.length === 0 ? (
        <LearningVisualEmpty
          icon={Workflow}
          title={`No cycle artifacts persisted yet — they land when the next ${t("scout")} cycle fires with the stage-artifact persist live on this host.`}
        />
      ) : (
        <div className="pc-analyze__cycles">
          {cycles.map((c, i) => (
            <LearningDisclosure
              key={c.cycleId}
              label={cycleSummary(c)}
              defaultOpen={i === 0}
            >
              <CycleDetail cycle={c} />
            </LearningDisclosure>
          ))}
        </div>
      )}
      <style>{`
      .pc-analyze__cycles { display: flex; flex-direction: column; gap: 6px; }
      .pc-analyze__sectionhead {
        display: flex; align-items: baseline; gap: 10px; margin: 12px 2px 6px;
      }
      .pc-analyze__sectionhead h4 {
        margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-analyze__sectionhead > span { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-analyze__slots { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
      .pc-analyze__slots li {
        display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px;
        border-radius: 999px; font-size: 10.5px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-analyze__slots li.is-failed { color: var(--fg-mute, #7f9bb4); border-style: dashed; }
      .pc-analyze__slots li em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-analyze__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-analyze__list li {
        padding: 5px 9px; border-radius: 6px; font-size: 11.5px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-analyze__row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
      .pc-analyze__row strong { font-weight: 650; }
      .pc-analyze__chip {
        display: inline-flex; gap: 4px; padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); font-size: 10px;
        color: var(--fg-mute, #7f9bb4); white-space: nowrap;
      }
      .pc-analyze__chip.is-keep { color: var(--ok, #6ee7a2); border-color: color-mix(in srgb, var(--ok, #6ee7a2) 40%, transparent); }
      .pc-analyze__chip.is-moonshot { color: var(--accent, #7dd3fc); border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent); }
      .pc-analyze__chip.is-reject { opacity: 0.75; }
      .pc-analyze__scores { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-analyze__body { margin: 3px 0 0; font-size: 10.8px; color: var(--fg-mute, #7f9bb4); }
      .pc-analyze__mech { margin: 2px 0 0; font-size: 10.8px; color: var(--fg-mute, #7f9bb4); font-style: italic; }
      .pc-analyze__exp {
        margin: 4px 0 0; padding: 4px 8px; border-radius: 5px; font-size: 10.5px;
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.18));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-analyze__exp b { font-weight: 650; }
      .pc-analyze__sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
      .pc-analyze__routedref { color: var(--ok, #6ee7a2); }
      `}</style>
    </section>
  );
}

function CycleDetail({ cycle }: { cycle: AnalyzeCycle }) {
  const t = useLexicon();
  const ideaTitle = (id: string): string =>
    cycle.ideas.find((idea) => idea?.id === id)?.title ?? id;
  return (
    <div>
      <div className="pc-analyze__sectionhead">
        <h4>Divergent generation</h4>
        <span>
          each roster slot rides one creative lens; raw → survived the
          grounding filter
        </span>
      </div>
      {cycle.ideatorSlots.length > 0 ? (
        <ul className="pc-analyze__slots" aria-label="Ideator roster slots">
          {cycle.ideatorSlots.map((s, i) => (
            <li
              key={`${s?.lens ?? "slot"}-${i}`}
              className={s?.ok === false ? "is-failed" : undefined}
              title={s?.error ?? undefined}
            >
              <strong>{s?.lens ?? "?"}</strong>
              <em>
                {s?.ok === false
                  ? `failed${s?.error ? " — hover" : ""}`
                  : `${s?.raw ?? 0} raw → ${s?.produced ?? 0}`}
              </em>
            </li>
          ))}
        </ul>
      ) : null}
      {cycle.ideas.length > 0 ? (
        <ul className="pc-analyze__list" aria-label="Raw ideas by ideator">
          {cycle.ideas.map((idea, i) => (
            <li key={idea?.id ?? i}>
              <div className="pc-analyze__row">
                <span className="pc-analyze__chip">{idea?.lens ?? "?"}</span>
                <strong>{idea?.title ?? idea?.id ?? "(untitled idea)"}</strong>
              </div>
              {idea?.body ? <p className="pc-analyze__body">{idea.body}</p> : null}
              {idea?.mechanism ? (
                <p className="pc-analyze__mech">{idea.mechanism}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pc-learning__quietempty">
          No raw ideas persisted for this cycle.
        </p>
      )}

      <div className="pc-analyze__sectionhead">
        <h4>Adversarial critique</h4>
        <span>
          search-first novelty + feasibility critics bucket every idea
        </span>
      </div>
      {cycle.scored.length > 0 ? (
        <ul className="pc-analyze__list" aria-label="Critique verdicts">
          {cycle.scored.map((s, i) => (
            <li key={s?.idea?.id ?? i}>
              <div className="pc-analyze__row">
                <span
                  className={`pc-analyze__chip is-${s?.verdict ?? "reject"}`}
                >
                  {s?.verdict ?? "?"}
                </span>
                <strong>{s?.idea?.title ?? s?.idea?.id ?? "(idea)"}</strong>
                <span className="pc-analyze__scores">
                  novelty {Math.round((s?.novelty ?? 0) * 100)} · feasibility{" "}
                  {Math.round((s?.feasibility ?? 0) * 100)}
                </span>
              </div>
              {s?.notes ? <p className="pc-analyze__body">{s.notes}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pc-learning__quietempty">
          No critique verdicts persisted for this cycle.
        </p>
      )}

      <div className="pc-analyze__sectionhead">
        <h4>Debate + recombine</h4>
        <span>
          survivors fuse into proposals; each carries a falsifiable first
          experiment and routes into the {t("pot", { lower: true })}'s work
        </span>
      </div>
      {cycle.proposals.length > 0 ? (
        <ul className="pc-analyze__list" aria-label="Recombined proposals">
          {cycle.proposals.map((p, i) => {
            const routed = cycle.routed.find((r) => r.ideaId === p?.id);
            return (
              <li key={p?.id ?? i}>
                <div className="pc-analyze__row">
                  <strong>{p?.framing ?? p?.id ?? "(proposal)"}</strong>
                  {routed ? (
                    <span
                      className="pc-analyze__chip pc-analyze__routedref"
                      title={routed.title ?? undefined}
                    >
                      routed → {routed.rail}: {routed.routedRef}
                    </span>
                  ) : (
                    <span className="pc-analyze__chip">not routed</span>
                  )}
                </div>
                {p?.mechanism ? (
                  <p className="pc-analyze__body">{p.mechanism}</p>
                ) : null}
                {p?.whyNew ? (
                  <p className="pc-analyze__mech">Why new: {p.whyNew}</p>
                ) : null}
                {p?.bet ? (
                  <p className="pc-analyze__mech">The bet: {p.bet}</p>
                ) : null}
                {p?.cheapExperiment ? (
                  <div className="pc-analyze__exp">
                    <b>Cheap experiment:</b> {p.cheapExperiment.hypothesis}{" "}
                    <b>Method:</b> {p.cheapExperiment.method}{" "}
                    <b>Falsified by:</b> {p.cheapExperiment.falsifiableSignal}
                  </div>
                ) : null}
                {Array.isArray(p?.sourceIdeaIds) &&
                p.sourceIdeaIds.length > 0 ? (
                  <div
                    className="pc-analyze__sources"
                    aria-label="Fused source ideas"
                  >
                    {p.sourceIdeaIds.map((id) => (
                      <span key={id} className="pc-analyze__chip" title={id}>
                        ⤷ {ideaTitle(id)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pc-learning__quietempty">
          No proposals persisted for this cycle
          {cycle.tick?.stop ? ` (cycle stop: ${cycle.tick.stop})` : ""}.
        </p>
      )}
    </div>
  );
}
