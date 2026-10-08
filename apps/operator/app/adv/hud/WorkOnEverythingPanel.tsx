'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { Infinity as InfinityIcon, Search, Settings2, MessageSquare, X } from 'lucide-react';
import { Modal } from '@/app/harness/Modal';
import { TextInput, TextArea } from '@/app/harness/TextInput';
import GoalStatusControl from './GoalStatusControl';
import GoalSettingsSection from './GoalSettingsSection';
import { agoText, type GoalDetailInput } from './goal-detail-model';
import { ongoingWorkView } from './ongoing-work-model';
import { draftRows, moveDraft, toggleDraft, worklistChanges, type WorklistDraft,
  type WorklistRow } from './ongoing-work-draft';
import './WorkOnEverythingPanel.css';

export default function WorkOnEverythingPanel({ data, nowMs, onClose, onOpenPlan, onOpenWorkItem,
  onOpenAgent, refresh }: {
  data: GoalDetailInput; nowMs: number; onClose: () => void; refresh: () => void;
  onOpenPlan?: (harness: string, plan: string) => void;
  onOpenWorkItem?: (id: string) => void; onOpenAgent?: (owner: string) => void;
}) {
  const goal = data.goal!;
  const [query, setQuery] = useQueryState('hudwoesearch', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('hudwoeplan', parseAsString);
  const [inspectorTab, setInspectorTab] = useQueryState('hudwoeinspector',
    parseAsStringEnum(['summary', 'evidence', 'history']).withDefault('summary'));
  const [reviewOpen, setReviewOpen] = useQueryState('hudwoereview', parseAsBoolean.withDefault(false));
  const [settingsOpen, setSettingsOpen] = useQueryState('hudwoesettings', parseAsBoolean.withDefault(false));
  const [draft, setDraft] = useState<WorklistDraft | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [awaitingVersion, setAwaitingVersion] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false), listRef = useRef<HTMLDivElement>(null);
  // Declared source identifies this collection; titles are freely editable.
  const entry = Object.entries(data.goalData?.collections ?? {}).find(([, c]) =>
    c.selection.ok && c.selection.configured &&
    c.selection.collection.source === 'active-workspace-plans');
  const collection = entry?.[1], selection = collection?.selection;
  const configured = selection?.ok && selection.configured ? selection : null;
  const version = configured?.policyVersion ?? null;
  const rows = collection ? draftRows(collection, draft) : [];
  const included = rows.filter((r) => r.selected), excluded = rows.filter((r) => !r.selected);
  const visible = [...included, ...excluded].filter((r) =>
    (r.label + ' ' + (r.harness ?? '')).toLowerCase().includes(query.toLowerCase()));
  const selected = visible.find((r) => r.id === selectedId) ?? visible[0] ?? null;
  const changes = collection ? worklistChanges(collection, draft) : [];
  const stale = !!draft && draft.version !== version && awaitingVersion === null;
  const locked = saving || awaitingVersion !== null;
  const view = ongoingWorkView(goal, data);
  const history = (data.goalData?.worklistHistory ?? []).filter((h) => h.ref === selected?.id);
  const owner = data.agents?.find((a) => a.live === true);
  const before = collection?.rows.filter((r) => r.selected) ?? [];

  useEffect(() => {
    if (awaitingVersion !== null && version === awaitingVersion) {
      setDraft(null); setAwaitingVersion(null); setReason('');
      setNotice('Worklist applied. The steward uses this policy for new work; existing tasks keep their owners.');
    } else if (awaitingVersion !== null && version !== null && version > awaitingVersion) {
      setAwaitingVersion(null);
      setProblem('A newer edit arrived before confirmation. Your draft is retained; compare it with the current worklist before continuing.');
    }
  }, [version, awaitingVersion]);

  function stage(next: WorklistDraft | null) {
    if (!collection || locked) return;
    setDraft(worklistChanges(collection, next).length ? next : null);
    setProblem(null); setNotice(null);
  }
  function openPlan(row: WorklistRow) {
    if (row.harness && row.planSlug) onOpenPlan?.(row.harness, row.planSlug);
  }
  function listKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!selected || !collection || event.target !== event.currentTarget) return;
    const key = event.key;
    if (!['ArrowUp', 'ArrowDown', 'j', 'k', 'x', 'X', 'Enter', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'Enter') { openPlan(selected); return; }
    if (key === 'x' || key === 'X') { stage(toggleDraft(collection, draft, selected.id)); return; }
    const up = key === 'ArrowUp' || key === 'k';
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(key)) {
      stage(moveDraft(collection, draft, selected.id, up ? -1 : 1)); return;
    }
    const i = key === 'Home' ? 0 : key === 'End' ? visible.length - 1
      : Math.max(0, Math.min(visible.length - 1, visible.indexOf(selected) + (up ? -1 : 1)));
    void setSelectedId(visible[i]?.id ?? null);
  }
  async function apply() {
    if (!configured || !draft || !changes.length || stale || busy.current || locked) return;
    busy.current = true; setSaving(true); setProblem(null);
    try {
      const response = await fetch('/api/admin/goals/set-property', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: goal.id, property: configured.collection.policy,
          value: draft.policy, expectedVersion: draft.version, reason: reason.trim() || undefined }) });
      const result = await response.json();
      if (!response.ok || result.ok === false || result.error) {
        throw new Error(result.message ?? result.detail ??
          (typeof result.error === 'string' ? result.error : result.error?.message) ?? ('HTTP ' + response.status));
      }
      if (typeof result.version !== 'number') {
        throw new Error('The save did not return a version. Refresh to check the outcome; your draft is retained.');
      }
      setAwaitingVersion(result.version); void setReviewOpen(false);
      setNotice('Saved. Waiting for the confirmed worklist…');
      refresh();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error)); refresh();
    } finally { busy.current = false; setSaving(false); }
  }
  function discard() {
    if (locked) return;
    setDraft(null); setReason(''); setProblem(null); void setReviewOpen(false);
    setNotice('Draft discarded. The saved worklist is unchanged.');
  }

  const renderRow = (row: WorklistRow) => {
    const rank = included.findIndex((r) => r.id === row.id), change = changes.find((c) => c.id === row.id);
    const latest = row.outcomes?.[0];
    return <div key={row.id} id={'woe-' + encodeURIComponent(row.id)} role="option"
      aria-selected={selected?.id === row.id} className={'woe__row' + (selected?.id === row.id ? ' woe__row--selected' : '') + (change ? ' woe__row--changed' : '') + (!row.selected ? ' woe__row--excluded' : '')}
      onClick={() => { void setSelectedId(row.id); listRef.current?.focus(); }}
      data-testid="ongoing-worklist-row">
      <span className="woe__rank">{row.selected ? String(rank + 1).padStart(2, '0') : '—'}</span>
      <span className="woe__plan"><strong>{row.label}</strong><small>{row.harness ?? row.id}</small></span>
      <span className="woe__next" title={row.nextStep ?? row.reason ?? ''}>{row.nextStep ?? row.reason ?? 'Next step unavailable'}</span>
      <span className="hud__chip">{row.state ?? 'Unavailable'}</span>
      <span className="woe__agents" title="Measured ownership; not a future allocation">
        {row.liveLaneOwner ? '● lane' : row.fleetMembers != null ? row.fleetMembers + ' fleet' : '—'}
      </span>
      <span className="woe__fresh" title="Latest completed outcome in the bounded goal activity feed">
        {latest?.closedAt ? agoText(latest.closedAt, nowMs) : 'Unmeasured'}
      </span>
      <span className="woe__change">{change?.label}</span>
      <span className="woe__row-tools">
        {row.selected ? <><button type="button" tabIndex={-1} className="pc-ctl-act" disabled={locked || rank === 0}
          aria-label={'Move ' + row.label + ' up'} onClick={(e) => { e.stopPropagation(); stage(moveDraft(collection!, draft, row.id, -1)); }}>↑</button>
        <button type="button" tabIndex={-1} className="pc-ctl-act" disabled={locked || rank === included.length - 1}
          aria-label={'Move ' + row.label + ' down'} onClick={(e) => { e.stopPropagation(); stage(moveDraft(collection!, draft, row.id, 1)); }}>↓</button></> : null}
        <button type="button" tabIndex={-1} className="pc-ctl-act" disabled={locked}
          aria-label={(row.selected ? 'Remove ' : 'Add back ') + row.label}
          onClick={(e) => { e.stopPropagation(); stage(toggleDraft(collection!, draft, row.id)); }}>{row.selected ? 'Remove' : 'Add back'}</button>
      </span>
    </div>;
  };

  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={goal.title}
    description="Dedicated ongoing worklist" srOnlyTitle contentStyle={{ width: 'min(1540px, 96vw)',
      maxWidth: 'none', height: 'min(940px, 94dvh)', padding: 0, display: 'flex', flexDirection: 'column' }}>
    <section className="woe" data-testid="work-on-everything-console" aria-label="Work on everything worklist">
      <header className="woe__header"><div className="woe__identity"><InfinityIcon size={30} aria-hidden />
        <div><div className="woe__title"><h2>{goal.title}</h2><span className={'hud__chip hud__chip--' + view.status.tone}>{view.status.label}</span></div>
        <p>Keep priority work moving across the workspace.</p></div></div>
        <div className="woe__actions"><GoalStatusControl goalId={goal.id} status={goal.status}
          effectiveStatus={data.effectiveStatus} holderLiveness={data.holderLiveness} variant="card" />
          <button className="pc-ctl-act" type="button" onClick={() => void setSettingsOpen(true)}><span><Settings2 size={14} />Settings</span></button>
          {owner && onOpenAgent ? <button className="pc-ctl-act pc-ctl-act--primary" type="button"
            onClick={() => onOpenAgent(owner.ownerId)}><span><MessageSquare size={14} />Ask steward</span></button> : null}
          <button className="pc-ctl-act" type="button" aria-label="Close ongoing work" onClick={onClose}><X size={15} /></button>
        </div></header>
      <div className="woe__subhead"><span className="woe__active-tab">Worklist</span><span>Standing goal · {view.spend ?? 'Spend unavailable'}{view.budget ? ' · Budget ' + view.budget : ''}</span></div>
      <div className="woe__body"><div className="woe__intro"><h3>Plan the next pass.</h3><p>Reorder and rescope freely. Nothing changes until you apply.</p></div>
        {data.goalData?.error ? <p role="alert">{data.goalData.error}</p> : null}
        {!configured || !collection ? <div className="woe__empty" role="status">
          <h3>Worklist unavailable</h3><p>{selection && !selection.ok ? selection.reason : 'The goal’s active-plan collection is not available yet.'}</p>
          <button type="button" className="pc-ctl-act" onClick={refresh}>Refresh worklist</button></div> :
        <div className="woe__layout"><div className="woe__list-column">
          <div className="woe__toolbar"><label className="woe__search"><TextInput leading={<Search size={15} />}
            style={{ width: '100%', border: 0, background: 'transparent', padding: 0 }}
            aria-label="Search worklist" placeholder="Search plans…" value={query}
            onChange={(e) => void setQuery(e.target.value)} /></label>
            <span className="woe__shortcuts">↑↓ select · Alt+↑↓ move · X add/remove · Enter open</span></div>
          <div className="woe__list" role="listbox" tabIndex={0} ref={listRef} onKeyDown={listKey}
            aria-label="Worklist draft" aria-activedescendant={selected ? 'woe-' + encodeURIComponent(selected.id) : undefined}
            aria-busy={locked}>
            <div className="woe__columns" aria-hidden><span>#</span><span>Plan</span><span>Next step</span>
              <span>Status</span><span>Agents</span><span>Last outcome</span><span>Draft</span><span /></div>
            <div className="woe__group" role="presentation">In this goal · priority order · {included.length}</div>
            {visible.filter((r) => r.selected).map(renderRow)}
            {excluded.length ? <div className="woe__group" role="presentation">Not in this goal · {excluded.length}</div> : null}
            {visible.filter((r) => !r.selected).map(renderRow)}
            {!visible.length ? <p className="woe__empty">No plans {query ? 'match your search.' : 'are available.'}</p> : null}
          </div>
          {stale ? <div className="woe__warning" role="alert">The worklist changed while you were editing. Your draft is retained. Discard it to start from the current worklist.</div> : null}
          {problem ? <p className="woe__warning" role="alert">Could not apply: {problem}</p> : null}
          {notice ? <p className="woe__notice" role="status">{notice}</p> : null}
          {changes.length ? <div className="woe__draft-bar" role="region" aria-label="Pending changes">
            <span className="woe__draft-count">{changes.length}</span><div><strong>{changes.length} {changes.length === 1 ? 'plan' : 'plans'} changed · not applied yet</strong>
              <p>Scope and priority affect new work. Current agent owners stay assigned.</p></div>
            <div className="woe__actions"><button type="button" className="pc-ctl-act" disabled={locked} onClick={discard}>Discard</button>
              <button type="button" className="pc-ctl-act pc-ctl-act--primary" disabled={locked || stale}
                onClick={() => void setReviewOpen(true)}>Review &amp; apply</button></div></div> :
            <div className="woe__idle">✓ No pending changes. Edits stay in a draft until you apply them.</div>}
        </div><aside className="woe__inspector" aria-label="Plan inspector">
          <div className="woe__inspector-head">Plan inspector{selected ? <span className="hud__chip">{selected.state ?? 'Unavailable'}</span> : null}</div>
          {selected ? <div className="woe__inspector-body"><small>{selected.harness ?? 'Workspace plan'}</small><h3>{selected.label}</h3>
            <div className="woe__inspector-tabs" role="tablist" aria-label="Plan inspector sections">
              {(['summary', 'evidence', 'history'] as const).map((tab) => <button type="button" role="tab" key={tab}
                aria-selected={inspectorTab === tab} onClick={() => void setInspectorTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
            </div>
            <div role="tabpanel" aria-label={inspectorTab + ' for ' + selected.label}>
            {inspectorTab === 'summary' ? <><h4>Next step</h4><p>{selected.nextStep ?? 'Next step unavailable.'}</p>
              <h4>Why it’s here</h4><p>{selected.reason ?? 'This plan is in the goal’s active-workspace plan collection.'}</p>
              <h4>Progress</h4><dl><dt>Done tasks</dt><dd>{selected.counts ? selected.counts.done + ' / ' + Object.values(selected.counts).reduce((a, b) => a + b, 0) : 'Unmeasured'}</dd>
                <dt>Held live lane</dt><dd>{selected.liveLaneOwner ? 'Yes' : 'Unmeasured'}</dd>
                <dt>Plan fleet members</dt><dd>{selected.fleetMembers ?? 'Unmeasured'}</dd>
                <dt>In goal scope</dt><dd>{selected.selected ? 'Included' : 'Excluded'}</dd></dl>
              <p className="woe__muted">Ownership is measured. Future allocation depends on ready work, capacity, and the goal’s limits.</p></> :
            inspectorTab === 'evidence' ? <><h4>Recent completed outcomes</h4>
              {selected.outcomes?.length ? selected.outcomes.map((a) => <div className="woe__history-entry" key={a.id}>
                {onOpenWorkItem ? <button type="button" className="woe__link" onClick={() => onOpenWorkItem(a.id)}>{a.title}</button> : <strong>{a.title}</strong>}
                <small>{agoText(a.closedAt, nowMs)} · {a.id}</small></div>) : <p>No completed outcome was read for this plan.</p>}
              <p className="woe__muted">This is the bounded goal activity feed. Open the plan for its full evidence.</p></> :
            <><h4>Scope &amp; priority history</h4>{data.goalData?.historyError ? <p role="alert">{data.goalData.historyError}</p> :
              history.length ? history.map((h, i) => <div className="woe__history-entry" key={h.id + '-' + i}>
                <small>{agoText(h.at, nowMs)} · {h.actor}</small><strong>{h.label}</strong>{h.detail ? <p>{h.detail}</p> : null}</div>) :
                <p>No scope or priority change was read in the recent history window.</p>}
              <p className="woe__muted">Recent changes from the shared goal history; reasons also appear in plan history.</p></>}
            </div>
            <div className="woe__inspector-actions">{selected.harness && selected.planSlug && onOpenPlan ?
              <button type="button" className="pc-ctl-act" onClick={() => openPlan(selected)}>Open plan</button> : null}
              {owner && onOpenAgent ? <button type="button" className="pc-ctl-act" onClick={() => onOpenAgent(owner.ownerId)}>Ask steward</button> : null}</div>
          </div> : <p className="woe__empty">Select a plan to inspect.</p>}
        </aside></div>}
      </div>
      <footer className="woe__footer"><span>{view.status.label} · {owner ? 'Steward available' : 'Live steward unavailable'}</span>
        <span>Exclusions affect this goal’s new work; existing tasks finish with their owners.</span></footer>
    </section>
    <Modal open={reviewOpen && !!changes.length} onOpenChange={(open) => { if (!saving) void setReviewOpen(open); }}
      title="Review worklist changes" description="Compare scope and priority before applying" contentStyle={{ width: 'min(780px, 94vw)' }}>
      <div className="woe__review"><p>The steward uses the new scope and priority for future work. Already running tasks keep their current owners.</p>
        <div className="woe__diff"><div><h4>Now</h4><ol>{before.map((r) => <li key={r.id}>{r.label}</li>)}</ol></div>
          <div><h4>After apply</h4><ol>{included.map((r) => <li key={r.id} className={changes.some((c) => c.id === r.id) ? 'woe__diff-change' : ''}>{r.label}</li>)}</ol></div></div>
        <h4>Effect on agents</h4><p>Current owners are retained. Priority determines which ready work is considered next; future headcount is not measured.</p>
        {changes.filter((c) => c.label === 'Removing').map((c) => <p key={c.id}>
          {rows.find((r) => r.id === c.id)?.label}: excluded from new work by this goal.</p>)}
        <label className="woe__reason">Why? <small>Optional. Saved with this edit and shared in plan history.</small>
          <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3}
            placeholder="e.g. Desktop needs to ship before Friday’s demo" /></label>
        {stale ? <p role="alert">The saved worklist changed. Discard this draft and review the current list.</p> : null}
        {problem ? <p role="alert">{problem}</p> : null}
        <div className="woe__actions"><button type="button" className="pc-ctl-act" disabled={locked} onClick={() => void setReviewOpen(false)}>Keep editing</button>
          <button type="button" className="pc-ctl-act pc-ctl-act--primary" disabled={locked || stale} onClick={() => void apply()}>{saving ? 'Applying…' : 'Apply changes'}</button></div>
      </div>
    </Modal>
    <Modal open={settingsOpen} onOpenChange={(open) => void setSettingsOpen(open)} title="Ongoing work settings">
      <GoalSettingsSection goalId={goal.id} settings={data.launchSettings} settingsInvalid={data.launchSettingsInvalid}
        settingsUnknownKeys={data.launchSettingsUnknownKeys} options={data.launchSettingsOptions} defaults={data.launchSettingsDefaults} />
    </Modal>
  </Modal>;
}
