/**
 * MemoryHealthCard — the Knowledge sub-view's memory-health strip
 * (self-improvement-consume-edges-2026-06-12 P-031 / B-10, EI-366).
 *
 * Renders the extended MemoryHealth shape from `learning.knowledge`:
 * store counts (honest — entity rows are excluded from `memories`),
 * the feedback pulse, and the new recall-quality signals (zero-hit
 * rate + top-score distribution) that make "no relevant memory for
 * this turn" distinguishable from "the index is degraded". A fragment
 * chip appears ONLY when entity-store leakage recurs — it is the
 * EI-366 regression canary and should never render.
 *
 * Pure presentational: the parent (KnowledgeView in LearningTab.tsx —
 * a multi-brief hotspot) passes the snapshot down and keeps its own
 * diff to an import + one render line. Styles ride the existing
 * `.pc-learning__flow*` classes from LearningTab's style block.
 */
import { Activity, AlertTriangle, Brain, Gauge, Radar } from 'lucide-react';
import type { MemoryHealth } from '@papercusp/operator-core/lib/memory/knowledge-read';

function fmtScore(v: number | null): string {
  return v == null ? '—' : v.toFixed(2);
}

export default function MemoryHealthCard({ memory }: { memory: MemoryHealth | null }) {
  if (!memory) {
    return (
      <div className="pc-learning__flow" aria-label="Memory health">
        <span className="pc-learning__flowchip">
          <Brain size={11} aria-hidden />
          memory health unavailable
        </span>
      </div>
    );
  }

  const zeroHitPct = memory.recalls7d > 0 ? `${Math.round(memory.zeroHitRate7d * 100)}%` : '—';
  // Some zero-hits are healthy (off-topic turns). A majority of recalls
  // returning nothing, on real volume, is the degradation signal.
  const zeroHitWorrying = memory.recalls7d >= 10 && memory.zeroHitRate7d >= 0.5;

  return (
    <div className="pc-learning__flow" aria-label="Memory health">
      <span
        className="pc-learning__flowchip"
        title={`The shared canonical memory store agents recall from at session start. ${memory.entityRows} mem0 entity-linking rows share the table but are segregated out of recall and this count (EI-366).`}
      >
        <Brain size={11} aria-hidden />
        <strong>{memory.totalMemories}</strong> memories
      </span>
      <span
        className="pc-learning__flowchip"
        title="Feedback events (edits, forgets, corrections) against memories in the trailing 30 days — zero means the store is written but never corrected. Deletions feed recall back-pressure: deleted content is suppressed from injection and demoted in search."
      >
        <Activity size={11} aria-hidden />
        <strong>{memory.feedback30d}</strong> feedback events
        <em>30d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Memory recalls recorded in the last 7 days across both surfaces — memory:search (pull) and the pre-turn auto-injection (push)."
      >
        <Radar size={11} aria-hidden />
        <strong>{memory.recalls7d}</strong> recalls
        <em>7d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Share of recalls returning nothing, 7 days. Some zero-hits are healthy (off-topic turns have no relevant memory); a sustained majority alongside a collapsing score distribution means the index is degraded, not the questions."
      >
        <span
          className={`pc-learning__flownet ${zeroHitWorrying ? 'pc-learning__flownet--warn' : 'pc-learning__flownet--flat'}`}
        >
          {zeroHitPct}
        </span>
        zero-hit
        <em>7d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Median / 90th-percentile top relevance score across non-empty recalls, 7 days. A p50 collapsing toward the 0.45 injection floor means recall quality is degrading even while hits still return."
      >
        <Gauge size={11} aria-hidden />
        score p50 <strong>{fmtScore(memory.topScoreP50)}</strong> · p90 <strong>{fmtScore(memory.topScoreP90)}</strong>
      </span>
      {memory.fragmentHits7d > 0 ? (
        <span
          className="pc-learning__flowchip"
          style={{ borderColor: 'rgba(248, 113, 113, 0.5)', color: '#f87171' }}
          title="Entity-store fragments (entityType payloads) leaked into recall results in the last 7 days. This is the EI-366 regression canary — it must be zero; a non-zero value means the canonical-store segregation broke."
        >
          <AlertTriangle size={11} aria-hidden />
          <strong>{memory.fragmentHits7d}</strong> fragment hits
          <em>7d</em>
        </span>
      ) : null}
    </div>
  );
}
