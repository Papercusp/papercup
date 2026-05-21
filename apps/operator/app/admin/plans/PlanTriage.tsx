'use client';

/**
 * PlanTriage — `view=triage`, the legacy-plan conversion screen (P-302).
 *
 * Lists every still-legacy plan file (no/invalid frontmatter), pre-fills
 * a proposed frontmatter mapping per row, lets the human edit + ratify,
 * and on submit calls `plans:set-frontmatter` once per ratified row — a
 * structured frontmatter writer, so conversion stays inside the safe
 * assisted-writers model (D-011, no whole-document rewrite). The verb
 * is `set-frontmatter`, not `promote` — `plans:promote` is a different
 * existing tool (promote a plan into a harness); see `plans-api.ts`.
 *
 * The per-row proposal here is a slug-derived heuristic (title from the
 * de-dated slug, `created` from the `-YYYY-MM-DD` suffix, status
 * `draft`). A richer agent-generated proposal can replace `proposeRow`
 * later without touching the table/submit machinery.
 *
 * Row state is transient mid-edit form data → useState, not nuqs
 * (per the project's state-placement rule). It's an override map:
 * displayed row = proposal ∪ user edits, so the async legacy list
 * needs no seeding effect.
 */

import { useMemo, useState } from 'react';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import {
  promotePlan,
  usePlanList,
  PROMOTABLE_PLAN_STATUSES,
  type PlanListRow,
  type PromotablePlanStatus,
} from './plans-api';

interface RowState {
  title: string;
  status: PromotablePlanStatus;
  created: string;
  owner: string;
  ratified: boolean;
}

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2})$/;

function proposeRow(plan: PlanListRow): RowState {
  const m = DATE_SUFFIX.exec(plan.slug);
  const created = m ? (m[1] ?? '') : new Date().toISOString().slice(0, 10);
  const base = plan.slug.replace(DATE_SUFFIX, '');
  const title =
    plan.title ??
    base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { title, status: 'draft', created, owner: '', ratified: false };
}

interface Props {
  onPick: (slug: string) => void;
}

export default function PlanTriage({ onPick }: Props) {
  const { data, loading, error, refresh } = usePlanList({
    includeArchived: true,
    includeLegacy: true,
  });
  const legacy = useMemo(
    () => (data?.plans ?? []).filter((p) => p.isLegacy),
    [data],
  );

  const [overrides, setOverrides] = useState<Record<string, Partial<RowState>>>({});
  const [results, setResults] = useState<Record<string, 'ok' | string>>({});
  const [submitting, setSubmitting] = useState(false);

  const rowOf = (plan: PlanListRow): RowState => ({
    ...proposeRow(plan),
    ...(overrides[plan.slug] ?? {}),
  });
  const patch = (slug: string, p: Partial<RowState>) =>
    setOverrides((o) => ({ ...o, [slug]: { ...o[slug], ...p } }));

  const ratifiedCount = legacy.filter((p) => rowOf(p).ratified).length;

  const submit = async () => {
    setSubmitting(true);
    const next: Record<string, 'ok' | string> = { ...results };
    for (const plan of legacy) {
      const row = rowOf(plan);
      if (!row.ratified) continue;
      try {
        const res = await promotePlan({
          slug: plan.slug,
          title: row.title.trim(),
          status: row.status,
          created: row.created.trim() || undefined,
          owner: row.owner.trim() || undefined,
        });
        next[plan.slug] =
          res && typeof res === 'object' && 'ok' in res && res.ok
            ? 'ok'
            : ((res as { error?: string }).error ?? 'unexpected response');
      } catch (e) {
        next[plan.slug] = e instanceof Error ? e.message : String(e);
      }
      setResults({ ...next });
    }
    setSubmitting(false);
    refresh(); // promoted plans drop out of the legacy filter
  };

  return (
    <div className="pc-triage">
      <header className="pc-triage__head">
        <div className="pc-triage__head-copy">
          <h2>Legacy-plan triage</h2>
          <p>
            Plans without valid frontmatter. Edit the proposed mapping,
            tick the rows to convert, then promote — each ratified row
            calls <code>plans:set-frontmatter</code>.
          </p>
        </div>
        <button
          type="button"
          className="pc-triage__submit"
          onClick={submit}
          disabled={submitting || ratifiedCount === 0}
        >
          {submitting ? 'Promoting…' : `Promote ${ratifiedCount} plan${ratifiedCount === 1 ? '' : 's'}`}
        </button>
      </header>

      {loading ? <p className="pc-plans__placeholder">Loading plans…</p> : null}
      {error ? (
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Failed to load plans:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && !legacy.length ? (
        <p className="pc-triage__empty">No legacy plans — every plan has valid frontmatter.</p>
      ) : null}

      {legacy.length > 0 ? (
        <table className="pc-triage__table">
          <thead>
            <tr>
              <th className="pc-triage__col-check" />
              <th>Plan file</th>
              <th>Title</th>
              <th>Status</th>
              <th>Created</th>
              <th>Owner</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {legacy.map((plan) => {
              const row = rowOf(plan);
              const result = results[plan.slug];
              const done = result === 'ok';
              return (
                <tr key={plan.slug} className={done ? 'is-done' : ''}>
                  <td className="pc-triage__col-check">
                    <Checkbox
                      checked={row.ratified}
                      disabled={done}
                      onChange={(checked) => patch(plan.slug, { ratified: checked })}
                      ariaLabel={`Ratify ${plan.slug}`}
                      className="pc-triage__checkbox"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="pc-triage__slug"
                      onClick={() => onPick(plan.slug)}
                    >
                      {plan.slug}
                    </button>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="pc-triage__input"
                      value={row.title}
                      disabled={done}
                      onChange={(e) => patch(plan.slug, { title: e.target.value })}
                    />
                  </td>
                  <td>
                    <Select
                      value={row.status}
                      disabled={done}
                      onChange={(status) =>
                        patch(plan.slug, { status: status as PromotablePlanStatus })
                      }
                      options={PROMOTABLE_PLAN_STATUSES.map((s) => ({ value: s, label: s }))}
                      ariaLabel={`Status for ${plan.slug}`}
                      triggerClassName="pc-triage__select"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="pc-triage__input pc-triage__input--date"
                      value={row.created}
                      disabled={done}
                      placeholder="YYYY-MM-DD"
                      onChange={(e) => patch(plan.slug, { created: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="pc-triage__input"
                      value={row.owner}
                      disabled={done}
                      placeholder="(optional)"
                      onChange={(e) => patch(plan.slug, { owner: e.target.value })}
                    />
                  </td>
                  <td className="pc-triage__result">
                    {result === undefined ? (
                      <span className="pc-triage__result--pending">—</span>
                    ) : done ? (
                      <span className="pc-triage__result--ok">promoted</span>
                    ) : (
                      <span className="pc-triage__result--err" title={result}>
                        {result}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
