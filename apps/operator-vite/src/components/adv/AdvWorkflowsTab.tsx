import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
  X,
} from 'lucide-react';
import type { AutomationCatalog } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import type { PlanInputSchemaInfo } from '@/app/admin/plans/plans-api';
import { fetchPlanInputs } from '@/app/admin/plans/plans-api';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { Modal } from '@/app/harness/Modal';
import { Select } from '@/app/harness/Select';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { runScheduleTool } from './ScheduleEditor';
import {
  buildAutomationActivity,
  buildAutomationFlows,
  buildAutomationItems,
  buildAutomationSources,
  filterAutomationItems,
  nextFutureAutomationAt,
  relativeTime,
  type AutomationActivityItem,
  type AutomationFilter,
  type AutomationItem,
  type AutomationOccurrenceRow,
  type AutomationPlanRow,
  type AutomationScheduleRow,
} from './workflows-model';
import WorkflowsLanding from './WorkflowsLanding';
import WorkflowDetailView from './WorkflowDetailView';
import { toLandingWorkflow, type NeedsYouItem } from './workflows-landing-model';
import './adv-workflows.css';

type View = 'landing' | 'flow' | 'catalog' | 'activity' | 'sources';

/**
 * The view bar's tabs, in order. A table rather than a chain of ternaries: the
 * landing (D-018) makes this five-way, and a 5-deep nested ternary in JSX is the
 * shape the legibility guard exists to catch.
 */
const VIEW_TABS: readonly { readonly id: View; readonly label: string }[] = [
  { id: 'landing', label: 'Overview' },
  { id: 'flow', label: 'Flows' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'activity', label: 'Activity' },
  { id: 'sources', label: 'Sources' },
];
type FlowFilter = 'all' | 'attention' | 'paused';
type CreateTriggerKind = 'schedule' | 'external';
type CreatePlanMode = 'existing' | 'new';
type SchedulePreset = 'every-15-minutes' | 'hourly' | 'daily' | 'weekly';

interface CreatePlanRef {
  slug: string;
  harness: string;
  title: string;
}

interface PendingArm {
  kind: CreateTriggerKind;
  plan: CreatePlanRef;
  sourceLabel: string;
  bindingId?: string;
}

interface CreationResult extends PendingArm {
  armed: true;
}

const SCHEDULE_PRESETS: Record<SchedulePreset, { label: string; cron: string }> = {
  'every-15-minutes': { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  hourly: { label: 'Hourly', cron: '0 * * * *' },
  daily: { label: 'Daily at 09:00', cron: '0 9 * * *' },
  weekly: { label: 'Weekly · Monday at 09:00', cron: '0 9 * * 1' },
};

function planRefKey(plan: Pick<CreatePlanRef, 'harness' | 'slug'>): string {
  return `${plan.harness}:${plan.slug}`;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function uniqueDatedPlanSlug(title: string, plans: readonly AutomationPlanRow[]): string {
  const normalized = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'automation-plan';
  const base = normalized.length >= 3 ? normalized : `automation-${normalized}`;
  const date = new Date().toISOString().slice(0, 10);
  const existing = new Set(plans.map((plan) => plan.slug));
  let candidate = `${base}-${date}`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}-${date}`;
    suffix += 1;
  }
  return candidate;
}

function inlinePlanContent(outcome: string, triggerLabel: string): string {
  const delivery = outcome.replace(/\s+/g, ' ').trim();
  return [
    '## Now',
    '',
    `State: Ready for its ${triggerLabel.toLocaleLowerCase()} trigger.`,
    `Next: ${delivery}`,
    '',
    '## Background',
    '',
    `Created in place from Workflows for a real ${triggerLabel.toLocaleLowerCase()} trigger.`,
    '',
    '## Delivery',
    '',
    `- **P-001** \`todo\` ${delivery} importance: normal`,
    '',
    '## Decisions',
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export default function AdvWorkflowsTab() {
  const resolvedHarnessSlug = useResolvedHarnessSlug();
  const [view, setView] = useQueryState(
    'wfView',
    parseAsStringEnum<View>(['landing', 'flow', 'catalog', 'activity', 'sources']).withDefault('landing'),
  );
  const [flowFilter, setFlowFilter] = useQueryState(
    'wfFlowFilter',
    parseAsStringEnum<FlowFilter>(['all', 'attention', 'paused']).withDefault('all'),
  );
  const [filter, setFilter] = useQueryState(
    'wfFilter',
    parseAsStringEnum<AutomationFilter>(['all', 'triggered', 'ai', 'system', 'paused']).withDefault('all'),
  );
  const [selectedId, setSelectedId] = useQueryState('wfSelId', parseAsString);
  // The opened workflow's read-only graph + agent chat (D-016/D-018). Distinct from
  // `wfSelId`, which is the catalog/flow list selection — opening a workflow is a
  // different destination, not a different row highlight.
  const [wfId, setWfId] = useQueryState('wfId', parseAsString);
  const [query, setQuery] = useQueryState('wfQ', parseAsString.withDefault(''));
  const [, setAdvTab] = useQueryState('tab', parseAsString);
  const [, setCalendarPlan] = useQueryState('calPlan', parseAsString);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Mid-edit draft handed over from the landing's agent composer (D-018 region 2),
  // so the operator's sentence survives the hop into the creation flow instead of
  // making them retype it. Draft text is useState by the repo's nuqs/useState split.
  const [composerPrompt, setComposerPrompt] = useState('');

  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 15_000,
  });
  const catalog = catalogQuery.data?.[0] ?? null;

  const plansQuery = useSyncQuery<AutomationPlanRow>({
    queryName: 'plans.list',
    // No args is the canonical active-workspace superset: callPlansReadRaw
    // injects workspaceWide:true. Do not fan out the project registry here —
    // harness_slugs is capped at 64 and a large workspace would strand this
    // view in Loading after the resolver rejects the oversized list.
    args: {},
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
  const flows = useMemo(() => buildAutomationFlows(items), [items]);
  const visibleFlows = useMemo(() => flows.filter((item) => {
    if (flowFilter === 'attention' && !item.needsAttention) return false;
    if (flowFilter === 'paused' && !item.paused) return false;
    return filterAutomationItems([item], 'all', query).length === 1;
  }), [flowFilter, flows, query]);
  const visibleItems = useMemo(
    () => filterAutomationItems(items, filter, query),
    [filter, items, query],
  );
  const selected = items.find((item) => item.id === selectedId)
    ?? (view === 'flow' ? visibleFlows[0] : visibleItems[0])
    ?? items[0]
    ?? null;
  const selectedFlow = selected?.kind === 'triggered-plan' ? selected : visibleFlows[0] ?? null;
  const inspected = view === 'flow' ? selectedFlow : selected;
  const activity = useMemo(() => buildAutomationActivity(modelInput), [modelInput]);
  const sources = useMemo(() => buildAutomationSources(modelInput), [modelInput]);

  // ── Workflows landing (D-018) ────────────────────────────────────────────
  // A workflow IS a triggered plan (D-013), so the landing reads `flows`, not the
  // whole catalog — routines without a trigger are not workflows and stay in Catalog.
  const landingWorkflows = useMemo(() => flows.map(toLandingWorkflow), [flows]);
  // ExternalTriggerSourceAdminRow is a structural superset of LandingSourceInput,
  // so it satisfies the landing directly — no lossy adapter in between.
  const landingSources = external?.sources ?? [];

  // ── Opened workflow: read-only graph + agent chat (D-016/D-018) ──────────
  const openedWorkflow = wfId ? items.find((item) => item.id === wfId) ?? null : null;
  const openedBinding = useMemo(() => {
    if (!openedWorkflow?.planSlug || !external) return null;
    return external.bindings.find((binding) => binding.planSlug === openedWorkflow.planSlug) ?? null;
  }, [external, openedWorkflow?.planSlug]);

  const [inputs, setInputs] = useState<PlanInputSchemaInfo | null>(null);
  useEffect(() => {
    let live = true;
    setInputs(null);
    if (!inspected?.planSlug) return () => { live = false; };
    void fetchPlanInputs(inspected.planSlug, inspected.harness)
      .then((result) => {
        if (live && result.ok) setInputs(result);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [inspected?.harness, inspected?.planSlug]);

  const runHistoryQuery = useSyncQuery<RunHistoryRow>({
    queryName: 'plans.runHistory',
    args: inspected?.planSlug
      ? { planSlug: inspected.planSlug, ...(inspected.harness ? { harnessSlug: inspected.harness } : {}) }
      : { planSlug: '__none__' },
    enabled: Boolean(inspected?.planSlug),
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
      toast.error('Workflow control failed', {
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
      confirmLabel: 'Pause workflow',
      destructive: true,
    }))) return;
    setBusy(`routine:${item.id}`);
    try {
      if (routine.control === 'flag') {
        if (!routine.flagKey) throw new Error('Flag-controlled workflow has no flag key');
        const result = await runScheduleTool('flags:set', {
          key: routine.flagKey,
          enabled: next,
          reason: `Changed from the Workflows tab`,
        });
        if (!result.ok) throw new Error(result.message ?? 'Flag update failed');
      } else {
        for (const installSlug of routine.installs) {
          const result = await runScheduleTool('routines:set', {
            name: routine.name,
            installSlug,
            active: next,
            ...(next ? {} : { reason: 'Paused from the Workflows tab' }),
          });
          if (!result.ok) throw new Error(result.message ?? `Routine update failed for ${installSlug}`);
        }
      }
      toast.success(next ? 'Workflow resumed' : 'Workflow paused');
      refreshAll();
    } catch (error) {
      toast.error('Workflow control failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  const pauseAutomaticTriggers = useCallback(async (item: AutomationItem) => {
    if (!item.planSlug) return;
    const automatic = item.triggers.filter((trigger) => trigger.armed === true);
    if (automatic.length === 0) return;
    if (!(await confirm({
      title: `Pause automatic triggers for ${item.label}?`,
      body: 'Schedules and external event bindings will stop firing. Run manually remains available.',
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
  const nextAt = nextFutureAutomationAt(items);
  const planHarnesses = [...new Set((plansQuery.data ?? []).map((plan) => plan.harness).filter(Boolean))];
  const creationHarness = resolvedHarnessSlug ?? (planHarnesses.length === 1 ? planHarnesses[0] : null);

  /**
   * The count badge for one view tab. Overview and Flows both count workflows —
   * a workflow IS a triggered plan (D-013), and the landing is a different
   * presentation of that same set, not a different population.
   */
  const viewCount = (id: View): number => {
    switch (id) {
      case 'landing':
      case 'flow':
        return flows.length;
      case 'catalog':
        return items.length;
      case 'activity':
        return activity.length;
      case 'sources':
        return sources.length;
    }
  };

  // Opening a workflow is a DESTINATION, not a row highlight (D-018): the read-only
  // graph + agent chat replaces the tab body, with its own back affordance. A `wfId`
  // that resolves to nothing (stale URL) falls through to the landing rather than
  // rendering an empty shell.
  if (openedWorkflow) {
    const armBusyKey = openedBinding ? `binding:${openedBinding.id}` : null;
    return (
      <section className="pc-workflows" aria-label="Workflow detail">
        {confirmElement}
        <WorkflowDetailView
          workflowLabel={openedWorkflow.label}
          harnessSlug={openedWorkflow.harness ?? null}
          binding={openedBinding}
          // `external === null` means the snapshot has not been read yet — the
          // component renders "pending" rather than "unwired" off this.
          bindingLoaded={external !== null}
          lastFiredLabel={openedWorkflow.lastAt == null ? null : `last fired ${relativeTime(openedWorkflow.lastAt)}`}
          busy={armBusyKey !== null && busy === armBusyKey
            ? 'arm'
            : busy === `run:${openedWorkflow.id}` ? 'test' : null}
          onBack={() => void setWfId(null)}
          onToggleArm={() => openedBinding && void setBindingArmed(openedBinding.id, !openedBinding.armed)}
          onTest={() => openedWorkflow.planSlug && void invoke(
            `run:${openedWorkflow.id}`,
            'plans:run-now',
            { slug: openedWorkflow.planSlug, ...(openedWorkflow.harness ? { harness: openedWorkflow.harness } : {}) },
            `${openedWorkflow.label} started`,
          )}
        />
      </section>
    );
  }

  return (
    <section className="pc-workflows" aria-label="Workflows">
      {confirmElement}
      {createOpen ? (
        <CreateAutomationModal
          plans={plansQuery.data ?? []}
          sources={external?.sources ?? []}
          defaultHarness={creationHarness}
          initialOutcome={composerPrompt}
          onClose={() => { setCreateOpen(false); setComposerPrompt(''); }}
          onCreated={(plan) => {
            refreshAll();
            void setView('flow');
            void setSelectedId(`plan:${planRefKey(plan)}`);
          }}
        />
      ) : null}
      <header className="pc-workflows__tab-masthead">
        <div>
          <div className="pc-workflows__eyebrow">Workspace control plane</div>
          <h1>Workflows</h1>
          <p>Everything that can run in the background—what starts it, whether it is running, what it can spend, and how to stop it.</p>
        </div>
        <div className="pc-workflows__mast-actions">
          <button type="button" onClick={refreshAll} aria-label="Refresh workflows">
            <span className="pc-workflows__button-inner"><RefreshCw size={14} aria-hidden /> Refresh</span>
          </button>
          <button type="button" className="pc-workflows__primary" onClick={() => setCreateOpen(true)}>
            <span className="pc-workflows__button-inner"><Plus size={14} aria-hidden /> New workflow</span>
          </button>
        </div>
      </header>

      <div className="pc-workflows__viewbar">
        <nav aria-label="Workflow views">
          {VIEW_TABS.map(({ id, label }) => (
            <button key={id} type="button" data-active={view === id} onClick={() => void setView(id)}>
              <span className="pc-workflows__viewtab-inner">
                {label}
                <span className="pc-workflows__viewtab-count">{viewCount(id)}</span>
              </span>
            </button>
          ))}
        </nav>
        <span>Source → plan → Outcome / next</span>
      </div>

      {externalError ? (
        <div className="pc-workflows__notice" role="status">
          External sources are temporarily unavailable: {externalError}. Routine and schedule data remain live.
        </div>
      ) : null}

      {view === 'flow' || view === 'catalog' ? (
        <div className="pc-workflows__metrics" aria-label="Workflow summary">
          <Metric icon={AlertTriangle} label="Needs attention" value={String(attentionCount)} tone={attentionCount > 0 ? 'warn' : 'good'} />
          <Metric icon={Play} label="Running now" value={String(runningCount)} tone={runningCount > 0 ? 'blue' : 'neutral'} />
          <Metric icon={CalendarClock} label="Next run" value={nextAt == null ? '—' : relativeTime(nextAt)} tone="neutral" />
          <Metric icon={CircleDollarSign} label="Spend · 7 days" value={`$${(catalog?.spend7dTotalUsd ?? 0).toFixed(2)}`} tone="spend" />
        </div>
      ) : null}

      {view === 'landing' ? (
        <WorkflowsLanding
          workflows={landingWorkflows}
          sources={landingSources}
          // Deliberately NOT measured. The only fire feed here is
          // external.recentRuns — a bounded recent window, so counting today's
          // entries in it would render an undercount as a fact. null makes the
          // landing say "fires not counted", which is the truth.
          firesToday={null}
          // The catalog carries a 7-DAY spend total only; labelling it "today"
          // would be a wrong number, not a rounded one.
          spendTodayLabel={null}
          onOpenWorkflow={(workflowId) => void setWfId(workflowId)}
          onNeedsYouAction={(item: NeedsYouItem) => {
            void setView(item.kind === 'reconnect' ? 'sources' : 'activity');
          }}
          // Workflow packs (D-014, P-012/P-021) are not built yet and there is no
          // cupboard route in this app — creation is the real "get a new workflow"
          // path today, so the control goes there rather than nowhere.
          onInstallFromCupboard={() => setCreateOpen(true)}
          onComposeWorkflow={(prompt) => {
            setComposerPrompt(prompt);
            setCreateOpen(true);
          }}
        />
      ) : view === 'flow' ? (
        <>
          <div className="pc-workflows__flow-toolbar">
            <label>
              <Search size={14} aria-hidden />
              <input value={query} onChange={(event) => void setQuery(event.target.value)} placeholder="Search trigger flows" aria-label="Search trigger flows" />
            </label>
            <div role="group" aria-label="Filter trigger flows">
              {([
                ['all', `All flows · ${flows.length}`],
                ['attention', `Needs attention · ${flows.filter((item) => item.needsAttention).length}`],
                ['paused', `Paused · ${flows.filter((item) => item.paused).length}`],
              ] as const).map(([id, label]) => (
                <button key={id} type="button" data-active={flowFilter === id} onClick={() => void setFlowFilter(id)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="pc-workflows__workspace">
            <FlowCanvas
              items={visibleFlows}
              loading={loading}
              selectedId={selectedFlow?.id ?? null}
              onSelect={(item) => void setSelectedId(item.id)}
            />
            <AutomationDetail
              variant="flow"
              item={selectedFlow}
              inputs={inputs}
              runs={runHistory}
              busy={busy}
              onRun={() => selectedFlow?.planSlug && void invoke(
                `run:${selectedFlow.id}`,
                'plans:run-now',
                { slug: selectedFlow.planSlug, ...(selectedFlow.harness ? { harness: selectedFlow.harness } : {}) },
                `${selectedFlow.label} started`,
              )}
              onToggleSchedule={(armed) => selectedFlow?.planSlug && void invoke(
                `schedule:${selectedFlow.id}`,
                armed ? 'plans:arm-schedule' : 'plans:disarm-schedule',
                { slug: selectedFlow.planSlug, ...(selectedFlow.harness ? { harness: selectedFlow.harness } : {}) },
                armed ? 'Schedule armed' : 'Schedule paused',
              )}
              onToggleBinding={(id, armed) => void setBindingArmed(id, armed)}
              onToggleRoutine={() => selectedFlow && void toggleRoutine(selectedFlow)}
              onPauseAll={() => selectedFlow && void pauseAutomaticTriggers(selectedFlow)}
              onEditSchedule={() => {
                if (!selectedFlow?.planSlug) return;
                void setCalendarPlan(selectedFlow.planSlug);
                void setAdvTab('calendar');
              }}
              onViewActivity={() => void setView('activity')}
            />
          </div>
        </>
      ) : view === 'catalog' ? (
        <>
          <div className="pc-workflows__filters">
            <div role="group" aria-label="Filter workflows">
              {FILTERS.map((candidate) => (
                <button key={candidate.id} type="button" data-active={filter === candidate.id} onClick={() => void setFilter(candidate.id)}>
                  {candidate.label}
                </button>
              ))}
            </div>
            <label>
              <Search size={13} aria-hidden />
              <input value={query} onChange={(event) => void setQuery(event.target.value)} placeholder="Search workflows" aria-label="Search workflows" />
            </label>
          </div>

          <div className="pc-workflows__workspace">
            <div className="pc-workflows__catalog">
              <div className="pc-workflows__panelhead">
                <strong>Workflow catalog</strong>
                <span>{visibleItems.length} shown · attention first, then next run</span>
              </div>
              {loading && items.length === 0 ? <div className="pc-workflows__list-empty">Loading workflows…</div> : null}
              {!loading && visibleItems.length === 0 ? <div className="pc-workflows__list-empty">No workflows match this filter.</div> : null}
              <div className="pc-workflows__rows">
                {visibleItems.map((item) => (
                  <AutomationRow key={item.id} item={item} selected={selected?.id === item.id} onSelect={() => void setSelectedId(item.id)} />
                ))}
              </div>
            </div>
            <AutomationDetail
              variant="catalog"
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
              onViewActivity={() => void setView('activity')}
            />
          </div>
        </>
      ) : view === 'activity' ? (
        <ActivityView activity={activity} spend={catalog?.spend7d ?? []} onOpen={(item) => {
          if (item.automationId) void setSelectedId(item.automationId);
          const automation = items.find((candidate) => candidate.id === item.automationId);
          void setView(automation?.kind === 'triggered-plan' ? 'flow' : 'catalog');
        }} />
      ) : (
        <SourcesView sources={sources} />
      )}
    </section>
  );
}

async function mutateExternalTrigger(args: Record<string, unknown>): Promise<{
  ok: boolean;
  message?: string;
  bindingId?: string;
}> {
  try {
    const response = await fetch('/api/admin/triggers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await response.json().catch(() => ({})) as {
      ok?: boolean;
      error?: string;
      detail?: string;
      binding?: { id?: unknown };
    };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.detail ?? body.error ?? `HTTP ${response.status}` };
    }
    return {
      ok: true,
      ...(typeof body.binding?.id === 'string' ? { bindingId: body.binding.id } : {}),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function CreateAutomationModal({
  plans,
  sources,
  defaultHarness,
  initialOutcome = '',
  onClose,
  onCreated,
}: {
  plans: AutomationPlanRow[];
  sources: ExternalTriggerAdminSnapshot['sources'];
  defaultHarness: string | null;
  /** Seed for the outcome field, handed over from the landing's agent composer (D-018). */
  initialOutcome?: string;
  onClose: () => void;
  onCreated: (plan: CreatePlanRef) => void;
}) {
  const availablePlans = useMemo(
    () => plans
      .filter((plan) => plan.status !== 'shipped' && plan.status !== 'superseded')
      .sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug)),
    [plans],
  );
  const connectedSources = useMemo(
    () => sources.filter((source) => source.status === 'connected'),
    [sources],
  );
  const [triggerKind, setTriggerKind] = useState<CreateTriggerKind>('schedule');
  const [planMode, setPlanMode] = useState<CreatePlanMode>(availablePlans.length > 0 ? 'existing' : 'new');
  const [selectedPlanKey, setSelectedPlanKey] = useState(availablePlans[0] ? planRefKey(availablePlans[0]) : '');
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('every-15-minutes');
  const [tzid, setTzid] = useState(browserTimeZone);
  const [sourceId, setSourceId] = useState(connectedSources[0]?.id ?? '');
  const [eventPattern, setEventPattern] = useState(
    connectedSources[0] ? `ext:${connectedSources[0].kind}:` : '',
  );
  const [planName, setPlanName] = useState('');
  const [outcome, setOutcome] = useState(initialOutcome);
  const [createdPlan, setCreatedPlan] = useState<CreatePlanRef | null>(null);
  const [pendingArm, setPendingArm] = useState<PendingArm | null>(null);
  const [result, setResult] = useState<CreationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPlanKey && availablePlans[0]) setSelectedPlanKey(planRefKey(availablePlans[0]));
  }, [availablePlans, selectedPlanKey]);
  useEffect(() => {
    if (!sourceId && connectedSources[0]) {
      setSourceId(connectedSources[0].id);
      setEventPattern(`ext:${connectedSources[0].kind}:`);
    }
  }, [connectedSources, sourceId]);

  const selectedPlan = availablePlans.find((plan) => planRefKey(plan) === selectedPlanKey) ?? null;
  const selectedSource = connectedSources.find((source) => source.id === sourceId) ?? null;
  const timeZones = [...new Set([browserTimeZone(), 'America/New_York', 'UTC'])];
  const newPlanReady = Boolean(createdPlan || (defaultHarness && planName.trim() && outcome.trim()));
  const planReady = planMode === 'existing' ? Boolean(selectedPlan) : newPlanReady;
  const triggerReady = triggerKind === 'schedule' || Boolean(selectedSource && eventPattern.trim());
  const canSubmit = planReady && triggerReady && !pendingArm;

  const finishArmed = (target: PendingArm) => {
    setPendingArm(null);
    setError(null);
    setResult({ ...target, armed: true });
    onCreated(target.plan);
  };

  const armTarget = async (target: PendingArm): Promise<boolean> => {
    setPendingArm(target);
    setStep(target.kind === 'schedule' ? 'Arming schedule…' : 'Arming external event…');
    const armed = target.kind === 'schedule'
      ? await runScheduleTool('plans:arm-schedule', {
          slug: target.plan.slug,
          harness: target.plan.harness,
        })
      : target.bindingId
        ? await mutateExternalTrigger({
            op: 'set-armed',
            id: target.bindingId,
            armed: true,
            confirm: true,
          })
        : { ok: false, message: 'The created external binding did not return an id.' };
    if (!armed.ok) {
      setError(target.kind === 'schedule'
        ? `Schedule saved for ${target.plan.title}, but it is not armed. ${armed.message ?? 'Arming failed.'}`
        : `External binding attached to ${target.plan.title}, but it is not armed. ${armed.message ?? 'Arming failed.'}`);
      return false;
    }
    finishArmed(target);
    return true;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    let plan: CreatePlanRef | null = planMode === 'existing' && selectedPlan
      ? { slug: selectedPlan.slug, harness: selectedPlan.harness, title: selectedPlan.title ?? selectedPlan.slug }
      : createdPlan;
    let createdThisAttempt = false;
    try {
      if (!plan && planMode === 'new') {
        if (!defaultHarness) throw new Error('Select an owning pot before creating a plan in place.');
        const title = planName.trim();
        const delivery = outcome.trim();
        if (!title || !delivery) throw new Error('Name the workflow and describe the plan outcome.');
        const slug = uniqueDatedPlanSlug(title, plans);
        setStep('Creating plan…');
        const created = await runScheduleTool('plans:new', {
          slug,
          title,
          harness: defaultHarness,
          status: 'ready',
          rationale: 'Created in place from the Workflows production surface.',
          content: inlinePlanContent(delivery, triggerKind === 'schedule' ? 'Schedule' : 'External event'),
        });
        if (!created.ok) throw new Error(created.message ?? 'Plan creation failed.');
        plan = { slug, harness: defaultHarness, title };
        createdThisAttempt = true;
        setCreatedPlan(plan);
      }
      if (!plan) throw new Error('Choose a plan to run.');

      if (triggerKind === 'schedule') {
        const preset = SCHEDULE_PRESETS[schedulePreset];
        setStep('Saving schedule…');
        const scheduled = await runScheduleTool('plans:set-schedule', {
          slug: plan.slug,
          harness: plan.harness,
          schedule: { kind: 'cron', cron: preset.cron, tzid },
          scheduledAt: null,
          expiresAt: null,
          tzid,
        });
        if (!scheduled.ok) {
          throw new Error(`${createdThisAttempt ? `Plan ${plan.title} was created, but ` : ''}the schedule was not saved. ${scheduled.message ?? 'Schedule authoring failed.'}`);
        }
        await armTarget({ kind: 'schedule', plan, sourceLabel: `${preset.label} · ${tzid}` });
      } else {
        if (!selectedSource) throw new Error('Choose a connected external source.');
        setStep('Attaching external event…');
        const attached = await mutateExternalTrigger({
          op: 'attach-external',
          sourceId: selectedSource.id,
          planHarnessSlug: plan.harness,
          planSlug: plan.slug,
          eventPattern: eventPattern.trim(),
          eventFilter: {},
          maxRuns: null,
          windowSeconds: 60,
        });
        if (!attached.ok || !attached.bindingId) {
          throw new Error(`${createdThisAttempt ? `Plan ${plan.title} was created, but ` : ''}the external binding was not attached. ${attached.message ?? 'The binding id was missing.'}`);
        }
        await armTarget({
          kind: 'external',
          plan,
          bindingId: attached.bindingId,
          sourceLabel: `${selectedSource.kind} · ${eventPattern.trim()}`,
        });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  };

  const retryArm = async () => {
    if (!pendingArm || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await armTarget(pendingArm);
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next && !submitting) onClose(); }}
      title="Create a workflow"
      description="Choose a real automatic trigger and the plan it will run."
      srOnlyTitle
      closeOnEscape={!submitting}
      closeOnOutsideClick={!submitting}
      contentClassName="pc-workflows-create"
      contentStyle={{ width: 'min(760px, calc(100vw - 32px))' }}
    >
      <form onSubmit={submit}>
        <header className="pc-workflows-create__head">
          <div>
            <div className="pc-workflows-create__eyebrow">New workflow</div>
            <h2>Create a workflow</h2>
            <p>Choose a real automatic trigger and the plan it will run. Nothing leaves this popup.</p>
          </div>
          <button type="button" aria-label="Close create workflow dialog" disabled={submitting} onClick={onClose}>
            <span className="pc-workflows-create__close-inner"><X size={18} aria-hidden /></span>
          </button>
        </header>

        {result ? (
          <div className="pc-workflows-create__success" role="status">
            <div className="pc-workflows-create__success-icon" aria-hidden>✓</div>
            <div>
              <h3>Workflow armed</h3>
              <p><strong>{result.plan.title}</strong> is attached to {result.sourceLabel}.</p>
              <dl>
                <div><dt>Plan</dt><dd>{result.plan.harness} · {result.plan.slug}</dd></div>
                <div><dt>State</dt><dd>Armed</dd></div>
              </dl>
              <button type="button" className="pc-workflows-create__primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="pc-workflows-create__body">
              <section aria-labelledby="create-automation-trigger-label">
                <div className="pc-workflows-create__step">1 · What starts it?</div>
                <div className="pc-workflows-create__section-title" id="create-automation-trigger-label">
                  <strong>Automatic trigger</strong><span>Manual launch is an action, not a trigger.</span>
                </div>
                <div className="pc-workflows-create__choice-grid" role="group" aria-label="Automatic trigger">
                  <button type="button" aria-pressed={triggerKind === 'schedule'} onClick={() => { setTriggerKind('schedule'); setError(null); }}>
                    <span className="pc-workflows-create__choice-inner"><CalendarClock size={18} aria-hidden /><strong>Schedule</strong><span>Recurring cadence at a real time zone.</span><em>Uses the existing plan schedule system</em></span>
                  </button>
                  <button type="button" aria-pressed={triggerKind === 'external'} onClick={() => { setTriggerKind('external'); setError(null); }}>
                    <span className="pc-workflows-create__choice-inner"><DatabaseZap size={18} aria-hidden /><strong>External event</strong><span>Use a connected source and audited event pattern.</span><em>Creates an external binding</em></span>
                  </button>
                </div>

                {triggerKind === 'schedule' ? (
                  <div className="pc-workflows-create__form-grid">
                    <label className="pc-workflows-create__field">
                      <span>Frequency</span>
                      <Select
                        value={schedulePreset}
                        onChange={(value) => setSchedulePreset(value as SchedulePreset)}
                        ariaLabel="Frequency"
                        triggerClassName="pc-workflows-create__select"
                        options={Object.entries(SCHEDULE_PRESETS).map(([value, preset]) => ({ value, label: preset.label }))}
                      />
                    </label>
                    <label className="pc-workflows-create__field">
                      <span>Time zone</span>
                      <Select
                        value={tzid}
                        onChange={setTzid}
                        ariaLabel="Time zone"
                        triggerClassName="pc-workflows-create__select"
                        options={timeZones.map((value) => ({ value, label: value }))}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="pc-workflows-create__form-grid">
                    <label className="pc-workflows-create__field">
                      <span>Connected source</span>
                      <Select
                        value={sourceId}
                        onChange={(value) => {
                          setSourceId(value);
                          const next = connectedSources.find((source) => source.id === value);
                          if (next) setEventPattern(`ext:${next.kind}:`);
                        }}
                        ariaLabel="Connected source"
                        disabled={connectedSources.length === 0}
                        placeholder="No connected sources"
                        triggerClassName="pc-workflows-create__select"
                        options={connectedSources.map((source) => ({ value: source.id, label: `${source.kind} · ${source.status}` }))}
                      />
                    </label>
                    <label className="pc-workflows-create__field">
                      <span>Event pattern</span>
                      <input aria-label="Event pattern" value={eventPattern} onChange={(event) => setEventPattern(event.target.value)} required />
                    </label>
                    {connectedSources.length === 0 ? <p className="pc-workflows-create__empty-source">No connected external source is available. Connect one in Sources, or use a schedule.</p> : null}
                  </div>
                )}
              </section>

              <section aria-labelledby="create-automation-plan-label">
                <div className="pc-workflows-create__step">2 · What runs?</div>
                <div className="pc-workflows-create__plan-mode" role="group" aria-label="Plan choice" id="create-automation-plan-label">
                  <button type="button" aria-pressed={planMode === 'existing'} disabled={availablePlans.length === 0} onClick={() => { setPlanMode('existing'); setError(null); }}>Use an existing plan</button>
                  <button type="button" aria-pressed={planMode === 'new'} onClick={() => { setPlanMode('new'); setError(null); }}>Create the plan here</button>
                </div>
                {planMode === 'existing' ? (
                  <label className="pc-workflows-create__field is-full">
                    <span>Plan to run</span>
                    <Select
                      value={selectedPlanKey}
                      onChange={setSelectedPlanKey}
                      ariaLabel="Plan to run"
                      disabled={availablePlans.length === 0}
                      placeholder="No plans available"
                      triggerClassName="pc-workflows-create__select"
                      options={availablePlans.map((plan) => ({
                        value: planRefKey(plan),
                        label: `${plan.title ?? plan.slug} · ${plan.harness}`,
                      }))}
                    />
                  </label>
                ) : createdPlan ? (
                  <div className="pc-workflows-create__created-plan" role="status">
                    <strong>Plan created</strong>
                    <span>{createdPlan.title} · {createdPlan.harness}</span>
                    <small>Retrying will reuse this plan rather than create a duplicate.</small>
                  </div>
                ) : (
                  <div className="pc-workflows-create__new-plan-grid">
                    <label className="pc-workflows-create__field is-full">
                      <span>Workflow name</span>
                      <input aria-label="Workflow name" value={planName} maxLength={160} onChange={(event) => setPlanName(event.target.value)} placeholder="e.g. Summarize support escalations" required />
                    </label>
                    <label className="pc-workflows-create__field is-full">
                      <span>What should the plan produce?</span>
                      <input aria-label="What should the plan produce?" value={outcome} maxLength={500} onChange={(event) => setOutcome(event.target.value)} placeholder="Describe the concrete outcome" required />
                    </label>
                    <p className="pc-workflows-create__scope-note">
                      {defaultHarness ? <>The plan will be created in <strong>{defaultHarness}</strong>.</> : <>Select a pot in the workspace before creating a plan here.</>}
                    </p>
                  </div>
                )}
              </section>

              <div className="pc-workflows-create__truth-note">
                <strong>Creation behavior:</strong> the trigger is authored, attached to the selected plan, and then armed. A partial failure is reported as saved or attached but not armed—never as success.
              </div>
              {error ? (
                <div className="pc-workflows-create__error" role="alert">
                  <div><strong>Couldn’t finish creating the workflow</strong><p>{error}</p></div>
                  {pendingArm ? <button type="button" disabled={submitting} onClick={() => void retryArm()}>Retry arming</button> : null}
                </div>
              ) : null}
            </div>

            <footer className="pc-workflows-create__foot">
              <span aria-live="polite">{step ?? 'The final action explicitly creates and arms the workflow.'}</span>
              <div>
                <button type="button" disabled={submitting} onClick={onClose}>Cancel</button>
                <button type="submit" className="pc-workflows-create__primary" disabled={submitting || !canSubmit}>
                  {submitting ? step ?? 'Working…' : 'Create & arm workflow'}
                </button>
              </div>
            </footer>
          </>
        )}
      </form>
    </Modal>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof Activity; label: string; value: string; tone: string }) {
  return (
    <div className="pc-workflows__metric" data-tone={tone}>
      <span><Icon size={14} aria-hidden /> {label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AutomationRow({ item, selected, onSelect }: { item: AutomationItem; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="pc-workflows__row" data-selected={selected} data-state={itemState(item).toLowerCase().replaceAll(' ', '-')} onClick={onSelect}>
      <span className="pc-workflows__row-layout">
        <span className="pc-workflows__row-main">
          <span className="pc-workflows__row-title">
            <i aria-hidden /> <strong>{item.label}</strong><em>{kindLabel(item.kind)}</em>
          </span>
          <span className="pc-workflows__row-copy">{item.description}</span>
          {item.triggers.length > 0 ? (
            <span className="pc-workflows__row-chips">
              {item.triggers.slice(0, 5).map((trigger) => <span key={trigger.id}>{trigger.provider}</span>)}
            </span>
          ) : null}
        </span>
        <span className="pc-workflows__row-state">
          <strong>{item.timingLabel}</strong>
          <small>{item.running ? 'Live execution observed' : item.lastAt ? `Last ${relativeTime(item.lastAt)}` : itemState(item)}</small>
        </span>
        <span className="pc-workflows__row-spend">
          <strong>{item.spendLabel}</strong>
          <small>{item.kind === 'triggered-plan' ? 'Verified costs shown per run' : 'No guessed routine attribution'}</small>
        </span>
        <ChevronRight size={15} aria-hidden />
      </span>
    </button>
  );
}

function FlowCanvas({
  items,
  loading,
  selectedId,
  onSelect,
}: {
  items: AutomationItem[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (item: AutomationItem) => void;
}) {
  return (
    <section className="pc-workflows__flow-canvas" aria-label="Trigger flows">
      <div className="pc-workflows__panelhead">
        <strong>Trigger flows</strong>
        <span>Click a flow to inspect its sources, controls, and linked activity</span>
      </div>
      <div className="pc-workflows__flow-columns" aria-hidden>
        <span>Trigger source</span><span>Plan</span><span>Outcome / next</span>
      </div>
      <div className="pc-workflows__flows">
        {items.map((item) => {
          const flow = item.flow;
          if (!flow) return null;
          return (
            <button
              type="button"
              className="pc-workflows__flow-row"
              data-selected={selectedId === item.id}
              key={item.id}
              onClick={() => onSelect(item)}
              aria-label={`${flow.sourceLabel} starts ${item.label}; outcome or next: ${flow.outcomeLabel}`}
            >
              <span className="pc-workflows__flow-row-layout">
                <span className="pc-workflows__flow-line" aria-hidden />
                <span className="pc-workflows__flow-node is-source" data-state={flow.sourceState}>
                  <span className="pc-workflows__flow-node-title"><i aria-hidden /><strong>{flow.sourceLabel}</strong></span>
                  <span className="pc-workflows__flow-node-copy">{flow.sourceDetail}</span>
                  <span className="pc-workflows__flow-node-meta">{item.triggers.length} installed trigger{item.triggers.length === 1 ? '' : 's'}</span>
                </span>
                <span className="pc-workflows__flow-node is-plan" data-state={itemState(item).toLowerCase().replaceAll(' ', '-')}>
                  <span className="pc-workflows__flow-node-title"><i aria-hidden /><strong>{item.label}</strong></span>
                  <span className="pc-workflows__flow-node-copy">{item.description}</span>
                  <span className="pc-workflows__flow-node-meta">{flow.planDetail}</span>
                </span>
                <span className="pc-workflows__flow-node is-outcome" data-state={flow.outcomeState}>
                  <span className="pc-workflows__flow-node-title"><i aria-hidden /><strong>{flow.outcomeLabel}</strong></span>
                  <span className="pc-workflows__flow-node-copy">{flow.outcomeDetail}</span>
                  <span className="pc-workflows__flow-node-meta">{item.timingLabel}</span>
                </span>
              </span>
            </button>
          );
        })}
        {loading && items.length === 0 ? <div className="pc-workflows__list-empty">Loading trigger flows…</div> : null}
        {!loading && items.length === 0 ? (
          <div className="pc-workflows__list-empty">
            No triggered plans match this view. Non-triggered AI routines and system tasks remain available in Catalog.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AutomationDetail({
  variant,
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
  onViewActivity,
}: {
  variant: 'flow' | 'catalog';
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
  onViewActivity: () => void;
}) {
  if (!item) return <aside className="pc-workflows__detail"><div className="pc-workflows__list-empty">Select a workflow.</div></aside>;
  const automatic = item.triggers;
  const runRows = runs?.runs.slice(0, 5) ?? [];
  return (
    <aside className="pc-workflows__detail" aria-label="Workflow details">
      <div className="pc-workflows__panelhead"><strong>{variant === 'flow' ? 'Flow inspector' : 'Workflow details'}</strong><span>one identity across every view</span></div>
      <div className="pc-workflows__detailbody">
        <div className="pc-workflows__detail-kicker">{kindLabel(item.kind)} · {itemState(item)}</div>
        <h2>{item.label}</h2>
        <p>{item.description}</p>
        <div className="pc-workflows__statechips">
          <span data-tone={item.paused ? 'warn' : 'good'}>{item.paused ? 'Paused' : 'Enabled'}</span>
          <span data-tone={item.running ? 'blue' : 'neutral'}>{item.running ? 'Running' : 'Not running'}</span>
          {item.needsAttention ? <span data-tone="warn">Needs attention</span> : null}
        </div>

        <div className="pc-workflows__detailgrid">
          <DetailCard label="Next scheduled" value={item.nextAt ? relativeTime(item.nextAt) : 'None'} />
          <DetailCard label="Last activity" value={item.lastAt ? relativeTime(item.lastAt) : 'No run recorded'} />
          <DetailCard label="Plan inputs" value={inputs ? `${inputs.required.length} required · ${inputs.ready ? 'ready' : `${inputs.missing.length} missing`}` : item.planSlug ? 'Checking…' : 'Not a plan'} />
          <DetailCard label="Run-linked cost" value={runs?.rollup ? `$${runs.rollup.totalCostUsd.toFixed(2)} · ${runs.rollup.total} runs` : 'No verified run cost'} />
        </div>

        {variant === 'flow' && item.flow ? (
          <section className="pc-workflows__causal-path">
            <header><strong>Causal path</strong><span>observed state and declared next action</span></header>
            <div><span>Source</span><p><strong>{item.flow.sourceLabel}</strong><small>{item.flow.sourceDetail}</small></p><em data-state={item.flow.sourceState}>{item.flow.sourceState.replaceAll('-', ' ')}</em></div>
            <div><span>Plan</span><p><strong>{item.label}</strong><small>{item.flow.planDetail}</small></p><em>{itemState(item)}</em></div>
            <div><span>Outcome / next</span><p><strong>{item.flow.outcomeLabel}</strong><small>{item.flow.outcomeDetail}</small></p><em data-state={item.flow.outcomeState}>{item.flow.outcomeState}</em></div>
          </section>
        ) : null}

        <section className="pc-workflows__trigger-section">
          <header><strong>Automatic triggers</strong><span>installed and armed are separate</span></header>
          {item.triggers.map((trigger) => (
            <div className="pc-workflows__trigger" key={trigger.id}>
              <span>{trigger.provider}</span>
              <div><strong>{trigger.label}</strong><small>{trigger.detail}</small></div>
              <button
                type="button"
                disabled={busy != null || trigger.armed == null || (trigger.kind === 'external' && !trigger.bindingId)}
                onClick={() => {
                  if (trigger.kind === 'schedule') onToggleSchedule(trigger.armed !== true);
                  else if (trigger.bindingId) onToggleBinding(trigger.bindingId, trigger.armed !== true);
                }}
              >
                <span className="pc-workflows__button-inner">{trigger.armed == null ? 'Unknown' : trigger.armed ? 'Armed' : 'Paused'}</span>
              </button>
            </div>
          ))}
          {item.triggers.length === 0 ? <div className="pc-workflows__list-empty">Automatic trigger details are unavailable.</div> : null}
        </section>

        <section className="pc-workflows__cost">
          <header><span>Spend & permission</span><strong>{item.spendLabel}</strong></header>
          <p>{item.kind === 'triggered-plan'
            ? 'Costs come from runs linked to this plan. A schedule never proves a run happened.'
            : 'Routine-level dollars are not inferred from role totals; only the ability to spend is shown.'}</p>
        </section>

        <div className="pc-workflows__actions">
          {item.planSlug ? <button type="button" className="is-primary" disabled={busy != null || inputs?.ready === false} onClick={onRun}><span className="pc-workflows__button-inner"><Play size={13} aria-hidden /> Run manually</span></button> : null}
          {item.planSlug ? <button type="button" disabled={busy != null} onClick={onEditSchedule}><span className="pc-workflows__button-inner"><CalendarClock size={13} aria-hidden /> Edit schedule</span></button> : null}
          <button type="button" disabled={busy != null} onClick={onViewActivity}><span className="pc-workflows__button-inner"><Activity size={13} aria-hidden /> View activity</span></button>
          {item.routine?.controllable ? <button type="button" disabled={busy != null} onClick={onToggleRoutine}><span className="pc-workflows__button-inner"><Power size={13} aria-hidden /> {item.routine.active ? 'Pause' : 'Resume'}</span></button> : null}
          {automatic.some((trigger) => trigger.armed === true) ? <button type="button" className="is-warn" disabled={busy != null} onClick={onPauseAll}><span className="pc-workflows__button-inner"><Power size={13} aria-hidden /> Pause automatic triggers</span></button> : null}
        </div>

        <section className="pc-workflows__history">
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
    <div className="pc-workflows__activity-layout">
      <div className="pc-workflows__widepanel">
        <div className="pc-workflows__panelhead"><strong>Workflow activity</strong><span>external runs and routine fires · newest first</span></div>
        <div className="pc-workflows__activity">
          {activity.map((item) => (
            <button type="button" key={item.id} onClick={() => onOpen(item)}>
              <span className="pc-workflows__activity-row-layout"><i data-status={item.status} /><span><strong>{item.label}</strong><small>{item.detail}</small></span><em>{item.status}</em><time>{relativeTime(item.at)}</time></span>
            </button>
          ))}
          {activity.length === 0 ? <div className="pc-workflows__list-empty">No workflow activity has been recorded yet.</div> : null}
        </div>
      </div>
      <div className="pc-workflows__widepanel">
        <div className="pc-workflows__panelhead"><strong>Workspace spend · 7 days</strong><span>by agent role · not guessed per routine</span></div>
        <div className="pc-workflows__spend-rows">
          {spend.map((row) => (
            <div key={`${row.role}:${row.modelClass ?? ''}`}>
              <span><strong>{row.role}</strong><small>{row.modelClass ?? 'model class unavailable'} · {row.turns} turns</small></span>
              <span><strong>${row.costUsd.toFixed(2)}</strong><small>{row.outputTokens.toLocaleString()} output tokens</small></span>
            </div>
          ))}
          {spend.length === 0 ? <div className="pc-workflows__list-empty">No model spend recorded in this window.</div> : null}
        </div>
      </div>
    </div>
  );
}

function SourcesView({ sources }: { sources: ReturnType<typeof buildAutomationSources> }) {
  return (
    <div className="pc-workflows__widepanel">
      <div className="pc-workflows__panelhead"><strong>Trigger sources</strong><span>connection health and installed bindings</span></div>
      <div className="pc-workflows__sources">
        {sources.map((source) => (
          <article key={source.id}>
            <div className="pc-workflows__source-icon">{source.kind === 'schedule' ? <CalendarClock size={18} /> : <DatabaseZap size={18} />}</div>
            <div><strong>{source.label}</strong><span>{source.detail}</span></div>
            <dl><div><dt>State</dt><dd>{source.status}</dd></div><div><dt>Bindings</dt><dd>{source.armedCount}/{source.bindingCount} armed</dd></div></dl>
          </article>
        ))}
      </div>
    </div>
  );
}
