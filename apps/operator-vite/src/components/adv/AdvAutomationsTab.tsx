import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleDollarSign,
  DatabaseZap,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Workflow,
} from 'lucide-react';
import type { AutomationCatalog } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import type { PlanInputSchemaInfo } from '@/app/admin/plans/plans-api';
import { fetchPlanInputs } from '@/app/admin/plans/plans-api';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { runScheduleTool } from './ScheduleEditor';
import {
  buildAutomationActivity,
  buildAutomationItems,
  buildAutomationSources,
  filterAutomationItems,
  relativeTime,
  type AutomationActivityItem,
  type AutomationFilter,
  type AutomationItem,
  type AutomationOccurrenceRow,
  type AutomationPlanRow,
  type AutomationScheduleRow,
} from './automations-model';
import './adv-automations.css';

type View = 'catalog' | 'activity' | 'sources';

interface RunRow {
  id: number;
  status: string;
  trigger: string | null;
  outcome: string | null;
  launchedAt: number;
  durationMs: number | null;
  costUsd: number;
}

interface RunHistoryRow {
  runs: RunRow[];
  rollup: {
    total: number;
    successRate: number;
    totalCostUsd: number;
    medianDurationMs: number | null;
    running: number;
    failed: number;
  } | null;
}

const FILTERS: Array<{ id: AutomationFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'triggered', label: 'Triggered plans' },
  { id: 'ai', label: 'AI routines' },
  { id: 'system', label: 'System tasks' },
  { id: 'paused', label: 'Paused' },
];

function kindLabel(kind: AutomationItem['kind']): string {
  if (kind === 'triggered-plan') return 'Triggered plan';
  if (kind === 'ai-routine') return 'AI routine';
  return 'System task';
}

function itemState(item: AutomationItem): string {
  if (item.needsAttention) return 'Needs attention';
  if (item.running) return 'Running';
  if (item.paused) return 'Paused';
  return 'Ready';
}

function durationLabel(ms: number | null): string {
  if (ms == null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export default function AdvAutomationsTab() {
  const [view, setView] = useQueryState(
    'autoView',
    parseAsStringEnum<View>(['catalog', 'activity', 'sources']).withDefault('catalog'),
  );
  const [filter, setFilter] = useQueryState(
    'autoFilter',
    parseAsStringEnum<AutomationFilter>(['all', 'triggered', 'ai', 'system', 'paused']).withDefault('all'),
  );
  const [selectedId, setSelectedId] = useQueryState('autoId', parseAsString);
  const [query, setQuery] = useQueryState('autoQ', parseAsString.withDefault(''));
  const [, setAdvTab] = useQueryState('tab', parseAsString);
  const [, setCalendarPlan] = useQueryState('calPlan', parseAsString);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);

  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 15_000,
  });
  const catalog = catalogQuery.data?.[0] ?? null;

  const projectsQuery = useSyncQuery<{ slug: string }>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
  });
  const harnessSlugs = useMemo(
    () => (projectsQuery.data ?? []).map((row) => row.slug).filter(Boolean),
    [projectsQuery.data],
  );
  const plansQuery = useSyncQuery<AutomationPlanRow>({
    queryName: 'plans.list',
    args: harnessSlugs.length > 0 ? { harness_slugs: harnessSlugs } : {},
  });
  const schedulesQuery = useSyncQuery<AutomationScheduleRow>({
    queryName: 'plans.schedule',
    args: {},
  });
  const occurrenceWindow = useMemo(() => {
    const now = Date.now();
    return { rangeStartMs: now, rangeEndMs: now + 30 * 24 * 60 * 60 * 1000 };
  }, []);
  const occurrencesQuery = useSyncQuery<AutomationOccurrenceRow>({
    queryName: 'plans.scheduledOccurrences',
    args: occurrenceWindow,
  });

  const [external, setExternal] = useState<ExternalTriggerAdminSnapshot | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const loadExternal = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/triggers', { cache: 'no-store' });
      const body = await response.json() as ExternalTriggerAdminSnapshot & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
      setExternal(body);
      setExternalError(null);
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => { void loadExternal(); }, [loadExternal]);

  const modelInput = useMemo(() => ({
    catalog,
    plans: plansQuery.data ?? [],
    schedules: schedulesQuery.data ?? [],
    occurrences: occurrencesQuery.data ?? [],
    external,
  }), [catalog, external, occurrencesQuery.data, plansQuery.data, schedulesQuery.data]);
  const items = useMemo(() => buildAutomationItems(modelInput), [modelInput]);
  const visibleItems = useMemo(
    () => filterAutomationItems(items, filter, query),
    [filter, items, query],
  );
  const selected = items.find((item) => item.id === selectedId) ?? visibleItems[0] ?? items[0] ?? null;
  const activity = useMemo(() => buildAutomationActivity(modelInput), [modelInput]);
  const sources = useMemo(() => buildAutomationSources(modelInput), [modelInput]);

  const [inputs, setInputs] = useState<PlanInputSchemaInfo | null>(null);
  useEffect(() => {
    let live = true;
    setInputs(null);
    if (!selected?.planSlug) return () => { live = false; };
    void fetchPlanInputs(selected.planSlug, selected.harness)
      .then((result) => {
        if (live && result.ok) setInputs(result);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [selected?.harness, selected?.planSlug]);

  const runHistoryQuery = useSyncQuery<RunHistoryRow>({
    queryName: 'plans.runHistory',
    args: selected?.planSlug
      ? { planSlug: selected.planSlug, ...(selected.harness ? { harnessSlug: selected.harness } : {}) }
      : { planSlug: '__none__' },
    enabled: Boolean(selected?.planSlug),
  });
  const runHistory = runHistoryQuery.data?.[0] ?? null;

  const refreshAll = useCallback(() => {
    void catalogQuery.invalidate?.();
    void plansQuery.invalidate?.();
    void schedulesQuery.invalidate?.();
    void occurrencesQuery.invalidate?.();
    void runHistoryQuery.invalidate?.();
    void loadExternal();
  }, [catalogQuery, loadExternal, occurrencesQuery, plansQuery, runHistoryQuery, schedulesQuery]);

  const invoke = useCallback(async (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(key);
    try {
      const result = await runScheduleTool(tool, args);
      if (!result.ok) throw new Error(result.message ?? `${tool} failed`);
      toast.success(success);
      refreshAll();
    } catch (error) {
      toast.error('Automation control failed', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }, [refreshAll]);

  const setBindingArmed = useCallback(async (bindingId: string, armed: boolean) => {
    setBusy(`binding:${bindingId}`);
    try {
      const response = await fetch('/api/admin/triggers', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'set-armed', id: bindingId, armed, confirm: true }),
      });
      const body = await response.json() as { detail?: string; error?: string };
      if (!response.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${response.status}`);
      toast.success(armed ? 'Trigger armed' : 'Trigger paused');
      refreshAll();
    } catch (error) {
      toast.error('Trigger control failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [refreshAll]);

  const toggleRoutine = useCallback(async (item: AutomationItem) => {
    const routine = item.routine;
    if (!routine || !routine.controllable) return;
    const next = !routine.active;
    if (!next && !(await confirm({
      title: `Pause ${item.label}?`,
      body: 'Its schedule remains visible, but it will stop firing until resumed.',
      confirmLabel: 'Pause automation',
      destructive: true,
    }))) return;
    setBusy(`routine:${item.id}`);
    try {
      if (routine.control === 'flag') {
        if (!routine.flagKey) throw new Error('Flag-controlled automation has no flag key');
        const result = await runScheduleTool('flags:set', {
          key: routine.flagKey,
          enabled: next,
          reason: `Changed from the Automations tab`,
        });
        if (!result.ok) throw new Error(result.message ?? 'Flag update failed');
      } else {
        for (const installSlug of routine.installs) {
          const result = await runScheduleTool('routines:set', {
            name: routine.name,
            installSlug,
            active: next,
            ...(next ? {} : { reason: 'Paused from the Automations tab' }),
          });
          if (!result.ok) throw new Error(result.message ?? `Routine update failed for ${installSlug}`);
        }
      }
      toast.success(next ? 'Automation resumed' : 'Automation paused');
      refreshAll();
    } catch (error) {
      toast.error('Automation control failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  const pauseAutomaticTriggers = useCallback(async (item: AutomationItem) => {
    if (!item.planSlug) return;
    const automatic = item.triggers.filter((trigger) => trigger.kind !== 'manual' && trigger.armed === true);
    if (automatic.length === 0) return;
    if (!(await confirm({
      title: `Pause automatic triggers for ${item.label}?`,
      body: 'Schedules and external event bindings will stop firing. Manual Run now remains available.',
      confirmLabel: 'Pause triggers',
      destructive: true,
    }))) return;
    setBusy(`pause:${item.id}`);
    try {
      for (const trigger of automatic) {
        if (trigger.kind === 'schedule') {
          const result = await runScheduleTool('plans:disarm-schedule', {
            slug: item.planSlug,
            ...(item.harness ? { harness: item.harness } : {}),
          });
          if (!result.ok) throw new Error(result.message ?? 'Schedule pause failed');
        } else if (trigger.bindingId) {
          const response = await fetch('/api/admin/triggers', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'set-armed', id: trigger.bindingId, armed: false, confirm: true }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { detail?: string };
            throw new Error(body.detail ?? `External trigger pause failed (${response.status})`);
          }
        }
      }
      toast.success('Automatic triggers paused');
      refreshAll();
    } catch (error) {
      toast.error('Pause failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  const loading = catalogQuery.loading || plansQuery.loading || schedulesQuery.loading;
  const attentionCount = items.filter((item) => item.needsAttention).length;
  const runningCount = items.filter((item) => item.running).length;
  const nextAt = items.reduce<number | null>((current, item) => item.nextAt != null && (current == null || item.nextAt < current) ? item.nextAt : current, null);

  return (
    <section className="pc-automations" aria-label="Automations">
      {confirmElement}
      <header className="pc-automations__masthead">
        <div>
          <div className="pc-automations__eyebrow">Workspace control plane</div>
          <h1>Automations</h1>
          <p>Everything that can run in the background—what starts it, whether it is running, what it can spend, and how to stop it.</p>
        </div>
        <div className="pc-automations__mast-actions">
          <button type="button" className="pc-automations__ghost" onClick={refreshAll} aria-label="Refresh automations">
            <span className="pc-automations__button-inner"><RefreshCw size={14} aria-hidden /> Refresh</span>
          </button>
          <button type="button" className="pc-automations__primary" onClick={() => void setAdvTab('plans')}>
            <span className="pc-automations__button-inner"><Plus size={14} aria-hidden /> New automation</span>
          </button>
        </div>
      </header>

      <div className="pc-automations__viewbar">
        <nav aria-label="Automation views">
          {(['catalog', 'activity', 'sources'] as const).map((candidate) => (
            <button key={candidate} type="button" data-active={view === candidate} onClick={() => void setView(candidate)}>
              <span className="pc-automations__viewtab-inner">
                {candidate === 'catalog' ? 'Catalog' : candidate === 'activity' ? 'Activity' : 'Sources'}
                <span className="pc-automations__viewtab-count">{candidate === 'catalog' ? items.length : candidate === 'activity' ? activity.length : sources.length}</span>
              </span>
            </button>
          ))}
        </nav>
        <span>Schedule ≠ active run ≠ budget permission</span>
      </div>

      {externalError ? (
        <div className="pc-automations__notice" role="status">
          External sources are temporarily unavailable: {externalError}. Routine and schedule data remain live.
        </div>
      ) : null}

      {view === 'catalog' ? (
        <>
          <div className="pc-automations__metrics" aria-label="Automation summary">
            <Metric icon={AlertTriangle} label="Needs attention" value={String(attentionCount)} tone={attentionCount > 0 ? 'warn' : 'good'} />
            <Metric icon={Play} label="Running now" value={String(runningCount)} tone={runningCount > 0 ? 'blue' : 'neutral'} />
            <Metric icon={CalendarClock} label="Next run" value={nextAt == null ? '—' : relativeTime(nextAt)} tone="neutral" />
            <Metric icon={CircleDollarSign} label="Spend · 7 days" value={`$${(catalog?.spend7dTotalUsd ?? 0).toFixed(2)}`} tone="spend" />
          </div>

          <div className="pc-automations__filters">
            <div role="group" aria-label="Filter automations">
              {FILTERS.map((candidate) => (
                <button key={candidate.id} type="button" data-active={filter === candidate.id} onClick={() => void setFilter(candidate.id)}>
                  {candidate.label}
                </button>
              ))}
            </div>
            <label>
              <Search size={13} aria-hidden />
              <input value={query} onChange={(event) => void setQuery(event.target.value)} placeholder="Search automations" aria-label="Search automations" />
            </label>
          </div>

          <div className="pc-automations__workspace">
            <div className="pc-automations__catalog">
              <div className="pc-automations__panelhead">
                <strong>Automation catalog</strong>
                <span>{visibleItems.length} shown · attention first, then next run</span>
              </div>
              {loading && items.length === 0 ? <div className="pc-automations__empty">Loading automations…</div> : null}
              {!loading && visibleItems.length === 0 ? <div className="pc-automations__empty">No automations match this filter.</div> : null}
              <div className="pc-automations__rows">
                {visibleItems.map((item) => (
                  <AutomationRow key={item.id} item={item} selected={selected?.id === item.id} onSelect={() => void setSelectedId(item.id)} />
                ))}
              </div>
            </div>
            <AutomationDetail
              item={selected}
              inputs={inputs}
              runs={runHistory}
              busy={busy}
              onRun={() => selected?.planSlug && void invoke(
                `run:${selected.id}`,
                'plans:run-now',
                { slug: selected.planSlug, ...(selected.harness ? { harness: selected.harness } : {}) },
                `${selected.label} started`,
              )}
              onToggleSchedule={(armed) => selected?.planSlug && void invoke(
                `schedule:${selected.id}`,
                armed ? 'plans:arm-schedule' : 'plans:disarm-schedule',
                { slug: selected.planSlug, ...(selected.harness ? { harness: selected.harness } : {}) },
                armed ? 'Schedule armed' : 'Schedule paused',
              )}
              onToggleBinding={(id, armed) => void setBindingArmed(id, armed)}
              onToggleRoutine={() => selected && void toggleRoutine(selected)}
              onPauseAll={() => selected && void pauseAutomaticTriggers(selected)}
              onEditSchedule={() => {
                if (!selected?.planSlug) return;
                void setCalendarPlan(selected.planSlug);
                void setAdvTab('calendar');
              }}
            />
          </div>
        </>
      ) : view === 'activity' ? (
        <ActivityView activity={activity} spend={catalog?.spend7d ?? []} onOpen={(item) => {
          if (item.automationId) void setSelectedId(item.automationId);
          void setView('catalog');
        }} />
      ) : (
        <SourcesView sources={sources} />
      )}
    </section>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Activity; label: string; value: string; tone: string }) {
  return (
    <div className="pc-automations__metric" data-tone={tone}>
      <span><Icon size={14} aria-hidden /> {label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AutomationRow({ item, selected, onSelect }: { item: AutomationItem; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="pc-automations__row" data-selected={selected} data-state={itemState(item).toLowerCase().replaceAll(' ', '-')} onClick={onSelect}>
      <span className="pc-automations__row-layout">
        <span className="pc-automations__row-main">
          <span className="pc-automations__row-title">
            <i aria-hidden /> <strong>{item.label}</strong><em>{kindLabel(item.kind)}</em>
          </span>
          <span className="pc-automations__row-copy">{item.description}</span>
          {item.triggers.length > 0 ? (
            <span className="pc-automations__chips">
              {item.triggers.slice(0, 5).map((trigger) => <span key={trigger.id}>{trigger.provider}</span>)}
            </span>
          ) : null}
        </span>
        <span className="pc-automations__row-state">
          <strong>{item.timingLabel}</strong>
          <small>{item.running ? 'Live execution observed' : item.lastAt ? `Last ${relativeTime(item.lastAt)}` : itemState(item)}</small>
        </span>
        <span className="pc-automations__row-spend">
          <strong>{item.spendLabel}</strong>
          <small>{item.kind === 'triggered-plan' ? 'Verified costs shown per run' : 'No guessed routine attribution'}</small>
        </span>
        <ChevronRight size={15} aria-hidden />
      </span>
    </button>
  );
}

function AutomationDetail({
  item,
  inputs,
  runs,
  busy,
  onRun,
  onToggleSchedule,
  onToggleBinding,
  onToggleRoutine,
  onPauseAll,
  onEditSchedule,
}: {
  item: AutomationItem | null;
  inputs: PlanInputSchemaInfo | null;
  runs: RunHistoryRow | null;
  busy: string | null;
  onRun: () => void;
  onToggleSchedule: (armed: boolean) => void;
  onToggleBinding: (id: string, armed: boolean) => void;
  onToggleRoutine: () => void;
  onPauseAll: () => void;
  onEditSchedule: () => void;
}) {
  if (!item) return <aside className="pc-automations__detail"><div className="pc-automations__empty">Select an automation.</div></aside>;
  const automatic = item.triggers.filter((trigger) => trigger.kind !== 'manual');
  const runRows = runs?.runs.slice(0, 5) ?? [];
  return (
    <aside className="pc-automations__detail" aria-label="Automation details">
      <div className="pc-automations__panelhead"><strong>Automation details</strong><span>one identity across every view</span></div>
      <div className="pc-automations__detailbody">
        <div className="pc-automations__detail-kicker">{kindLabel(item.kind)} · {itemState(item)}</div>
        <h2>{item.label}</h2>
        <p>{item.description}</p>
        <div className="pc-automations__statechips">
          <span data-tone={item.paused ? 'warn' : 'good'}>{item.paused ? 'Paused' : 'Enabled'}</span>
          <span data-tone={item.running ? 'blue' : 'neutral'}>{item.running ? 'Running' : 'Not running'}</span>
          {item.needsAttention ? <span data-tone="warn">Needs attention</span> : null}
        </div>

        <div className="pc-automations__detailgrid">
          <DetailCard label="Next scheduled" value={item.nextAt ? relativeTime(item.nextAt) : 'None'} />
          <DetailCard label="Last activity" value={item.lastAt ? relativeTime(item.lastAt) : 'No run recorded'} />
          <DetailCard label="Plan inputs" value={inputs ? `${inputs.required.length} required · ${inputs.ready ? 'ready' : `${inputs.missing.length} missing`}` : item.planSlug ? 'Checking…' : 'Not a plan'} />
          <DetailCard label="Run-linked cost" value={runs?.rollup ? `$${runs.rollup.totalCostUsd.toFixed(2)} · ${runs.rollup.total} runs` : 'No verified run cost'} />
        </div>

        <section className="pc-automations__trigger-section">
          <header><strong>Triggers</strong><span>installed and armed are separate</span></header>
          {item.triggers.map((trigger) => (
            <div className="pc-automations__trigger" key={trigger.id}>
              <span>{trigger.provider}</span>
              <div><strong>{trigger.label}</strong><small>{trigger.detail}</small></div>
              {trigger.kind === 'manual' ? <em data-on={inputs?.ready === true}> {inputs?.ready === false ? 'Blocked' : 'Ready'} </em> : (
                <button
                  type="button"
                  disabled={busy != null || trigger.armed == null || (trigger.kind === 'external' && !trigger.bindingId)}
                  onClick={() => {
                    if (trigger.kind === 'schedule') onToggleSchedule(trigger.armed !== true);
                    else if (trigger.bindingId) onToggleBinding(trigger.bindingId, trigger.armed !== true);
                  }}
                >
                  <span className="pc-automations__button-inner">{trigger.armed == null ? 'Unknown' : trigger.armed ? 'Armed' : 'Paused'}</span>
                </button>
              )}
            </div>
          ))}
          {item.triggers.length === 0 ? <div className="pc-automations__empty">No installed triggers.</div> : null}
        </section>

        <section className="pc-automations__cost">
          <header><span>Spend & permission</span><strong>{item.spendLabel}</strong></header>
          <p>{item.kind === 'triggered-plan'
            ? 'Costs come from runs linked to this plan. A schedule never proves a run happened.'
            : 'Routine-level dollars are not inferred from role totals; only the ability to spend is shown.'}</p>
        </section>

        <div className="pc-automations__actions">
          {item.planSlug ? <button type="button" className="is-primary" disabled={busy != null || inputs?.ready === false} onClick={onRun}><span className="pc-automations__button-inner"><Play size={13} aria-hidden /> Run now</span></button> : null}
          {item.planSlug ? <button type="button" disabled={busy != null} onClick={onEditSchedule}><span className="pc-automations__button-inner"><CalendarClock size={13} aria-hidden /> Edit schedule</span></button> : null}
          {item.routine?.controllable ? <button type="button" disabled={busy != null} onClick={onToggleRoutine}><span className="pc-automations__button-inner"><Power size={13} aria-hidden /> {item.routine.active ? 'Pause' : 'Resume'}</span></button> : null}
          {automatic.some((trigger) => trigger.armed === true) ? <button type="button" className="is-warn" disabled={busy != null} onClick={onPauseAll}><span className="pc-automations__button-inner"><Power size={13} aria-hidden /> Pause automatic triggers</span></button> : null}
        </div>

        <section className="pc-automations__history">
          <header><strong>Recent activity</strong>{runs?.rollup ? <span>{Math.round(runs.rollup.successRate * 100)}% success · median {durationLabel(runs.rollup.medianDurationMs)}</span> : null}</header>
          {runRows.map((run) => (
            <div key={run.id}><i data-status={run.outcome ?? run.status} /><span>{run.trigger ?? run.status} · {run.outcome ?? run.status} · {relativeTime(run.launchedAt)}</span><em>{run.costUsd > 0 ? `$${run.costUsd.toFixed(2)}` : '—'}</em></div>
          ))}
          {runRows.length === 0 ? <p>No plan-run history yet.</p> : null}
        </section>
      </div>
    </aside>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function ActivityView({
  activity,
  spend,
  onOpen,
}: {
  activity: AutomationActivityItem[];
  spend: AutomationCatalog['spend7d'];
  onOpen: (item: AutomationActivityItem) => void;
}) {
  return (
    <div className="pc-automations__activity-layout">
      <div className="pc-automations__widepanel">
        <div className="pc-automations__panelhead"><strong>Automation activity</strong><span>external runs and routine fires · newest first</span></div>
        <div className="pc-automations__activity">
          {activity.map((item) => (
            <button type="button" key={item.id} onClick={() => onOpen(item)}>
              <span className="pc-automations__activity-row-layout"><i data-status={item.status} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><em>{item.status}</em><time>{relativeTime(item.at)}</time></span>
            </button>
          ))}
          {activity.length === 0 ? <div className="pc-automations__empty">No automation activity has been recorded yet.</div> : null}
        </div>
      </div>
      <div className="pc-automations__widepanel pc-automations__spend-panel">
        <div className="pc-automations__panelhead"><strong>Workspace spend · 7 days</strong><span>by agent role · not guessed per routine</span></div>
        <div className="pc-automations__spend-rows">
          {spend.map((row) => (
            <div key={`${row.role}:${row.modelClass ?? ''}`}>
              <span><strong>{row.role}</strong><small>{row.modelClass ?? 'model class unavailable'} · {row.turns} turns</small></span>
              <span><strong>${row.costUsd.toFixed(2)}</strong><small>{row.outputTokens.toLocaleString()} output tokens</small></span>
            </div>
          ))}
          {spend.length === 0 ? <div className="pc-automations__empty">No model spend recorded in this window.</div> : null}
        </div>
      </div>
    </div>
  );
}

function SourcesView({ sources }: { sources: ReturnType<typeof buildAutomationSources> }) {
  return (
    <div className="pc-automations__widepanel">
      <div className="pc-automations__panelhead"><strong>Trigger sources</strong><span>connection health and installed bindings</span></div>
      <div className="pc-automations__sources">
        {sources.map((source) => (
          <article key={source.id}>
            <div className="pc-automations__source-icon">{source.kind === 'schedule' ? <CalendarClock size={18} /> : source.kind === 'manual' ? <Workflow size={18} /> : <DatabaseZap size={18} />}</div>
            <div><strong>{source.label}</strong><span>{source.detail}</span></div>
            <dl><div><dt>State</dt><dd>{source.status}</dd></div><div><dt>Bindings</dt><dd>{source.armedCount}/{source.bindingCount} armed</dd></div></dl>
          </article>
        ))}
      </div>
    </div>
  );
}
