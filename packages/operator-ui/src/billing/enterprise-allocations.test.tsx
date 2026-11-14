/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { HostedBillingAllocationFinance } from '@papercusp/operator-core/lib/endpoint-route/routes/hosted-billing/index';
import { allocationLimitMicros, EnterpriseAllocationPanel, type EnterpriseFinanceAccount } from './enterprise-allocations';

const account: EnterpriseFinanceAccount = { controlWorkspaceId: 'control-a', organizationId: 'org-a', userId: 'finance-a', sessionId: 'session-a' };
function snapshot(organizationId = 'org-a', month = '2026-10'): HostedBillingAllocationFinance {
  const organization = { controlWorkspaceId: 'control-a', organizationId };
  const group = (cost: number) => ({ committedMicros: cost, unreconciledMicros: cost, providerFinalMicros: 0,
    allocations: [{ allocationId: `${organizationId}-project`, parentAllocationId: 'department', level: 'project' as const,
      capMicros: 5_000_000, maxUnreconciledMicros: 500_000, committedMicros: cost,
      unreconciledMicros: cost, providerFinalMicros: 0, availableMicros: 5_000_000 - cost, openHolds: 1 }],
    forecast: { method: 'linear-elapsed-utc-month' as const, basisMicros: null, elapsedMs: 1000, periodMs: 2000,
      projectedConsumptionMicros: null, provisional: true, unavailableReason: 'unpriced-usage' as const,
      scope: 'recorded-allocation-costs' as const, evidenceRef: 'recorded-ledger' } });
  return { organization, asOfMs: 1, report: { month,
    byCostClass: { model: group(100_001), hosting: group(200_002), subscription: group(300_003) },
    outcomes: [{ allocationId: `${organizationId}-project`, outcomes: 1,
      byState: { accepted: 1, rejected: 0, 'rework-requested': 0, unknown: 0 }, evidenceClasses: ['internal-simulation'],
      acceptedResultCostMicros: 0, acceptedWithUnknownCost: 1, costPerAcceptedOutcomeMicros: null,
      costPerAcceptedUnknownReason: 'provider-final-pending', reviewEffortKnownSeconds: 0, reviewEffortUnknown: 1,
      reworkKnownTotal: 0, reworkUnknown: 1 }] },
    accounting: { organization, month, currency: 'USD', rows: [{ reservationId: 'reservation-a', allocationId: `${organizationId}-project`,
      allocationPath: ['department', `${organizationId}-project`], costClass: 'model', revision: 1, observedAtMs: 1,
      costSource: 'estimate', maximumCostMicros: 100_001, observedCostMicros: { value: 100_001 },
      providerFinalCostMicros: { unknownReason: 'not-final' }, committedMicros: 100_001, unreconciledMicros: 100_001, outcomeIds: [] }],
      byCostClass: { model: { reservations: 1, pendingProviderFinal: 1, committedMicros: 100_001, unreconciledMicros: 100_001, providerFinalMicros: 0 },
        hosting: { reservations: 1, pendingProviderFinal: 1, committedMicros: 200_002, unreconciledMicros: 200_002, providerFinalMicros: 0 },
        subscription: { reservations: 1, pendingProviderFinal: 1, committedMicros: 300_003, unreconciledMicros: 300_003, providerFinalMicros: 0 } },
      outcomes: [], gaps: [{ kind: 'provider-final-pending', ref: 'reservation-a', reason: 'not final' }] } };
}
const ok = (data = snapshot()) => Response.json({ ok: true, allocations: data });
function panel(value: EnterpriseFinanceAccount | null = account, canManage = true) {
  return <NuqsTestingAdapter searchParams="?financeMonth=2026-10" hasMemory>
    <EnterpriseAllocationPanel account={value} canManage={canManage} />
  </NuqsTestingAdapter>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Enterprise allocation finance panel', () => {
  it('does not request finance data for signed-out users or non-managers', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const view = render(panel(null)); expect(screen.getByText('Sign in to view finance data.')).toBeTruthy();
    view.rerender(panel(account, false)); expect(screen.getByText('A billing administrator account is required.')).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps cost classes separate and displays unknown forecasts and effort without inventing a total', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok()); vi.stubGlobal('fetch', fetcher); render(panel());
    await screen.findByRole('button', { name: 'Download accounting JSON' });
    expect(fetcher).toHaveBeenCalledWith('/api/hosted/billing/usage?view=allocations&month=2026-10',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    for (const [costClass, amount] of [['model', '$0.100001'], ['hosting', '$0.200002'], ['subscription', '$0.300003']]) {
      const region = within(screen.getByRole('region', { name: `${costClass} allocation costs` }));
      expect(region.getByText(new RegExp(`Committed: \\${amount}`))).toBeTruthy();
      expect(region.getByText('Recorded-cost forecast: Unknown (unpriced-usage)')).toBeTruthy();
    }
    expect(screen.getAllByText('Unknown: provider-final-pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0 recorded seconds; 1 unknown').length).toBeGreaterThan(0);
    expect(screen.queryByText('$0.600006')).toBeNull();
  });
  it.each([401, 403])('withholds the finance view after server authorization refusal %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private', { status })));
    render(panel()); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Download accounting JSON' })).toBeNull();
    expect(screen.queryByText('private')).toBeNull();
  });
  it.each(['organization', 'accounting', 'month'] as const)('rejects mismatched server %s scope before rendering', async mismatch => {
    const data = snapshot();
    const altered = mismatch === 'organization' ? { ...data, organization: { ...data.organization, organizationId: 'foreign' } }
      : mismatch === 'accounting' ? { ...data, accounting: { ...data.accounting, organization: { ...data.organization, organizationId: 'foreign' } } }
        : { ...data, report: { ...data.report, month: '2026-09' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(altered))); render(panel());
    await screen.findByText(/Finance data is unavailable/);
    expect(screen.queryByRole('button', { name: 'Download accounting JSON' })).toBeNull();
  });
  it('clears the old tenant immediately and ignores its late response', async () => {
    let oldResponse!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { oldResponse = resolve; }))
      .mockResolvedValueOnce(ok(snapshot('org-b')));
    vi.stubGlobal('fetch', fetcher); const view = render(panel());
    view.rerender(panel({ ...account, organizationId: 'org-b', sessionId: 'session-b' }));
    await screen.findByRole('button', { name: 'Download accounting JSON' });
    await act(async () => oldResponse(ok(snapshot('org-a'))));
    expect(screen.queryByRole('option', { name: 'model: org-a-project' })).toBeNull();
    expect(screen.getByRole('option', { name: 'model: org-b-project' })).toBeTruthy();
  });
  it('sends exact integer limits and lets the server bind authority and accounting', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(Response.json({ ok: true, outcome: 'revised' })).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher); render(panel());
    await screen.findByLabelText('Allocation');
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: JSON.stringify(['model', 'org-a-project']) } });
    fireEvent.change(screen.getByLabelText('Limit in USD'), { target: { value: '1.000001' } });
    fireEvent.change(screen.getByLabelText('Maximum unreconciled cost in USD'), { target: { value: '0.000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('/api/hosted/billing/usage?view=allocations');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body)).toEqual({ allocationId: 'org-a-project', parentAllocationId: 'department',
      level: 'project', costClass: 'model', month: '2026-10', capMicros: 1_000_001, maxUnreconciledMicros: 1 });
    await screen.findByText('Allocation saved.');
  });
  it('preserves a server refusal without reporting a saved limit', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(Response.json({ error: { message: 'private database error' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher); render(panel()); await screen.findByLabelText('Allocation');
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: JSON.stringify(['model', 'org-a-project']) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await screen.findByText(/This limit was refused/);
    expect(screen.queryByText('Allocation saved.')).toBeNull(); expect(screen.queryByText('private database error')).toBeNull();
  });
  it('aborts the old session write and discards its late acknowledgement and draft', async () => {
    let finishWrite!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(ok())
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishWrite = resolve; }))
      .mockResolvedValueOnce(ok(snapshot('org-b')));
    vi.stubGlobal('fetch', fetcher); const view = render(panel()); await screen.findByLabelText('Allocation');
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: JSON.stringify(['model', 'org-a-project']) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    const signal = fetcher.mock.calls[1]![1].signal as AbortSignal;
    view.rerender(panel({ ...account, organizationId: 'org-b', sessionId: 'session-b' }));
    expect(signal.aborted).toBe(true);
    await screen.findByLabelText('Allocation');
    await act(async () => finishWrite(Response.json({ ok: true, outcome: 'revised' })));
    expect(screen.queryByText('Allocation saved.')).toBeNull();
    expect((screen.getByLabelText('Allocation') as HTMLSelectElement).value).toBe('');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('exports the current scoped accounting snapshot with unknown costs intact', async () => {
    const createUrl = vi.fn().mockReturnValue('blob:accounting'); const revokeUrl = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok())); render(panel());
    fireEvent.click(await screen.findByRole('button', { name: 'Download accounting JSON' }));
    expect(clicks).toEqual(['allocation-accounting-2026-10.json']);
    expect(createUrl.mock.calls[0]![0].type).toBe('application/json');
    expect(revokeUrl).toHaveBeenCalledWith('blob:accounting');
    const reader = new FileReader();
    const exported = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(createUrl.mock.calls[0]![0]);
    });
    expect(JSON.parse(exported)).toEqual(snapshot().accounting);
    expect(exported).toContain('not-final');
    expect(screen.getAllByText('Unknown: not-final').length).toBeGreaterThan(0);
  });
  it('moves the month in URL state, clears drafts and loads only the selected month', async () => {
    const onUrlUpdate = vi.fn(); const fetcher = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(snapshot('org-a', '2026-09')));
    vi.stubGlobal('fetch', fetcher);
    render(<NuqsTestingAdapter searchParams="?financeMonth=2026-10" hasMemory onUrlUpdate={onUrlUpdate}>
      <EnterpriseAllocationPanel account={account} canManage />
    </NuqsTestingAdapter>);
    await screen.findByLabelText('Allocation');
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: JSON.stringify(['model', 'org-a-project']) } });
    fireEvent.change(screen.getByLabelText('Finance month'), { target: { value: '2026-09' } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await screen.findByLabelText('Allocation');
    expect(fetcher.mock.calls[1]![0]).toContain('month=2026-09');
    expect((screen.getByLabelText('Allocation') as HTMLSelectElement).value).toBe('');
    expect(onUrlUpdate.mock.calls[0]![0].searchParams.get('financeMonth')).toBe('2026-09');
  });
  it.each(['1e2', '-1', '0.0000001', '9007199254.740992'])('refuses invalid or unsafe USD amount %s', value => {
    expect(allocationLimitMicros(value)).toBeNull();
  });
  it('keeps the exact micro-USD boundary', () => {
    expect(allocationLimitMicros('0.000001')).toBe(1);
    expect(allocationLimitMicros('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
