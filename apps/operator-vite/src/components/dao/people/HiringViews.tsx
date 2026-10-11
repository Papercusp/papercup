import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';

const cadences = ['hourly','weekly','biweekly','monthly','annual','per-milestone'];
const states: Record<string, string> = { offered: 'Awaiting internal approval', approved: 'Approved for contract', 'contract-generated': 'Awaiting signatures', signed: 'Signed; awaiting hire vote', 'hire-proposed': 'Hire vote open', hired: 'Hired', rejected: 'Rejected', lapsed: 'Lapsed' };
type Offer = HiringView['offers'][number];
type Role = HiringView['roles'][number];

export default function HiringViews({ daoSlug }: { daoSlug: string }) {
  const [data, setData] = useState<HiringView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [roleId, setRoleId] = useQueryState('hiringRole', parseAsString.withDefault(''));
  const [offerId, setOfferId] = useQueryState('hiringOffer', parseAsString.withDefault(''));
  const generation = useRef(0);
  const url = '/api/pot/' + encodeURIComponent(daoSlug) + '/hiring';
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const response = await fetch(url);
      const result = await response.json();
      if (!response.ok || !result.ok || !result.hiring) throw new Error(result.message || 'Hiring records could not be read.');
      if (request === generation.current) setData(result.hiring);
    } catch (cause) { if (request === generation.current) { setData(null); setError(cause instanceof Error ? cause.message : 'Hiring records could not be read.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [url]);
  useEffect(() => { setData(null); void load(); return () => { generation.current++; }; }, [load]);
  async function action(payload: unknown) {
    setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'The hiring action was refused.');
      await load();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The hiring action was refused.'); return false; }
    finally { setBusy(false); }
  }
  if (loading && !data) return <p role="status" aria-live="polite">Loading hiring records…</p>;
  if (!data) return <div role="alert"><p>{error || 'Hiring records are unavailable.'}</p><button type="button" onClick={() => void load()}>Retry</button></div>;
  const role = data.roles.find(r => r.roleId === roleId);
  const offer = data.offers.find(o => o.offerId === offerId);
  const name = (id: string) => data.people.find(p => p.personId === id)?.displayName ?? id;
  const roleColumns: ColumnDef<Role>[] = [
    { key: 'title', header: 'Role', width: 2, toCopyText: row => row.title, render: ({ row }) => <button type="button" onClick={() => void setRoleId(row.roleId)}>{row.title}</button> },
    { key: 'level', header: 'Level', width: 1, toCopyText: row => row.level, render: ({ row }) => row.level },
    { key: 'candidates', header: 'Candidates', width: 1, toCopyText: row => String(row.candidates.length), render: ({ row }) => row.candidates.length },
  ];
  const offerColumns: ColumnDef<Offer>[] = [
    { key: 'person', header: 'Candidate', width: 2, toCopyText: row => name(row.personId), render: ({ row }) => <button type="button" onClick={() => void setOfferId(row.offerId)}>{name(row.personId)}</button> },
    { key: 'state', header: 'Stage', width: 2, toCopyText: row => states[row.state], render: ({ row }) => states[row.state] },
    { key: 'equity', header: 'Equity preview', width: 2, toCopyText: row => String(row.terms.equity.shares), render: ({ row }) => <>{row.terms.equity.shares} shares · {row.preview ? row.preview.fullyDilutedPercent + '% fully diluted' : 'Percentage unavailable'}</> },
    { key: 'pay', header: 'Regular pay', width: 2, toCopyText: row => row.terms.pay.amount + ' ' + row.terms.pay.currency,
      render: ({ row }) => <>{row.terms.pay.amount} {row.terms.pay.currency} · {row.terms.pay.cadence}</> },
  ];
  const peopleOptions = data.people.map(person => <option key={person.personId} value={person.personId}>{person.displayName}</option>);
  async function createRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    if (await action({ action: 'role', title: fields.get('title'), level: fields.get('level'), managerPersonId: fields.get('manager') || null, exclusive: fields.get('exclusive') === 'on' })) form.reset();
  }
  async function addCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    await action({ action: 'candidate', roleId: role!.roleId, personId: fields.get('person') });
  }
  async function createOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const overrides: Record<string, number> = {};
    for (const key of ['shares','vestingDays','cliffDays']) { const value = fields.get(key); if (value !== null && value !== '') overrides[key] = Number(value); }
    await action({ action: 'offer', roleId: role!.roleId, personId: fields.get('person'), engagementType: fields.get('engagement'), jurisdiction: fields.get('jurisdiction'),
      pay: { amount: fields.get('amount'), currency: fields.get('currency'), cadence: fields.get('cadence') }, overrides });
  }
  return <section aria-label="Hiring">
    <h3>Hiring</h3><p>Role → candidate → offer → internal approval → contract → hire vote.</p>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">Refreshing hiring records…</p> : null}
    <button type="button" disabled={busy || loading} onClick={() => void load()}>Refresh hiring</button>
    {data.nonBinding ? <p role="status">Test chain — non-binding. No formed issuing entity is recorded.</p> : null}
    {data.chainError ? <p role="alert">{data.chainError}</p> : data.chain ? <p>Preview uses chain block {data.chain.blockNumber}.</p> : null}
    <h4>Open roles</h4>{data.roles.length ? <RichGrid rows={data.roles} columns={roleColumns} getRowId={row => row.roleId} /> : <p>Create a role to begin hiring.</p>}
    <details><summary>Create a role</summary><form className="dao-form" aria-label="Create role" onSubmit={createRole}>
      <label>Role title<input name="title" required maxLength={120} /></label>
      <label>Level<input name="level" required maxLength={60} /></label>
      <label>Manager<select className="dao-select" name="manager"><option value="">No manager</option>{peopleOptions}</select></label>
      <label><input name="exclusive" type="checkbox" />Exclusive engagement</label>
      <button type="submit" className="dao-action" disabled={busy}>Create role</button>
    </form></details>
    {role ? <section aria-label={role.title + ' candidates'}><h4>{role.title} · {role.level}</h4>
      <form className="dao-form" aria-label="Add candidate" onSubmit={addCandidate}>
        <label>Candidate<select className="dao-select" name="person" required><option value="">Select a person</option>{peopleOptions}</select></label>
        <button type="submit" className="dao-action" disabled={busy || !data.people.length}>Add candidate</button>
      </form>
      {!data.people.length ? <p>No shared person records are available. Add the person to your workspace contacts first.</p> : null}
      {role.candidates.length ? <form className="dao-form" aria-label="Create offer" onSubmit={createOffer}>
        <h4>Offer terms</h4><p>Empty equity overrides use the current policy for this role and level. The saved offer freezes its terms.</p>
        <label>Offer candidate<select className="dao-select" name="person" required>{role.candidates.map(id => <option value={id} key={id}>{name(id)}</option>)}</select></label>
        <label>Engagement<select className="dao-select" name="engagement"><option value="employee">Employee</option><option value="contractor">Contractor</option></select></label>
        <label>Jurisdiction<input name="jurisdiction" required maxLength={200} /></label>
        <label>Pay amount<input name="amount" required inputMode="decimal" pattern="[0-9]{1,16}(\.[0-9]{1,2})?" /></label>
        <label>Currency<input name="currency" defaultValue="USD" required pattern="[A-Z]{3}" maxLength={3} /></label>
        <label>Pay cadence<select className="dao-select" name="cadence" defaultValue="monthly">{cadences.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Shares override<input name="shares" type="number" min="1" step="1" /></label>
        <label>Vesting days override<input name="vestingDays" type="number" min="1" max="3650" step="1" /></label>
        <label>Cliff days override<input name="cliffDays" type="number" min="0" max="3650" step="1" /></label>
        <button type="submit" className="dao-action" disabled={busy}>Create offer</button>
      </form> : <p>Add a candidate before creating an offer.</p>}
    </section> : roleId ? <p>The selected role is unavailable in this DAO.</p> : null}
    <h4>Offers</h4>{data.offers.length ? <RichGrid rows={data.offers} columns={offerColumns} getRowId={row => row.offerId} /> : <p>No offers yet.</p>}
    {offer ? <article aria-label="Offer detail"><h4>{name(offer.personId)}</h4><p>{states[offer.state]}</p>
      <p>{offer.terms.engagementType} · {offer.terms.jurisdiction} · policy version {offer.terms.equity.policyVersion ?? 'default'}</p>
      <p>{offer.terms.equity.shares} shares · {offer.terms.equity.vestingDays} days vesting · {offer.terms.equity.cliffDays} day cliff</p>
      {offer.preview ? <p>{offer.preview.fullyDilutedPercent}% of {offer.preview.proposedFullyDilutedShares} fully diluted shares, including this offer.</p> : null}
      {offer.terms.employmentLike ? <p role="alert">This contractor offer looks like employment: fixed-cadence pay, a named manager and exclusive work. Review the engagement classification before signing.</p> : null}
      <p>Approvals: {offer.approvedBy.length} of {offer.approvalsRequired}. Author: {name(offer.authoredBy)}.</p>
      {offer.state === 'offered' ? <>
        <button type="button" className="dao-action" disabled={busy || offer.authoredBy === data.actorPersonId || offer.approvedBy.includes(data.actorPersonId)}
          onClick={() => void action({ action: 'approve', offerId: offer.offerId })}>Approve offer</button>
        {offer.authoredBy === data.actorPersonId ? <p>Another HR admin must approve your offer.</p> : null}
      </> : null}
      <h4>Offer history</h4><ol>{data.history.filter(h => h.subjectKind === 'offer' && h.subjectId === offer.offerId).slice().reverse().map(h =>
        <li key={h.id}>{h.state} · {name(h.actorPersonId)} · <time>{h.at}</time></li>)}</ol>
    </article> : offerId ? <p>The selected offer is unavailable in this DAO.</p> : null}
  </section>;
}
