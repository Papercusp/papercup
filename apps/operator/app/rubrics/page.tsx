'use client';

/**
 * /rubrics — every rubric + its grading history at a glance
 * (rubrics-tab-scorecard-ui-2026-07-09 P-001, owner ask 2026-07-09).
 * Deliberately minimal, mirroring /fleet-status: the panel, reachable at
 * this route. Data rides `rubrics.list` (@papercusp/sync); drill-down into
 * per-rubric history + single-scorecard detail lands as P-002/P-003 on the
 * already-live scorecards.list / rubrics.trend queries.
 */
import RubricsPanel from '@/app/_components/RubricsPanel';

export default function RubricsPage() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Rubrics</h1>
      <RubricsPanel />
    </div>
  );
}
