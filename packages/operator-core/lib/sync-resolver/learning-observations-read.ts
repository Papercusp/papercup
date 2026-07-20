/**
 * The compute behind the `learning.observations` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer; see
 * derived-reads/producers.ts) and the resolver's live inline path for NON-default
 * variants (a state filter / custom limit) run the EXACT same code and can never
 * drift (whole-app-sync-payload-audit phase2 P-005).
 *
 * The Observations pane is a BROWSE feed of pre-idea sensor readings from the
 * turn-end reflection step (OBSERVATION_TOPIC lane) — no ranking/triage. The
 * measured 0.22s / 152KB read was listIssues + countIssues + a per-row map/sort
 * over the whole lane on every mount; the 152KB is the per-observation `body`.
 */
import { attachListMeta } from './list-meta';

export interface LearningObservationsArgs {
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
}

export interface LearningObservationRow {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}

/** Build the `learning.observations` rows (newest-first) with list `_meta` (total). */
export async function computeLearningObservations(a: LearningObservationsArgs): Promise<LearningObservationRow[]> {
  const { listIssues, countIssues } = await import('../issues-engineer');
  const { OBSERVATION_TOPIC } = await import('../harness/improvements/read-items');
  const filter = {
    topic: OBSERVATION_TOPIC,
    ...(a.state ? { state: a.state } : {}),
  };
  const [issues, total] = await Promise.all([listIssues({ ...filter, limit: a.limit ?? 200 }), countIssues(filter)]);
  const rows: LearningObservationRow[] = issues
    .map((i) => {
      const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
      const obs = p.observation && typeof p.observation === 'object' ? (p.observation as Record<string, unknown>) : {};
      const refs = Array.isArray(obs.refs) ? obs.refs.filter((r): r is string => typeof r === 'string') : [];
      return {
        id: i.id,
        title: i.title,
        body: i.body ?? null,
        kind: typeof obs.kind === 'string' ? obs.kind : null,
        scope: typeof obs.scope === 'string' ? obs.scope : (i.scope ?? null),
        confidence: typeof obs.confidence === 'string' ? obs.confidence : null,
        refs,
        sourceRole: typeof p.sourceRole === 'string' ? p.sourceRole : null,
        createdAt: i.createdAt,
      };
    })
    .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  return attachListMeta(rows, { total });
}
