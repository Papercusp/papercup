import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, Play, AlertTriangle } from 'lucide-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import AgentThinkingPopover from '@/app/harness/AgentThinkingPopover';
import { fetchPlanList, type PlanListRow } from '@/app/admin/plans/plans-api';
import { useLexicon } from '@/lib/useLexicon';
import { Tooltip } from '@/app/harness/Tooltip';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface AgentRun {
  runId: string;
  role: string;
  featureId: string | null;
  ts: number;
}

interface AgentsResponse {
  runs: Array<{
    runId: string;
    role: string;
    ts: number;
    running?: boolean;
  }>;
}

interface Props {
  slug: string | null;
}

/** One row of the `hive.controlState` sync query (per registered hive). */
interface HiveControlRow {
  slug: string;
  started: boolean;
}

const PHASE = 'staging';

/**
 * Fire a hive control tool (start-hive-wake-orchestration P-005/P-006)
 * through the loopback palette bridge — the full gated/audited dispatch.
 * Lifted from the retired global-header HiveStartPauseButton.
 */
async function runHiveControl(
  tool: 'hive:start' | 'hive:pause',
  slug: string,
  extraArgs: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tool, args: { harness: slug, ...extraArgs }, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? `${tool} refused`);
}

/**
 * Count plans that are started but not yet worked to completion. A started
 * plan needs a *running* harness to pick it up, so when the harness is
 * stopped these plans are "waiting" — nothing is eligible to advance them.
 * Pure + exported for unit tests.
 */
export function countWaitingPlans(
  plans: readonly Pick<PlanListRow, 'startStatus'>[],
): number {
  return plans.filter((p) => p.startStatus === 'started').length;
}

/** Human label for the nudge — pluralized. Exported for unit tests. */
export function waitingLabel(n: number): string {
  return `${n} plan${n === 1 ? '' : 's'} waiting`;
}

/**
 * Full-width harness status bar rendered above the tab strip in AdvShell.
 * Shows hive started/paused state, the Start/Pause hive control, and one
 * pill per in-flight agent run. Ported from ActiveAgentsBar in HarnessDashboard.
 *
 * The Start/Stop button here IS the hive control (it replaced the global
 * header's HiveStartPauseButton, start-hive-wake-orchestration P-006):
 * Start boots the brain (`hive:start` — persisted started bit, Queen wake
 * subscriptions, wake-mode auto, immediate Queen wake); Stop pauses it
 * (`hive:pause { drainBees:true }` — wake-mode manual, time wake cleared,
 * live bees asked to wrap up). The legacy whole-loop subprocess launch
 * (`POST /harness/:slug/launch` → the archived orchestrator run-loop) is
 * GONE — feature work is driven by the durable DBOS pipeline + the Queen,
 * so "running" = the persisted `hive_started` bit + live agent runs, not a
 * driver-process scan. Hidden when no hive is registered.
 *
 * Polls /api/harness/:slug/agents every 4 s for the run pills.
 */
export default function AdvNowRunning({ slug }: Props) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [starting, setStarting] = useState(false);
  // Optimistic post-launch state: a run takes a poll cycle (a couple of
  // seconds) before the agents endpoint reports the first running agent.
  // While true we show "waiting for agent…" and poll faster.
  const [awaitingAgent, setAwaitingAgent] = useState(false);
  // Count of started-but-unpicked plans, shown only while the harness is
  // stopped (see the effect below). Drives the "N plans waiting" nudge.
  const [waitingCount, setWaitingCount] = useState(0);

  // Navigation targets for the nudge — jump to the Plans tab filtered to the
  // Running bucket (= started plans). We only WRITE these; PlansClient and
  // AdvShell own the canonical enum parsers (serialized output is identical).
  const [, setAdvTab] = useQueryState('tab', parseAsString);
  const [, setPlansView] = useQueryState('view', parseAsString);
  const [, setPlanBuckets] = useQueryState('pBuckets', parseAsArrayOf(parseAsString));

  // The registered hive (N=1 build — local-hive scope). The hive control
  // tools key on the HIVE's home slug, not the selected harness, so we read
  // it from the same sync query the old header button used. Invalidated live
  // by hive:start / hive:pause — `started` is the bar's active/paused state.
  const { data: hiveData } = useSyncQuery({ queryName: 'hive.controlState', args: {} });
  const hive = (hiveData as HiveControlRow[] | undefined)?.[0];
  const started = hive?.started === true;

  const [hovered, setHovered] = useState<{ run: AgentRun; rect: DOMRect } | null>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHovered(null), 150);
  };

  useEffect(() => {
    if (!slug) { setRuns([]); return; }
    let cancelled = false;
    const refresh = () => {
      fetch(`/api/harness/${encodeURIComponent(slug)}/agents?phase=${PHASE}`)
        .then((r) => (r.ok ? (r.json() as Promise<AgentsResponse>) : null))
        .then((agents) => {
          if (cancelled) return;
          const live = (agents?.runs ?? []).filter((r) => r.running);
          const liveRuns = live.map(parseRun).sort((a, b) => a.ts - b.ts);
          setRuns(liveRuns);
          // First real run arrived — drop the optimistic "waiting" state.
          if (liveRuns.length > 0) setAwaitingAgent(false);
        });
    };
    refresh();
    // Poll faster while optimistically waiting for the first agent post-launch.
    const id = window.setInterval(refresh, awaitingAgent ? 1200 : 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [slug, awaitingAgent]);

  useEffect(() => {
    if (runs.length === 0) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [runs.length]);

  // Safety net: if no agent appears within 20s of launch (e.g. a harness with
  // no started plan has nothing eligible to pick), stop "waiting" and fall
  // back to "Active — idle".
  useEffect(() => {
    if (!awaitingAgent) return;
    const id = window.setTimeout(() => setAwaitingAgent(false), 20_000);
    return () => window.clearTimeout(id);
  }, [awaitingAgent]);

  // While the hive is paused, count started-but-unpicked plans so the
  // bar can nudge "N plans waiting". A started hive is already working
  // them, so we skip the fetch entirely in that state (no extra request).
  useEffect(() => {
    const stopped = !(started || awaitingAgent || runs.length > 0);
    if (!slug || !stopped) { setWaitingCount(0); return; }
    let cancelled = false;
    const load = () => {
      fetchPlanList({ harness_slugs: [slug] })
        .then((res) => { if (!cancelled) setWaitingCount(countWaitingPlans(res.plans)); })
        .catch(() => { /* best-effort nudge — ignore failures */ });
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [slug, started, awaitingAgent, runs.length]);

  // START = boot the brain: hive:start persists the started bit, re-affirms
  // the Queen's event-wake subscriptions, flips wake-mode to auto, and wakes
  // her now. (The old first half — POST /harness/:slug/launch, the legacy
  // whole-loop subprocess — is retired; its orchestrator bin was archived
  // 2026-06-06, so that call could only ever 500 "orchestrator bin missing".)
  const startHive = useCallback(async () => {
    if (!hive || starting) return;
    setStarting(true);
    try {
      await runHiveControl('hive:start', hive.slug);
      toast.success('Hive started', { description: 'Queen woken — autonomous wakes enabled' });
      // Optimistic "waiting for agent…" until the Queen's run shows up; the
      // faster poll (driven by the awaitingAgent dep) takes over from here.
      // The started bit itself arrives via the hive.controlState invalidation.
      setAwaitingAgent(true);
    } catch (e) {
      toast.error('Start failed', { description: String(e) });
    }
    setStarting(false);
  }, [hive, starting]);

  // STOP = pause the brain: wake-mode manual stages every autonomous wake,
  // the Queen's time wake is cleared, and live bees get the graceful drain
  // cue. Running turns finish — there is no process SIGTERM anymore (the
  // legacy /stop route only ever matched the retired run.sh driver).
  const stopHive = useCallback(async () => {
    if (!hive) return;
    const ok = await askConfirm({
      title: `Pause hive (${hive.slug})?`,
      body: 'Live bees are asked to wrap up; no new wakes fire until Start.',
      confirmLabel: 'Pause hive',
      destructive: true,
    });
    if (!ok) return;
    try {
      await runHiveControl('hive:pause', hive.slug, { drainBees: true });
      toast.success('Hive paused', { description: 'Autonomous wakes staged; bees draining' });
      setAwaitingAgent(false);
    } catch (e) {
      toast.error('Pause failed', { description: String(e) });
    }
  }, [askConfirm, hive]);

  const showWaitingPlans = useCallback(() => {
    void setAdvTab('plans');
    void setPlansView('plans');
    void setPlanBuckets(['running']);
  }, [setAdvTab, setPlansView, setPlanBuckets]);

  if (!slug) return null;

  const fmt = (sec: number) => {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
  };

  // Active = the persisted hive started bit (live via hive.controlState
  // invalidation), a just-clicked Start (awaitingAgent), or visible runs.
  const effectivelyAlive = started || awaitingAgent || runs.length > 0;
  const isLoading = hiveData === undefined && !awaitingAgent && runs.length === 0;
  const stateClass = isLoading ? 'is-checking' : effectivelyAlive ? 'is-active' : 'is-stopped';

  return (
    <>
    {confirmEl}
    <div className={`pc-advshell__harness-bar pc-advshell__harness-bar--${stateClass}`} aria-label={`${t('pot')} status`}>
      {/* Active status indicator — only shown when running */}
      {effectivelyAlive && (
        <div className="pc-advshell__harness-status">
          <span className="pc-advshell__harness-dot" aria-hidden />
          <span className="pc-advshell__harness-label">
            {runs.length > 0
              ? `Active — ${runs.length} agent${runs.length === 1 ? '' : 's'} running`
              : awaitingAgent
                ? 'Active — waiting for agent…'
                : 'Active — idle'}
          </span>
        </div>
      )}

      {/* Agent pills */}
      {runs.length > 0 && (
        <div className="pc-advshell__pills" data-count={runs.length}>
          {runs.map((r) => {
            const dur = now - r.ts;
            const label = `${r.role}${r.featureId ? ` · ${r.featureId}` : ''} · ${fmt(dur)}`;
            return (
              <Tooltip key={r.runId} label="Hover for live thinking">
                <button
                  type="button"
                  className="pc-advshell__pill"
                  onMouseEnter={(e) => {
                    cancelClose();
                    if (enterTimer.current) clearTimeout(enterTimer.current);
                    const rect = e.currentTarget.getBoundingClientRect();
                    enterTimer.current = setTimeout(() => setHovered({ run: r, rect }), 250);
                  }}
                  onMouseLeave={() => {
                    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
                    scheduleClose();
                  }}
                >
                  <span className="pc-advshell__pill-dot" aria-hidden />
                  <span>{label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* Nudge: started plans exist but the harness isn't running to pick
          them up. Click → Plans tab, Running filter. */}
      {!effectivelyAlive && waitingCount > 0 && (
        <Tooltip label={`These plans are started but the ${t('pot', { lower: true })} isn't running — click to view them`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--waiting"
            onClick={showWaitingPlans}
          >
            <AlertTriangle size={11} aria-hidden />
            {waitingLabel(waitingCount)}
          </button>
        </Tooltip>
      )}

      {/* Start (when paused) / Stop (when started) — THE hive control.
          Hidden when no hive is registered (nothing to start: feature work
          is event/routine-driven, the legacy run-loop launch is retired). */}
      {hive && !effectivelyAlive && (
        <Tooltip label={`Start hive (${hive.slug}) — wake the Queen and enable autonomous wakes`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--start"
            onClick={startHive}
            disabled={starting || isLoading}
          >
            <Play size={11} aria-hidden />
            {starting ? 'Starting…' : 'Start hive'}
          </button>
        </Tooltip>
      )}
      {hive && effectivelyAlive && (
        <Tooltip label={`Pause hive (${hive.slug}) — stage autonomous wakes and drain live bees`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--stop"
            onClick={stopHive}
          >
            <Square size={11} aria-hidden />
            Stop hive
          </button>
        </Tooltip>
      )}

      {hovered && (
        <AgentThinkingPopover
          slug={slug}
          phase={PHASE}
          runId={hovered.run.runId}
          role={hovered.run.role}
          anchorRect={hovered.rect}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenInspector={() => setHovered(null)}
        />
      )}
    </div>
    </>
  );
}

function parseRun(r: { runId: string; role: string; ts: number }): AgentRun {
  const after = r.runId.split('-').slice(1).join('-');
  const remainder = after.startsWith(`${r.role}-`)
    ? after.slice(r.role.length + 1)
    : after === r.role ? '' : after;
  return { runId: r.runId, role: r.role, featureId: remainder || null, ts: r.ts };
}
