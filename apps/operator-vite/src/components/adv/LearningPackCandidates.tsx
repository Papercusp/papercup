/**
 * LearningPackCandidates — the fleet→pack candidate review strip in the
 * Learnings view (self-improvement-consume-edges-2026-06-12 P-032 / B-11).
 *
 * Pending candidates are cross-hive recurring lessons staged by the
 * recurrence-escalation loop (`learningPacks.candidates` sync query) — each
 * carries provenance (signature, scopes, recurrence count, source items) and
 * waits for the OWNER: adopt writes it into the fleet-lessons pack (the pack
 * version bumps, so every hive carrying the pack lights `updateAvailable`
 * and adopts through the normal install/upgrade conflict review), dismiss is
 * terminal. Nothing here ever touches a hive's memory pool directly.
 *
 * Renders nothing when the queue is empty — the parent owns the layout.
 */
import { useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { Inbox } from "lucide-react";
import type { LearningPackCandidate } from "@papercusp/operator-core/lib/learning-packs/candidates";
import { Tooltip } from "@/app/harness/Tooltip";
import { useLexicon } from "@/lib/useLexicon";
import { LearningDisclosure } from "./LearningVisuals";

const actionBtn: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg-dim)",
  cursor: "pointer",
  fontSize: 11,
  padding: "1px 7px",
};

export default function LearningPackCandidates() {
  const t = useLexicon();
  const sync = useSyncQuery<LearningPackCandidate>({
    queryName: "learningPacks.candidates",
    args: {},
    staleTime: 30_000,
  });
  const pending = sync.data ?? [];

  // Which candidate's draft is expanded — URL state (agents drive review via
  // ui:dispatch; deep-linkable).
  const [lcand, setLcand] = useQueryState(
    "lcand",
    parseAsString.withDefault(""),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [adoptedNote, setAdoptedNote] = useState("");

  const decide = async (
    c: LearningPackCandidate,
    action: "adopt" | "dismiss",
  ) => {
    setError("");
    setAdoptedNote("");
    setBusy(c.id);
    try {
      const res = await fetch("/api/learning-packs/candidate-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        error?: string;
        packId?: string;
        packVersion?: string;
      };
      if (!res.ok || data.ok === false) {
        setError(data.error ?? data.reason ?? `HTTP ${res.status}`);
      } else if (action === "adopt" && data.packId) {
        setAdoptedNote(
          `Adopted into ${data.packId} v${data.packVersion ?? "?"} — hives with the pack installed now show an update to review; others can install it from "add a pack".`,
        );
      }
    } catch (e) {
      setError((e as Error).message ?? "network error");
    } finally {
      setBusy("");
      sync.invalidate();
    }
  };

  const visible = pending.slice(0, 3);
  const remaining = pending.slice(3);
  const renderCandidate = (c: LearningPackCandidate) => (
    <div key={c.id} className="pc-pack-candidates__row">
      <div className="pc-pack-candidates__main">
        <strong>{c.title}</strong>
        <span
          title={`Recurred ${c.recurrenceCount}× across ${c.scopes.join(", ")}${c.sourceItemIds.length > 0 ? ` · from ${c.sourceItemIds.join(", ")}` : ""}`}
        >
          {c.recurrenceCount}× · {c.scopes.length} scope
          {c.scopes.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          style={actionBtn}
          onClick={() => void setLcand(lcand === c.id ? "" : c.id)}
          aria-expanded={lcand === c.id}
        >
          {lcand === c.id ? "hide draft" : "view draft"}
        </button>
        <Tooltip
          label={`Write this lesson into the fleet-lessons pack (${t("pot", { plural: true, lower: true })} adopt it through the pack update review)`}
        >
          <button
            type="button"
            style={{
              ...actionBtn,
              borderColor: "var(--accent)",
              color: "var(--accent)",
            }}
            disabled={busy === c.id}
            onClick={() => void decide(c, "adopt")}
          >
            adopt
          </button>
        </Tooltip>
        <Tooltip label="Dismiss permanently — this lesson's signature never re-files">
          <button
            type="button"
            style={actionBtn}
            disabled={busy === c.id}
            onClick={() => void decide(c, "dismiss")}
          >
            dismiss
          </button>
        </Tooltip>
      </div>
      {lcand === c.id ? (
        <div className="pc-pack-candidates__draft">{c.draftText}</div>
      ) : null}
    </div>
  );

  if (pending.length === 0 && !error && !adoptedNote) return null;

  return (
    <div
      className="pc-pack-candidates"
      data-testid="pack-candidates"
      aria-label="Fleet lesson candidates awaiting owner review"
    >
      <p className="pc-pack-candidates__head">
        <Inbox size={13} aria-hidden /> Fleet lesson candidates
        <span>{pending.length}</span>
      </p>
      {visible.map(renderCandidate)}
      {remaining.length > 0 ? (
        <LearningDisclosure label="More candidates" count={remaining.length}>
          {remaining.map(renderCandidate)}
        </LearningDisclosure>
      ) : null}
      {adoptedNote ? (
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 11.5,
            color: "var(--good, #34d399)",
          }}
        >
          {adoptedNote}
        </p>
      ) : null}
      {error ? (
        <p
          className="pc-learning__empty"
          role="alert"
          style={{ margin: "6px 0 0" }}
        >
          Candidate action failed: {error}
        </p>
      ) : null}
      <style>{`
        .pc-pack-candidates { border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 9px; padding: 8px 11px; background: color-mix(in srgb, var(--accent) 4%, var(--bg-2)); }
        .pc-pack-candidates__head { min-height: 24px; display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; font-weight: 680; }
        .pc-pack-candidates__head > span { margin-left: auto; border-radius: 999px; padding: 1px 7px; background: color-mix(in srgb, var(--accent) 13%, transparent); color: var(--accent); font-size: 10px; font-variant-numeric: tabular-nums; }
        .pc-pack-candidates__row { border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); padding: 5px 0; font-size: 11.5px; }
        .pc-pack-candidates__main { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto auto auto; align-items: center; gap: 7px; }
        .pc-pack-candidates__main > strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
        .pc-pack-candidates__main > span { color: var(--fg-mute); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .pc-pack-candidates__draft { margin-top: 5px; padding: 6px 8px; border-radius: 5px; background: var(--bg-1); white-space: pre-wrap; }
        @media (max-width: 720px) { .pc-pack-candidates__main { grid-template-columns: minmax(160px, 1fr) auto auto auto; } .pc-pack-candidates__main > span { grid-column: 1 / -1; grid-row: 2; } }
      `}</style>
    </div>
  );
}
