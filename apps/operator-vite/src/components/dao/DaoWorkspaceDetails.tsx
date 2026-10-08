import type { DaoWorkspaceView, DaoRead } from '@papercusp/operator-core/lib/dao-workspace-types';
import RouteLink from '@/app/_components/RouteLink';
import type { DaoSection } from './dao-navigation';

function ReadState({ read }: { read: DaoRead<unknown> | undefined }) {
  return read?.status === 'error' ? <p role="alert">{read.message}</p> : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default function DaoWorkspaceDetails({ section, view, loading, error }: { section: DaoSection; view: DaoWorkspaceView | null; loading: boolean; error: string }) {
  if (loading) return <p role="status">Loading organization records…</p>;
  if (error) return <div className="dao-notice" role="alert">{error}</div>;
  if (!view || view.status === 'not-joined') return <section className="dao-card"><h2>Connect to this DAO</h2><p>Join its published projects to access organization records. Directory discovery alone does not grant membership or voting rights.</p></section>;
  const projects = view.projects?.status === 'ready' ? view.projects.value : [];
  const members = view.members?.status === 'ready' ? view.members.value : [];
  const governance = view.governance?.status === 'ready' ? view.governance.value : null;
  const policy = view.policy?.status === 'ready' ? view.policy.value : null;
  const policyAvailable = view.policy?.status === 'ready';
  const rounds = governance?.events.filter(event => event.kind === 'round-open') ?? [];
  const operations = '/adv?slug=' + encodeURIComponent(view.localHomeSlug!);

  if (section === 'members' || section === 'reputation') return <section className="dao-card">
    <h2>{section === 'members' ? 'Admitted contributors' : 'Contributor identities'}</h2><ReadState read={view.members} />
    {members.length ? <div className="dao-table-wrap"><table><thead><tr><th>Contributor</th><th>Membership binding</th><th>Bound devices</th></tr></thead><tbody>
      {members.map(member => <tr key={member.id}><td><strong>{member.displayName || member.username}</strong><small>{member.username}</small></td><td>{member.bindingStatus}</td><td>{member.devices}</td></tr>)}
    </tbody></table></div> : view.members?.status === 'ready' ? <p>No admitted contributor records are available.</p> : null}
    {section === 'reputation' ? <p>Membership identifies contributors. Accepted work and reputation remain distinct from equity ownership.</p> : null}
    <RouteLink className="dao-action" href={operations + '&tab=harnesses'}>Open contributor work</RouteLink>
  </section>;

  if (['proposals', 'vote', 'delegation', 'records'].includes(section)) return <div className="dao-overview-grid">
    <section className="dao-card dao-purpose"><h2>{section === 'delegation' ? 'Vote delegation policy' : 'Plan admission decisions'}</h2><ReadState read={view.governance} /><ReadState read={view.policy} />
      {governance?.integrityErrors.length ? <div role="alert" className="dao-notice">Some governance records could not be verified against the current policy. They cannot authorize decisions.<ul>{governance.integrityErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></div> : null}
      {section === 'delegation' ? <>
        <p>Delegations are bound to the organization’s signed policy and voter key epochs.</p>
        {policyAvailable ? <details><summary>Review recorded delegation rules</summary><pre>{JSON.stringify(policy?.delegations ?? [], null, 2)}</pre></details> : <p>Delegation rules are unavailable.</p>}
      </> : rounds.length ? <div className="dao-decision-list">{rounds.map(event => {
        const round = record(record(event.body).round);
        const ballots = governance!.events.filter(ballot => ballot.roundId === event.roundId && ballot.kind === 'vote');
        const conflicted = governance!.conflictedRoundIds.includes(event.roundId);
        return <article key={event.eventId}><span className="dao-badge">{conflicted ? 'Conflicting evidence' : 'Signed round'}</span><h3>{event.roundId}</h3>
          <p>Revision: <code>{String(round.planRevisionHash ?? 'unavailable')}</code></p><p>{ballots.length} recorded ballot events</p>
          <details><summary>Review exact decision evidence</summary><pre>{JSON.stringify(event.body, null, 2)}</pre></details>
        </article>;
      })}</div> : governance ? <p>No verified plan-admission rounds have been recorded.</p> : null}
      <RouteLink className="dao-action" href={operations + '&tab=plans'}>Open proposal and plan workspace</RouteLink>
    </section>
    <section className="dao-card"><h2>Governance policy</h2><p>{policyAvailable ? (policy?.version ? 'Policy version ' + policy.version : 'No policy recorded') : 'Policy unavailable'}</p><p>Admission: {policyAvailable ? policy?.membership ?? 'not configured' : 'unavailable'}</p>
      {policyAvailable ? <details><summary>Review admission thresholds</summary><pre>{JSON.stringify(policy?.admission ?? null, null, 2)}</pre></details> : null}
      <p>Plan admission does not authorize treasury transfers or ownership votes.</p>
    </section>
  </div>;

  if (section === 'work' || section === 'jobs' || section === 'inbox') return <>
    <ReadState read={view.projects} />
    <div className="dao-directory">{projects.map(project => <section className="dao-card" key={project.slug}><p className="dao-eyebrow">Linked project</p><h2>{project.title}</h2>
      {project.plans.length ? <ul className="dao-plan-list">{project.plans.map(plan => <li key={plan.slug}><RouteLink href={'/adv?slug=' + encodeURIComponent(project.slug) + '&tab=plans&plan=' + encodeURIComponent(plan.slug)}>{plan.title}</RouteLink><small>{plan.status} · {plan.itemCount} authored work items</small></li>)}</ul> : <p>No active plan records in this project.</p>}
      <RouteLink className="dao-action" href={'/adv?slug=' + encodeURIComponent(project.slug) + '&tab=' + (section === 'jobs' ? 'harnesses' : 'plans')}>{section === 'jobs' ? 'Open agents and execution' : 'Open project workspace'}</RouteLink>
    </section>)}</div>
    {view.projects?.status === 'ready' && !projects.length ? <section className="dao-empty"><h2>No linked projects</h2><p>This organization has not linked project records in this workspace.</p></section> : null}
  </>;

  if (section === 'settings') return <section className="dao-card"><h2>Organization configuration</h2><p>Local organization home: <code>{view.localHomeSlug}</code></p><p>Membership mode: {policyAvailable ? policy?.membership ?? 'not configured' : 'unavailable'}</p><p>Policy version: {policyAvailable ? policy?.version || 'not configured' : 'unavailable'}</p><ReadState read={view.policy} />
    <div className="dao-actions"><RouteLink className="dao-action" href={operations + '&tab=settings'}>Open organization settings</RouteLink><RouteLink className="dao-action" href="/dao">Prepare legal entity and governance</RouteLink></div>
  </section>;

  if (section === 'marketplace') return <section className="dao-card"><h2>Organization capabilities</h2><p>Browse maintained apps, tools and capabilities. Purchases retain the existing organization membership, seat and payment checks.</p><RouteLink className="dao-action" href="/cupboard">Browse marketplace</RouteLink></section>;

  const finance = {
    treasury: ['Treasury accounts & approvals', 'A discovered DAO does not establish a bank account or on-chain balance. Treasury setup requires verified account references and its signer policy.'],
    funding: ['Funding & contribution agreements', 'Prepare your organization’s funding basis and revenue agreement. An organization revenue split is separate from Papercusp’s identity allocation.'],
    billing: ['Purchases, usage & refunds', 'Billing belongs to a verified commerce account. Its buying-organization identity must be connected explicitly; a discovery ID is not a commerce account ID.'],
    ownership: ['Equity & vesting', 'Ownership uses the organization’s equity deployment and eligible holder record. Membership and contribution reputation do not create shares.'],
    returns: ['Additional-share returns', 'Return allocations require the existing equity contract and holder approvals. A directory listing does not establish a distribution entitlement.'],
  } as const;
  const content = finance[section as keyof typeof finance];
  return <section className="dao-card"><h2>{content?.[0] ?? 'Organization records'}</h2><p>{content?.[1] ?? 'Review recorded organization information.'}</p>
    <div className="dao-notice">Finance and ownership records require an explicit verified account binding.</div>
    <RouteLink className="dao-action" href="/dao">Open organization launch preparation</RouteLink>
  </section>;
}
