'use client';

import { useEffect, useRef, useState } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { ArrowDown, ArrowUp, Check, Infinity as InfinityIcon, Plus, RefreshCw, Search, Settings2,
  MessageSquare, X } from 'lucide-react';
import { Modal } from '@/app/harness/Modal';
import { TextInput, TextArea } from '@/app/harness/TextInput';
import { Tooltip } from '@/app/harness/Tooltip';
import GoalStatusControl from './GoalStatusControl';
import GoalSettingsSection from './GoalSettingsSection';
import { type GoalDetailInput } from './goal-detail-model';
import { ongoingWorkView } from './ongoing-work-model';
import { draftRows, moveDraft, toggleDraft, worklistChanges, type WorklistDraft } from './ongoing-work-draft';
import { STATE_KEYS, STATE_LABEL, completionSeries, filterAndSort, inScope, loadProblem, percent, progressRows,
  sumCounts, total, type PlanStateKey, type ProgressCounts, type ProgressRow } from './woe-progress-model';
import './WorkOnEverythingPanel.css';

const SCOPES = ['all', 'in', 'out'] as const;
const SORTS = ['left', 'pct', 'rank', 'name'] as const;
const SORT_LABEL = { left: 'Most work left', pct: 'Least finished', rank: 'Worklist order', name: 'Name' } as const;

const RUBRIC_DUTIES = [
  ['rubric-coverage-stewardship', 'Maintain rubric coverage', 'Reuse suitable rubrics. Create and review one when an important target has a gap.'],
  ['rubric-quality-stewardship', 'Improve rubric quality', 'Strengthen criteria and evidence requirements through reviewed, versioned changes.'],
  ['grading-correction-closure', 'Grade, improve and re-grade', 'Assign graders, preserve a baseline, verify repairs and compare the result.'],
] as const;

function RubricStewardship({ data, onOpenWorkItem }: { data: GoalDetailInput; onOpenWorkItem?: (id: string) => void }) {
  const quality = data.rubricStewardship;
  return <section className="woe__quality" aria-label="Rubric stewardship">
    <div className="woe__quality-heading"><h3>Rubrics &amp; continuous improvement</h3>
      <a className="woe__link" href="/rubrics" title="Browse the Work on everything stewardship rubric">
        Browse rubrics{quality?.rubricRevision ? ` · stewardship revision ${quality.rubricRevision}` : ''}</a></div>
    <div className="woe__quality-duties">{RUBRIC_DUTIES.map(([key, title, description]) => {
      const measured = quality?.criteria[key];
      return <div key={key}><h4>{title}</h4><p>{description}</p>
        <span className="woe__state" data-state={measured ? measured.rating : 'unmeasured'}>
          {measured?.rating ?? 'Not measured'}</span>
        {measured ? onOpenWorkItem ? <button type="button" className="woe__link" onClick={() => onOpenWorkItem(measured.scorecardRef)}
          title={measured.evidence}>View evidence</button> : <span>{measured.scorecardRef}</span> : null}</div>;
    })}</div>
    {quality?.error ? <p role="alert" className="woe__warning">{quality.error}</p> :
      !quality ? <p className="woe__muted">Quality evidence has not loaded. Refresh to check this goal’s grading activity.</p> :
      <><p className="woe__muted">Recent grading evidence · since {new Date(quality.windowStart).toLocaleDateString()}
        {!quality.complete ? ' · limited recent page; older evidence may be missing' : ''}</p>
        {quality.cycles.length ? <div className="woe__table-wrap"><table className="woe__table" aria-label="Grading cycles">
          <thead><tr><th>Target / rubric</th><th>Progress</th><th>Evidence</th></tr></thead>
          <tbody>{quality.cycles.map(c => <tr key={c.scorecardRef}><td><strong>{c.target}</strong>
            <small>{c.rubricRef}{c.rubricRevision ? ` · revision ${c.rubricRevision}` : ''}</small></td>
            <td><span className="woe__state" data-state={c.status}>{({ baseline: 'Baseline recorded', 'needs-repair': 'Repairs needed',
              'needs-regrade': 'Re-grade needed', unverified: 'Needs verification', incomparable: 'Fresh baseline needed', verified: 'Improvement verified' })[c.status]}</span>
              <p className="woe__muted">{c.reason}</p></td><td>
              {[...(c.baselineRef ? [{ ref: c.baselineRef, label: 'Baseline' }] : []),
                { ref: c.scorecardRef, label: 'Scorecard' }, ...c.repairRefs.map(ref => ({ ref, label: ref }))]
                .map(item => onOpenWorkItem ? <button key={item.ref} type="button" className="woe__link"
                  onClick={() => onOpenWorkItem(item.ref)}>{item.label}</button> : <span key={item.ref}>{item.ref} </span>)}
            </td></tr>)}</tbody></table></div> : <p className="woe__muted">No goal-attributed grading cycles are recorded in this window.</p>}</>}
  </section>;
}

function ProgressBar({ counts, large }: { counts: ProgressCounts | null | undefined; large?: boolean }) {
  if (!counts) return <span className="woe__muted">Not measured</span>;
  const t = total(counts);
  const seg = (n: number, key: string) => n ? <span className={'woe__seg woe__seg--' + key} style={{ width: `${(100 * n) / t}%` }} /> : null;
  return <span className={'woe__bar' + (large ? ' woe__bar--lg' : '')} role="img"
    aria-label={t ? `${counts.done} of ${t} items done` : 'No items'}
    title={`${counts.done} done · ${counts.wip} in progress · ${counts.needsHuman} need you · ${counts.blocked} blocked · ${counts.todo} to do`}>
    {seg(counts.done, 'done')}{seg(counts.wip, 'moving')}{seg(counts.needsHuman, 'you')}{seg(counts.blocked, 'stuck')}{seg(counts.todo, 'todo')}
  </span>;
}

export default function WorkOnEverythingPanel({ data, nowMs, onClose, onOpenPlan, onOpenWorkItem, onOpenAgent, refresh }: {
  data: GoalDetailInput; nowMs: number; onClose: () => void; refresh: () => void;
  onOpenPlan?: (harness: string, plan: string) => void;
  onOpenWorkItem?: (id: string) => void; onOpenAgent?: (owner: string) => void;
}) {
  const goal = data.goal!;
  const [query, setQuery] = useQueryState('hudwoesearch', parseAsString.withDefault(''));
  const [scope, setScope] = useQueryState('hudwoescope', parseAsStringEnum([...SCOPES]).withDefault('all'));
  const [stateFilter, setStateFilter] = useQueryState('hudwoestate', parseAsStringEnum<PlanStateKey>([...STATE_KEYS]));
  const [sort, setSort] = useQueryState('hudwoesort', parseAsStringEnum([...SORTS]).withDefault('left'));
  const [showEmpty, setShowEmpty] = useQueryState('hudwoeempty', parseAsBoolean.withDefault(false));
  const [reviewOpen, setReviewOpen] = useQueryState('hudwoereview', parseAsBoolean.withDefault(false));
  const [settingsOpen, setSettingsOpen] = useQueryState('hudwoesettings', parseAsBoolean.withDefault(false));
  const [draft, setDraft] = useState<WorklistDraft | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [awaitingVersion, setAwaitingVersion] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const unavailable = loadProblem(data);
  // Declared source identifies this collection; titles are freely editable.
  const collection = unavailable ? undefined : Object.values(data.goalData?.collections ?? {}).find((c) =>
    c.selection.ok && c.selection.configured && c.selection.collection.source === 'active-workspace-plans');
  const configured = collection?.selection.ok && collection.selection.configured ? collection.selection : null;
  const version = configured?.policyVersion ?? null;
  const rows = progressRows(collection ? draftRows(collection, draft) : []);
  const included = rows.filter((r) => r.selected);
  const changes = collection ? worklistChanges(collection, draft) : [];
  const stale = !!draft && draft.version !== version && awaitingVersion === null;
  const locked = saving || awaitingVersion !== null;
  const view = ongoingWorkView(goal, data);
  const owner = data.agents?.find((a) => a.live === true);
  const before = collection?.rows.filter((r) => r.selected) ?? [];
  const countable = rows.filter((r) => showEmpty || r.st.key !== 'empty');
  const scoped = countable.filter((r) => inScope(r, scope));
  const totals = sumCounts(scoped);
  const byState = (key: PlanStateKey) => scoped.filter((r) => r.st.key === key);
  const visible = filterAndSort(rows, { scope, state: stateFilter, showEmpty, query, sort });
  const series = completionSeries(data, nowMs);
  const seriesMax = Math.max(1, ...(series ?? []).map((d) => d.done));
  const emptyHidden = rows.filter((r) => r.st.key === 'empty').length;

  useEffect(() => {
    if (awaitingVersion !== null && version === awaitingVersion) {
      setDraft(null); setAwaitingVersion(null); setReason('');
      setNotice('Worklist applied. The steward uses it for new work; running tasks keep their owners.');
    } else if (awaitingVersion !== null && version !== null && version > awaitingVersion) {
      setAwaitingVersion(null);
      setProblem('A newer edit arrived before confirmation. Your draft is kept; compare it with the current worklist before continuing.');
    }
  }, [version, awaitingVersion]);

  function stage(next: WorklistDraft | null) {
    if (!collection || locked) return;
    setDraft(worklistChanges(collection, next).length ? next : null);
    setProblem(null); setNotice(null);
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
        throw new Error('The save did not return a version. Refresh to check the outcome; your draft is kept.');
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

  const tiles: Array<{ key: PlanStateKey | null; label: string; value: string; unit: string; sub: string }> = [
    { key: null, label: 'All work', value: totals.done.toLocaleString(), unit: `of ${total(totals).toLocaleString()} items done`,
      sub: `${percent(totals)}% complete across ${scoped.filter((r) => r.counts && total(r.counts)).length} plans with items` },
    { key: 'you', label: STATE_LABEL.you, value: String(totals.needsHuman), unit: 'items', sub: `in ${byState('you').length} plans` },
    { key: 'stuck', label: STATE_LABEL.stuck, value: String(byState('stuck').length), unit: 'plans', sub: `${totals.blocked} items wait on other items` },
    { key: 'moving', label: STATE_LABEL.moving, value: String(totals.wip), unit: 'items', sub: `in ${byState('moving').length} plans` },
    { key: 'idle', label: STATE_LABEL.idle, value: String(byState('idle').length), unit: 'plans',
      sub: `${byState('idle').reduce((n, r) => n + (r.counts?.todo ?? 0), 0)} items ready to start` },
    { key: 'signoff', label: STATE_LABEL.signoff, value: String(byState('signoff').length), unit: 'plans', sub: 'all items done' },
  ];

  const renderRow = (row: ProgressRow) => {
    const change = changes.find((c) => c.id === row.id);
    return <tr key={row.id} data-testid="ongoing-worklist-row" data-worklist-id={row.id}
      className={(row.selected ? '' : 'woe__row--out') + (change ? ' woe__row--changed' : '')}>
      <td className="woe__scope-cell">{row.selected
        ? <Tooltip label={`In the worklist (priority ${row.rank + 1}). Click to remove.`}>
          <button type="button" className="woe__scope woe__scope--in" disabled={locked} aria-label={'Remove ' + row.label}
            onClick={() => stage(toggleDraft(collection!, draft, row.id))}>#{row.rank + 1}</button></Tooltip>
        : <Tooltip label="Not in the worklist. Click to add.">
          <button type="button" className="woe__scope" disabled={locked} aria-label={'Add ' + row.label}
            onClick={() => stage(toggleDraft(collection!, draft, row.id))}><Plus size={12} aria-hidden />Add</button></Tooltip>}
        {row.selected && sort === 'rank' ? <span className="woe__reorder">
          <button type="button" disabled={locked || row.rank === 0} aria-label={'Move ' + row.label + ' up'}
            onClick={() => stage(moveDraft(collection!, draft, row.id, -1))}><ArrowUp size={12} aria-hidden /></button>
          <button type="button" disabled={locked || row.rank === included.length - 1} aria-label={'Move ' + row.label + ' down'}
            onClick={() => stage(moveDraft(collection!, draft, row.id, 1))}><ArrowDown size={12} aria-hidden /></button>
        </span> : null}
        {change ? <span className="woe__change">{change.label}</span> : null}</td>
      <td className="woe__plan">{row.harness && row.planSlug && onOpenPlan
        ? <button type="button" className="woe__plan-link" onClick={() => onOpenPlan(row.harness!, row.planSlug!)}>{row.label}</button>
        : <strong>{row.label}</strong>}
        <small>{[row.harness, row.planSlug].filter(Boolean).join(' · ') || row.id}</small></td>
      <td><span className="woe__progress-cell"><ProgressBar counts={row.counts} />
        {row.counts ? <span className="woe__num">{row.counts.done}/{total(row.counts)}</span> : null}</span></td>
      <td><span className="woe__state" data-state={row.st.key}><span aria-hidden />{row.st.label}</span></td>
      <td className="woe__why">{row.selected ? row.nextStep ?? row.st.why : row.st.why}</td>
    </tr>;
  };

  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={goal.title}
    description="Progress across every plan" srOnlyTitle contentStyle={{ width: 'min(1540px, 96vw)',
      maxWidth: 'none', height: 'min(940px, 94dvh)', padding: 0, display: 'flex', flexDirection: 'column' }}>
    <section className="woe" data-testid="work-on-everything-console" aria-label="Work on everything progress">
      <header className="woe__header"><div className="woe__identity"><span className="woe__mark"><InfinityIcon size={24} aria-hidden /></span>
        <div><div className="woe__title"><h2>{goal.title}</h2><span className={'hud__chip hud__chip--' + view.status.tone}>{view.status.label}</span></div>
        <p>Progress across every plan. Pick which ones the steward works on.</p></div></div>
        <div className="woe__actions"><span className="woe__budget">{view.spend ?? 'Spend unavailable'}{view.budget ? <small>Budget {view.budget}</small> : null}</span>
          <GoalStatusControl goalId={goal.id} status={goal.status}
            effectiveStatus={data.effectiveStatus} holderLiveness={data.holderLiveness} variant="card" />
          <button className="pc-ctl-act" type="button" onClick={() => void setSettingsOpen(true)}><span><Settings2 size={14} />Settings</span></button>
          {owner && onOpenAgent ? <button className="pc-ctl-act pc-ctl-act--primary" type="button"
            onClick={() => onOpenAgent(owner.ownerId)}><span><MessageSquare size={14} />Ask steward</span></button> : null}
          <button className="pc-ctl-act" type="button" aria-label="Close ongoing work" onClick={onClose}><X size={15} /></button>
        </div></header>
      {unavailable || !collection ? <div className="woe__body"><div className="woe__unavailable" role="alert">
        <h3>{unavailable?.title ?? 'Plans could not be loaded'}</h3><p>{unavailable?.detail ?? 'Retry; your saved worklist is unchanged.'}</p>
        <button type="button" className="pc-ctl-act" onClick={refresh}><span><RefreshCw size={14} aria-hidden />Retry</span></button></div></div> :
      <div className="woe__body">
        <div className="woe__kpis" role="group" aria-label="Totals">{tiles.map((t) =>
          <button type="button" key={t.label} className="woe__kpi" aria-pressed={t.key !== null && stateFilter === t.key}
            onClick={() => void setStateFilter(t.key === null || stateFilter === t.key ? null : t.key)}>
            <span className="woe__kpi-label">{t.key ? <i className={'woe__dot woe__dot--' + t.key} aria-hidden /> : null}{t.label}</span>
            <span className="woe__kpi-value">{t.value} <small>{t.unit}</small></span>
            {t.key === null ? <ProgressBar counts={totals} large /> : null}
            <span className="woe__kpi-sub">{t.sub}</span></button>)}</div>
        <RubricStewardship data={data} onOpenWorkItem={onOpenWorkItem} />
        <div className="woe__chart"><h3>Work finished per day for this goal{series ? ` (last ${series.length} days)` : ''}</h3>
          {series ? <svg viewBox={`0 0 ${series.length * 36} 96`} preserveAspectRatio="none" role="img"
            aria-label={`${series.reduce((n, d) => n + d.done, 0)} work items finished in the last ${series.length} days`}>
            {series.map((d, i) => <rect key={d.day} x={i * 36 + 4} width={28} rx={3}
              y={80 - (d.done / seriesMax) * 76} height={Math.max(1, (d.done / seriesMax) * 76)} className="woe__chart-bar">
              <title>{`${d.day}: ${d.done} finished`}</title></rect>)}
            {series.map((d, i) => i % 5 === 0 || i === series.length - 1 ? <text key={'t' + d.day} x={i * 36 + 18} y={94}
              textAnchor="middle" className="woe__chart-label">{d.day.slice(5).replace('-', '/')}</text> : null)}
          </svg> : <p className="woe__muted">Daily history needs a newer server build.</p>}</div>
        {configured?.seededFromList ? <p className="woe__seeded" role="status">Your worklist starts from the {included.length} plans
          saved on this goal. The first change you apply saves it as your own pick list.</p> : null}
        <div className="woe__toolbar">
          <div className="woe__seg-group" role="group" aria-label="Scope">{SCOPES.map((s) => {
            const n = countable.filter((r) => inScope(r, s)).length;
            return <button type="button" key={s} aria-pressed={scope === s} onClick={() => void setScope(s)}>
              {s === 'all' ? `All plans · ${n}` : s === 'in' ? `In worklist · ${n}` : `Not in worklist · ${n}`}</button>;
          })}</div>
          <label className="woe__toggle"><input type="checkbox" checked={showEmpty}
            onChange={(e) => void setShowEmpty(e.target.checked)} /> Show plans with no items</label>
          <select aria-label="Sort plans" value={sort} onChange={(e) => void setSort(e.target.value as typeof sort)}>
            {SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}</select>
          <label className="woe__search"><TextInput leading={<Search size={15} />} style={{ width: '100%' }}
            aria-label="Search plans" placeholder="Search plans…" value={query}
            onChange={(e) => void setQuery(e.target.value)} /></label>
        </div>
        {stateFilter ? <p className="woe__filter-note">Showing only “{STATE_LABEL[stateFilter]}”.
          <button type="button" className="woe__link" onClick={() => void setStateFilter(null)}>Clear filter</button></p> : null}
        <div className="woe__table-wrap"><table className="woe__table" aria-label="Plans">
          <thead><tr><th>Worklist</th><th>Plan</th><th>Progress</th><th>State</th><th>Why / next step</th></tr></thead>
          <tbody>{visible.map(renderRow)}</tbody></table>
          {!visible.length ? <p className="woe__empty">{rows.length ? 'No plans match these filters.' : 'No active plans are available.'}</p> : null}</div>
        <div className="woe__table-foot"><span className="woe__legend">{(['done', 'moving', 'you', 'stuck', 'todo'] as const).map((k) =>
          <span key={k}><i className={'woe__dot woe__dot--' + k} aria-hidden />{{ done: 'Done', moving: 'In progress', you: 'Needs you', stuck: 'Blocked', todo: 'To do' }[k]}</span>)}</span>
          <span>Showing {visible.length} of {rows.length} plans{!showEmpty && emptyHidden ? ` · ${emptyHidden} with no items hidden` : ''}</span></div>
        {stale ? <div className="woe__warning" role="alert">The worklist changed while you were editing. Your draft is kept. Discard it to start from the current worklist.</div> : null}
        {problem ? <p className="woe__warning" role="alert">Could not apply: {problem}</p> : null}
        {notice ? <p className="woe__notice" role="status">{notice}</p> : null}
        {changes.length ? <div className="woe__draft-bar" role="region" aria-label="Pending changes">
          <span className="woe__draft-count">{changes.length}</span><div><strong>{changes.length} {changes.length === 1 ? 'plan' : 'plans'} changed</strong>
            <p>Draft only. Review before changing the worklist.</p></div>
          <div className="woe__actions"><button type="button" className="pc-ctl-act" disabled={locked} onClick={discard}>Discard</button>
            <button type="button" className="pc-ctl-act pc-ctl-act--primary" disabled={locked || stale}
              onClick={() => void setReviewOpen(true)}>Review &amp; apply</button></div></div> :
          <div className="woe__idle"><Check size={15} aria-hidden /><span>No pending changes. Add or remove plans to start a draft.</span></div>}
      </div>}
      <footer className="woe__footer"><span><span className={'woe__live-dot' + (owner ? ' woe__live-dot--available' : '')} aria-hidden />{view.status.label} · {owner ? 'Steward available' : 'Live steward unavailable'}</span>
        <span>Changes apply to new work. Running tasks stay assigned.</span></footer>
    </section>
    <Modal open={reviewOpen && !!changes.length} onOpenChange={(open) => { if (!saving) void setReviewOpen(open); }}
      title="Review worklist changes" description="Compare scope and priority before applying" contentStyle={{ width: 'min(780px, 94vw)' }}>
      <div className="woe__review"><p>The steward uses the new scope and priority for future work. Already running tasks keep their current owners.</p>
        <div className="woe__diff"><div><h4>Now</h4><ol>{before.map((r) => <li key={r.id}>{r.label}</li>)}</ol></div>
          <div><h4>After apply</h4><ol>{included.map((r) => <li key={r.id} className={changes.some((c) => c.id === r.id) ? 'woe__diff-change' : ''}>{r.label}</li>)}</ol></div></div>
        <h4>Effect on agents</h4><p>Only plans in the worklist get new work from this goal. Current owners are kept.</p>
        {changes.filter((c) => c.label === 'Removing').map((c) => <p key={c.id}>
          {rows.find((r) => r.id === c.id)?.label}: no new work from this goal.</p>)}
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
