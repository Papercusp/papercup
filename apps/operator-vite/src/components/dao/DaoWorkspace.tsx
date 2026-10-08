import { useEffect, useMemo, useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import RouteLink from '@/app/_components/RouteLink';
import { DAO_SECTIONS, daoSection, filterDaos, type DaoDirectoryEntry } from './dao-navigation';
import DaoWorkspaceDetails from './DaoWorkspaceDetails';
import './dao-workspace.css';

export default function DaoWorkspace() {
  const [selectedDao, setSelectedDao] = useQueryState('dao', parseAsString.withDefault(''));
  const [selectedSection, setSelectedSection] = useQueryState('daoSection', parseAsString.withDefault('directory'));
  const { data, error, invalidate } = useSyncQuery({ queryName: 'network.hiveDirectory' });
  const rows = (data as DaoDirectoryEntry[] | undefined) ?? [];
  const sectionId = daoSection(selectedSection);
  const section = DAO_SECTIONS.find(value => value.id === sectionId)!;
  const selected = rows.find(row => row.potId === selectedDao);
  const [query, setQuery] = useState('');
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [workspace, setWorkspace] = useState<DaoWorkspaceView | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const filtered = useMemo(() => filterDaos(rows, query), [rows, query]);

  useEffect(() => {
    setWorkspace(null); setWorkspaceError('');
    if (!selectedDao) { setWorkspaceLoading(false); return; }
    const controller = new AbortController();
    setWorkspaceLoading(true);
    void (async () => {
      try {
        const response = await fetch('/api/discovery/pots?potId=' + encodeURIComponent(selectedDao), { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.workspace || result.workspace.directoryId !== selectedDao) throw new Error('Unable to read this organization’s records. Refresh to retry.');
        if (!controller.signal.aborted) setWorkspace(result.workspace);
      } catch (cause) {
        if (!controller.signal.aborted) setWorkspaceError(cause instanceof Error ? cause.message : 'Organization records are unavailable.');
      } finally {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedDao, refreshVersion]);

  function refresh() { invalidate(); setRefreshVersion(value => value + 1); }

  async function choose(row: DaoDirectoryEntry) {
    setNotice('');
    setAcceptedTerms(false);
    await setSelectedDao(row.potId);
    await setSelectedSection('overview');
  }

  async function join() {
    if (!selected || !acceptedTerms || !selected.memberLinks.length || joining) return;
    setJoining(true);
    setNotice('');
    try {
      const response = await fetch('/api/discovery/join-pot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ potId: selected.potId, title: selected.title, memberLinks: selected.memberLinks }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? 'Membership request failed.');
      setNotice('Joined ' + (result.potSlug ?? selected.title) + '. Review membership permissions before submitting decisions.');
      invalidate();
      setRefreshVersion(value => value + 1);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Unable to join. Try again.');
    } finally { setJoining(false); }
  }

  return (
    <div className="dao-workspace" data-testid="dao-workspace">
      <aside className="dao-sidebar" aria-label="DAO workspace">
        <div className="dao-brand"><span aria-hidden="true">◈</span><div><strong>DAO Workbench</strong><small>Community · decisions · execution</small></div></div>
        <label className="dao-picker">Organization
          <select aria-label="Choose a DAO" value={selectedDao} onChange={event => {
            void setSelectedDao(event.target.value); setAcceptedTerms(false); setNotice('');
          }}>
            <option value="">Choose an organization</option>
            {rows.map(row => <option key={row.potId} value={row.potId}>{row.title}</option>)}
          </select>
        </label>
        <nav aria-label="DAO sections">
          {['Community', 'Governance', 'Execution', 'Finance', 'Organization'].map(group => (
            <div className="dao-nav-group" key={group}><h2>{group}</h2>
              {DAO_SECTIONS.filter(value => value.group === group).map(value => (
                <button key={value.id} type="button" aria-current={sectionId === value.id ? 'page' : undefined}
                  onClick={() => { setNotice(''); void setSelectedSection(value.id); }}>{value.label}</button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="dao-main">
        <header className="dao-page-header"><div><p className="dao-eyebrow">{selected?.title ?? 'DAO network'} / {section.group}</p>
          <h1>{section.label}</h1><p>{section.description}</p></div>
          <div className="dao-actions"><RouteLink href="/dao" className="dao-action">Launch a DAO</RouteLink><button type="button" className="dao-action" onClick={refresh}>Refresh</button></div>
        </header>
        {notice && <div role="status" className="dao-notice">{notice}</div>}
        {error ? <div role="alert" className="dao-notice">Unable to load the DAO directory. <button type="button" onClick={() => invalidate()}>Try again</button></div> : null}
        {data === undefined && !error ? <p role="status">Loading discovered organizations…</p> : null}
        {sectionId === 'directory' ? <>
          <label className="dao-search">Search organizations<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, purpose or founder" /></label>
          <div className="dao-directory">
            {filtered.map(row => <article className="dao-card" key={row.potId}>
              <div className="dao-card-heading"><span className="dao-avatar" aria-hidden="true">{row.title.slice(0, 1)}</span><span className="dao-badge">{row.visibility === 'invite' ? 'Invite only' : 'Public'}</span></div>
              <h2>{row.title}</h2><p>{row.description || 'No organization description published yet.'}</p>
              <dl><div><dt>Published by</dt><dd>{row.owner}</dd></div><div><dt>Linked projects</dt><dd>{row.memberCount}</dd></div></dl>
              <button type="button" className="dao-action" onClick={() => { void choose(row); }}>Open workspace →</button>
            </article>)}
          </div>
          {data !== undefined && !filtered.length ? <div className="dao-empty"><h2>{query ? 'No matching organizations' : 'No DAOs discovered yet'}</h2><p>{query ? 'Try another name or purpose.' : 'Organizations published to this peer’s directory will appear here.'}</p></div> : null}
        </> : !selected ? <div className="dao-empty"><h2>{selectedDao ? 'This organization is no longer in the directory' : 'Choose an organization'}</h2><p>Select a DAO to open its workspace.</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('directory'); }}>Browse DAOs</button></div> : <>
          {sectionId === 'overview' ? <div className="dao-overview-grid">
            <section className="dao-card dao-purpose"><p className="dao-eyebrow">Organization</p><h2>{selected.title}</h2><p>{selected.description || 'No purpose published yet.'}</p><div className="dao-meta">Published by {selected.owner} · {selected.visibility}</div></section>
            <section className="dao-card"><p className="dao-eyebrow">Projects</p><strong className="dao-stat">{selected.memberCount}</strong><p>Linked projects in the discovery record</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('work'); }}>Explore work →</button></section>
            <section className="dao-card"><p className="dao-eyebrow">Your next step</p><h2>Review membership</h2><p>Connect to the organization before participating in its plans.</p><button type="button" className="dao-action" onClick={() => { void setSelectedSection('join'); }}>Membership →</button></section>
          </div> : sectionId === 'join' ? <section className="dao-card dao-purpose"><h2>Join {selected.title}</h2><p>Joining connects this workspace to the organization’s published projects. Voting and spending retain their separate admission and signer requirements.</p>
            <label className="dao-check"><input type="checkbox" checked={acceptedTerms} onChange={event => setAcceptedTerms(event.target.checked)} /> I want to connect to this organization’s published projects.</label>
            {!selected.memberLinks.length ? <p>This publisher has not provided the project links required to join.</p> : null}
            <button type="button" className="dao-action" disabled={!acceptedTerms || joining || !selected.memberLinks.length} onClick={() => { void join(); }}>{joining ? 'Joining…' : 'Join organization'}</button>
          </section> : <DaoWorkspaceDetails section={sectionId} view={workspace} loading={workspaceLoading} error={workspaceError} />}
          <aside className="dao-evidence"><h2>Decision boundaries</h2><p>Member plan votes authorize plan admission. Treasury transactions require their signer approvals. Ownership votes use the equity governance contract.</p><p>Directory entries describe discovered organizations; they do not establish legal formation or financial assets.</p></aside>
        </>}
      </main>
    </div>
  );
}
