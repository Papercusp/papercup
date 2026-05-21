'use client';

/**
 * PlanFilters — controls for PlanRail's filter set.
 *
 * P-103 deliverable. Every filter is a nuqs URL key (D-006) so the
 * state is shareable and survives reload. PlanRail reads the same
 * keys directly; this component owns the writes.
 *
 * Filters:
 *   - status:          pStatus       — plan-level status enum
 *   - date:            pDate         — `updated` recency window
 *   - owner:           pOwner        — frontmatter owner
 *   - has-needs-human: pInbox        — at least one needs-human item
 *   - has-actionable:  pActionable   — at least one effective-todo item
 *   - archived:        pArchived     — show archived plans
 *   - hide-legacy:     pHideLegacy   — drop frontmatter-less plans
 *
 * The owner dropdown is populated from the plan list that PlansClient
 * already fetches for the rail and overview metrics. Keeping a single
 * read avoids duplicate calls while search/filter interactions stay
 * client-side and instant.
 */

import { useMemo } from 'react';
import { useQueryState, parseAsBoolean, parseAsString, parseAsStringEnum } from 'nuqs';
import { type AsyncResult, type PlanListRow, type PlanStatus } from './plans-api';
import { Select } from '@/app/harness/Select';

const STATUSES: PlanStatus[] = [
  'active',
  'draft',
  'blocked',
  'shipped',
  'superseded',
  'unknown',
];

export type DateWindow = 'today' | '7d' | '30d';
const DATE_WINDOWS: Array<{ id: DateWindow; label: string }> = [
  { id: 'today', label: 'today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

function dateWindowLabel(window: DateWindow): string {
  return DATE_WINDOWS.find((d) => d.id === window)?.label ?? window;
}

export default function PlanFilters({ list }: { list: AsyncResult<{ plans: PlanListRow[] }> }) {
  const [status, setStatus] = useQueryState(
    'pStatus',
    parseAsStringEnum<PlanStatus>(STATUSES),
  );
  const [dateWindow, setDateWindow] = useQueryState(
    'pDate',
    parseAsStringEnum<DateWindow>(['today', '7d', '30d']),
  );
  const [owner, setOwner] = useQueryState('pOwner', parseAsString);
  const [archived, setArchived] = useQueryState(
    'pArchived',
    parseAsBoolean.withDefault(false),
  );
  const [hideLegacy, setHideLegacy] = useQueryState(
    'pHideLegacy',
    parseAsBoolean.withDefault(false),
  );
  const [inbox, setInbox] = useQueryState(
    'pInbox',
    parseAsBoolean.withDefault(false),
  );
  const [actionable, setActionable] = useQueryState(
    'pActionable',
    parseAsBoolean.withDefault(false),
  );

  // Distinct owners across all plans, for the owner dropdown.
  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const p of list.data?.plans ?? []) {
      if (p.owner) set.add(p.owner);
    }
    return [...set].sort();
  }, [list.data]);

  const activeCount =
    (status ? 1 : 0) +
    (dateWindow ? 1 : 0) +
    (owner ? 1 : 0) +
    (archived ? 1 : 0) +
    (hideLegacy ? 1 : 0) +
    (inbox ? 1 : 0) +
    (actionable ? 1 : 0);

  const activeTokens = [
    status ? { key: 'status', label: `status: ${status}`, clear: () => setStatus(null) } : null,
    dateWindow ? { key: 'date', label: `updated: ${dateWindowLabel(dateWindow)}`, clear: () => setDateWindow(null) } : null,
    owner ? { key: 'owner', label: `owner: ${owner}`, clear: () => setOwner(null) } : null,
    inbox ? { key: 'needs-human', label: 'has needs-human', clear: () => setInbox(false) } : null,
    actionable ? { key: 'actionable', label: 'has actionable', clear: () => setActionable(false) } : null,
    archived ? { key: 'archived', label: 'show archived', clear: () => setArchived(false) } : null,
    hideLegacy ? { key: 'hide-legacy', label: 'hide legacy', clear: () => setHideLegacy(false) } : null,
  ].flatMap((token) => (token ? [token] : []));

  const clearAll = () => {
    setStatus(null);
    setDateWindow(null);
    setOwner(null);
    setArchived(false);
    setHideLegacy(false);
    setInbox(false);
    setActionable(false);
  };

  return (
    <div className="pc-filters" aria-label="Plan filters">
      <div className="pc-filters__head">
        <div>
          <span className="pc-filters__kicker">Filters</span>
          <p>Compose search with status, owner, recency, and queue signals.</p>
        </div>
        {activeCount > 0 ? (
          <button
            type="button"
            className="pc-filters__clear"
            onClick={clearAll}
          >
            Clear all
          </button>
        ) : null}
      </div>

      <div className="pc-filters__selects">
        <Select
          value={status ?? '_all'}
          onChange={(v) => setStatus(v === '_all' ? null : (v as PlanStatus))}
          options={[
            { value: '_all', label: 'All statuses' },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
          ariaLabel="Plan status filter"
          triggerClassName="pc-filters__select"
        />

        {owners.length > 1 ? (
          <Select
            value={owner ?? '_all'}
            onChange={(v) => setOwner(v === '_all' ? null : v)}
            options={[
              { value: '_all', label: 'All owners' },
              ...owners.map((o) => ({ value: o, label: o })),
            ]}
            ariaLabel="Plan owner filter"
            triggerClassName="pc-filters__select"
          />
        ) : null}
      </div>

      <div className="pc-filters__dates" role="group" aria-label="Updated within">
        {DATE_WINDOWS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`pc-filter-chip ${dateWindow === d.id ? 'is-on' : ''}`}
            aria-pressed={dateWindow === d.id}
            onClick={() => setDateWindow(dateWindow === d.id ? null : d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="pc-filters__toggles">
        <Toggle on={inbox} onChange={setInbox} label="needs human" />
        <Toggle on={actionable} onChange={setActionable} label="actionable" />
        <Toggle on={archived} onChange={setArchived} label="archived" />
        <Toggle on={hideLegacy} onChange={setHideLegacy} label="hide legacy" />
      </div>

      {activeTokens.length > 0 ? (
        <div className="pc-filters__active" aria-label="Active plan filters">
          {activeTokens.map((token) => (
            <button
              key={token.key}
              type="button"
              className="pc-filters__token"
              onClick={token.clear}
              aria-label={`Clear ${token.label} filter`}
            >
              <span>{token.label}</span>
              <strong aria-hidden="true">×</strong>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`pc-filter-toggle ${on ? 'is-on' : ''}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/**
 * Shared date-window predicate — PlanRail imports this so the filter
 * logic lives in exactly one place.
 */
export function withinDateWindow(updated: string | null, window: DateWindow | null): boolean {
  if (!window) return true;
  if (!updated) return false;
  const t = Date.parse(updated);
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (window === 'today') return ageMs < day;
  if (window === '7d') return ageMs < day * 7;
  return ageMs < day * 30;
}
