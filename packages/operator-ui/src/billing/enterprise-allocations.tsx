'use client';

/** P014 finance surface. Authority, funding and accounting stay in hosted billing. */
import { useEffect, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { HostedBillingAllocationFinance } from '@papercusp/operator-core/lib/endpoint-route/routes/hosted-billing/index';
import type { HostedAllocationAccountingRow, HostedAllocationPosition, HostedOutcomeCostSummary, KnownOrUnknown } from '@papercusp/operator-core/lib/auth/hosted/billing/allocation-store';

const CLASSES = ['model', 'hosting', 'subscription'] as const;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const ENDPOINT = '/api/hosted/billing/usage?view=allocations';
export interface EnterpriseFinanceAccount {
  readonly controlWorkspaceId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
}

/** Decimal input is converted without floating point rounding or exponent syntax. */
export function allocationLimitMicros(value: string): number | null {
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}
function decimal(micros: number): string {
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`;
}
function money(micros: number | null | undefined): string {
  return typeof micros === 'number' && Number.isSafeInteger(micros) && micros >= 0
    ? `$${decimal(micros)}` : 'Unknown';
}
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function validSnapshot(value: unknown, account: EnterpriseFinanceAccount, month: string): value is HostedBillingAllocationFinance {
  if (!value || typeof value !== 'object') return false;
  const data = value as HostedBillingAllocationFinance;
  const scope = (organization: HostedBillingAllocationFinance['organization'] | undefined) =>
    organization?.controlWorkspaceId === account.controlWorkspaceId && organization.organizationId === account.organizationId;
  return scope(data.organization) && scope(data.accounting?.organization)
    && data.report?.month === month && data.accounting?.month === month && data.accounting.currency === 'USD'
    && Array.isArray(data.report.outcomes) && Array.isArray(data.accounting.rows)
    && Array.isArray(data.accounting.outcomes) && Array.isArray(data.accounting.gaps)
    && CLASSES.every(costClass => {
      const group = data.report.byCostClass?.[costClass];
      return group && Array.isArray(group.allocations) && group.allocations.every(position =>
        typeof position.allocationId === 'string' && ['organization', 'department', 'project'].includes(position.level)
        && ['capMicros', 'maxUnreconciledMicros', 'committedMicros', 'unreconciledMicros', 'providerFinalMicros', 'availableMicros']
          .every(key => amount(position[key as keyof HostedAllocationPosition])))
        && amount(group.committedMicros) && amount(group.unreconciledMicros) && amount(group.providerFinalMicros);
    });
}
type State = { kind: 'loading' | 'unavailable' | 'forbidden' } | { kind: 'ready'; data: HostedBillingAllocationFinance };

const positions: ColumnDef<HostedAllocationPosition>[] = [
  { key: 'allocation', header: 'Allocation', width: 2, render: ({ row }) => `${row.allocationId} (${row.level})` },
  { key: 'cap', header: 'Limit', width: 1, render: ({ row }) => money(row.capMicros) },
  { key: 'committed', header: 'Committed', width: 1, render: ({ row }) => money(row.committedMicros) },
  { key: 'unreconciled', header: 'Unreconciled', width: 1, render: ({ row }) => money(row.unreconciledMicros) },
  { key: 'final', header: 'Provider final', width: 1, render: ({ row }) => money(row.providerFinalMicros) },
  { key: 'available', header: 'Available', width: 1, render: ({ row }) => money(row.availableMicros) },
];
const outcomes: ColumnDef<HostedOutcomeCostSummary>[] = [
  { key: 'allocation', header: 'Allocation', width: 2, render: ({ row }) => row.allocationId },
  { key: 'accepted', header: 'Accepted outcomes', width: 1, render: ({ row }) => row.byState.accepted },
  { key: 'cost', header: 'Cost per accepted outcome', width: 2, render: ({ row }) =>
    row.costPerAcceptedOutcomeMicros === null ? `Unknown: ${row.costPerAcceptedUnknownReason ?? 'not measured'}` : money(row.costPerAcceptedOutcomeMicros) },
  { key: 'review', header: 'Review effort', width: 2, render: ({ row }) =>
    `${row.reviewEffortKnownSeconds} recorded seconds; ${row.reviewEffortUnknown} unknown` },
  { key: 'rework', header: 'Rework', width: 2, render: ({ row }) =>
    `${row.reworkKnownTotal} recorded; ${row.reworkUnknown} unknown` },
  { key: 'evidence', header: 'Evidence', width: 2, render: ({ row }) => row.evidenceClasses.join(', ') },
];
const measuredCost = (cost: KnownOrUnknown<number>) => 'value' in cost ? money(cost.value) : `Unknown: ${cost.unknownReason}`;
const accountingColumns: ColumnDef<HostedAllocationAccountingRow>[] = [
  { key: 'reservation', header: 'Reservation', width: 2, render: ({ row }) => row.reservationId },
  { key: 'allocation', header: 'Allocation', width: 2, render: ({ row }) => row.allocationPath.join(' / ') },
  { key: 'class', header: 'Cost class', width: 1, render: ({ row }) => row.costClass },
  { key: 'source', header: 'Cost source', width: 1, render: ({ row }) => row.costSource },
  { key: 'observed', header: 'Observed cost', width: 2, render: ({ row }) => measuredCost(row.observedCostMicros) },
  { key: 'final', header: 'Provider-final cost', width: 2, render: ({ row }) => measuredCost(row.providerFinalCostMicros) },
];

/** The key clears data, drafts and requests synchronously on tenant/session/month changes. */
export function EnterpriseAllocationPanel({ account, canManage }: {
  readonly account: EnterpriseFinanceAccount | null;
  readonly canManage: boolean;
}) {
  const [month, setMonth] = useQueryState('financeMonth', parseAsString.withDefault(new Date().toISOString().slice(0, 7)));
  return <section aria-label="Department and project budgets">
    <h2>Department and project budgets</h2>
    {!account ? <p>Sign in to view finance data.</p> : !canManage ? <p>A billing administrator account is required.</p> : <>
      <label>Finance month <input type="month" value={month} onChange={event => { void setMonth(event.target.value); }} /></label>
      {MONTH.test(month) ? <FinanceMonth key={JSON.stringify([account, month])} account={account} month={month} />
        : <p role="alert">Choose a valid finance month.</p>}
    </>}
  </section>;
}

function FinanceMonth({ account, month }: { account: EnterpriseFinanceAccount; month: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState('');
  const [cap, setCap] = useState('');
  const [exposure, setExposure] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = useRef<AbortController | null>(null);
  useEffect(() => () => { write.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    async function load() {
      try {
        const response = await fetch(`${ENDPOINT}&month=${encodeURIComponent(month)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) { setState({ kind: 'forbidden' }); return; }
        if (!response.ok) throw new Error('unavailable');
        const body: unknown = await response.json();
        if (controller.signal.aborted) return;
        const data = (body as { allocations?: unknown } | null)?.allocations;
        setState(validSnapshot(data, account, month) ? { kind: 'ready', data } : { kind: 'unavailable' });
      } catch { if (!controller.signal.aborted) setState({ kind: 'unavailable' }); }
    }
    void load();
    return () => controller.abort();
  }, [account.controlWorkspaceId, account.organizationId, account.userId, account.sessionId, month, refresh]);

  if (state.kind === 'loading') return <p role="status">Loading finance data…</p>;
  if (state.kind === 'forbidden') return <p role="alert">A billing administrator account is required.</p>;
  if (state.kind !== 'ready') return <div role="alert">Finance data is unavailable. No cost or balance is assumed.
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Retry finance data</button></div>;
  const { data } = state;
  const editable = CLASSES.flatMap(costClass => data.report.byCostClass[costClass].allocations
    .filter(position => position.level !== 'organization')
    .map(position => ({ key: JSON.stringify([costClass, position.allocationId]), costClass, position })));
  const allocation = editable.find(entry => entry.key === selected);

  async function save() {
    if (!allocation || write.current) return;
    const capMicros = allocationLimitMicros(cap);
    const maxUnreconciledMicros = allocationLimitMicros(exposure);
    if (capMicros === null || maxUnreconciledMicros === null || maxUnreconciledMicros > capMicros) {
      setError('Enter nonnegative USD amounts with at most six decimal places; unreconciled cost cannot exceed the limit.'); return;
    }
    const controller = new AbortController(); write.current = controller;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        body: JSON.stringify({ allocationId: allocation.position.allocationId, parentAllocationId: allocation.position.parentAllocationId,
          level: allocation.position.level, costClass: allocation.costClass, month, capMicros, maxUnreconciledMicros }) });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) { setState({ kind: 'forbidden' }); return; }
      const body = await response.json() as { ok?: boolean; outcome?: string };
      if (controller.signal.aborted) return;
      if (!response.ok || !body.ok || !['created', 'revised', 'duplicate'].includes(body.outcome ?? '')) {
        setError(response.status === 409 ? 'This limit was refused. Check its parent limit and committed costs, then reload.' : 'The allocation could not be saved.'); return;
      }
      setNotice('Allocation saved.'); setSelected(''); setCap(''); setExposure(''); setRefresh(value => value + 1);
    } catch { if (!controller.signal.aborted) setError('The allocation could not be saved. Check your connection and reload.'); }
    finally { if (!controller.signal.aborted) { write.current = null; setSaving(false); } }
  }
  function download() {
    const blob = new Blob([`${JSON.stringify(data.accounting, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `allocation-accounting-${month}.json`;
    link.click(); URL.revokeObjectURL(url);
  }
  return <>
    <p>Model, hosting and subscription costs stay separate. Forecasts cover recorded allocation costs only, not unrecorded provider bills.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {CLASSES.map(costClass => {
      const group = data.report.byCostClass[costClass];
      const forecast = group.forecast;
      return <section key={costClass} aria-label={`${costClass} allocation costs`}>
        <h3>{costClass[0]!.toUpperCase() + costClass.slice(1)}</h3>
        <p>Committed: {money(group.committedMicros)} · Unreconciled: {money(group.unreconciledMicros)} · Provider final: {money(group.providerFinalMicros)}</p>
        <p>Recorded-cost forecast: {money(forecast?.projectedConsumptionMicros)}
          {forecast?.unavailableReason ? ` (${forecast.unavailableReason})` : forecast?.provisional ? ' (provisional)' : ''}</p>
        {group.allocations.length ? <div role="region" aria-label={`${costClass} allocation table`} tabIndex={0} style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <RichGrid style={{ minWidth: 1040 }} rows={[...group.allocations]} columns={positions} getRowId={row => row.allocationId} />
        </div>
          : <p>No recorded {costClass} allocations for this month.</p>}
      </section>;
    })}
    <section aria-label="Accepted outcomes and review effort"><h3>Accepted outcomes and review effort</h3>
      {data.report.outcomes.length ? <div role="region" aria-label="Outcome cost table" tabIndex={0} style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <RichGrid style={{ minWidth: 1200 }} rows={[...data.report.outcomes]} columns={outcomes} getRowId={row => row.allocationId} />
      </div>
        : <p>No recorded outcomes for this month.</p>}
    </section>
    <section aria-label="Accounting export"><h3>Accounting export</h3>
      <p>{data.accounting.rows.length} accounting entries; {data.accounting.gaps.length} recorded gaps. Unknown provider-final costs and human effort remain explicit in the export.</p>
      {data.accounting.rows.length > 0 && <div role="region" aria-label="Accounting entries table" tabIndex={0} style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <RichGrid style={{ minWidth: 1040 }} rows={[...data.accounting.rows]} columns={accountingColumns} getRowId={row => row.reservationId} />
      </div>}
      <button type="button" onClick={download}>Download accounting JSON</button>
    </section>
    {editable.length > 0 && <form aria-label="Allocation limits" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Allocation <select value={selected} disabled={saving} onChange={event => {
        const entry = editable.find(item => item.key === event.target.value);
        setSelected(event.target.value); setCap(entry ? decimal(entry.position.capMicros) : '');
        setExposure(entry ? decimal(entry.position.maxUnreconciledMicros) : ''); setError(null); setNotice(null);
      }}><option value="">Choose an allocation</option>{editable.map(entry =>
        <option key={entry.key} value={entry.key}>{entry.costClass}: {entry.position.allocationId}</option>)}</select></label>
      <label>Limit in USD <input inputMode="decimal" value={cap} disabled={saving || !allocation} onChange={event => setCap(event.target.value)} /></label>
      <label>Maximum unreconciled cost in USD <input inputMode="decimal" value={exposure} disabled={saving || !allocation} onChange={event => setExposure(event.target.value)} /></label>
      <button type="submit" disabled={saving || !allocation}>{saving ? 'Saving allocation…' : 'Save allocation'}</button>
    </form>}
  </>;
}
