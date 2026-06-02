import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, Play, AlertTriangle } from 'lucide-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import AgentThinkingPopover from '@/app/harness/AgentThinkingPopover';
import { fetchPlanList, type PlanListRow } from '@/app/admin/plans/plans-api';

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

interface StatusResponse {
  alive?: boolean;
}

interface Props {
  slug: string | null;
}

const PHASE = 'staging';

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
 * Shows harness active/stopped state, start/stop controls, and one pill
 * per in-flight agent run. Ported from ActiveAgentsBar in HarnessDashboard.
 *
 * Polls /api/harness/:slug/agents + /status every 4 s.
 */
export default function AdvNowRunning({ slug }: Props) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [alive, setAlive] = useState<boolean | null>(null);
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
    if (!slug) { setRuns([]); setAlive(null); return; }
    let cancelled = false;
    const refresh = () => {
      Promise.all([
        fetch(`/api/harness/${encodeURIComponent(slug)}/agents?phase=${PHASE}`).then((r) =>
          r.ok ? (r.json() as Promise<AgentsResponse>) : null,
        ),
        fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=${PHASE}`).then((r) =>
          r.ok ? (r.json() as Promise<StatusResponse>) : null,
        ),
      ]).then(([agents, status]) => {
        if (cancelled) return;
        const live = (agents?.runs ?? []).filter((r) => r.running);
        const liveRuns = live.map(parseRun).sort((a, b) => a.ts - b.ts);
        setRuns(liveRuns);
        setAlive(status ? !!status.alive : null);
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

  // While the harness is stopped, count started-but-unpicked plans so the
  // bar can nudge "N plans waiting". A running harness is already working
  // them, so we skip the fetch entirely in that state (no extra request).
  useEffect(() => {
    const stopped = !(alive === true || awaitingAgent || runs.length > 0);
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
  }, [slug, alive, awaitingAgent, runs.length]);

  const launchHarness = useCallback(async () => {
    if (!slug || starting) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/launch?phase=${PHASE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.hint ?? j.error ?? msg; } catch { /* use status */ }
        throw new Error(msg);
      }
      const d = await res.json();
      toast.success('Harness launched', { description: d.logPath });
      // Optimistic: flip to active + "waiting for agent…" immediately; the
      // faster poll (driven by the awaitingAgent dep) takes over from here.
      setAlive(true);
      setAwaitingAgent(true);
    } catch (e) {
      toast.error('Launch failed', { description: String(e) });
    } finally {
      setStarting(false);
    }
  }, [slug, starting]);

  const stopHarness = useCallback(async () => {
    if (!slug) return;
    if (!window.confirm(`Stop harness ${slug}? In-flight work will be interrupted.`)) return;
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/stop?phase=${PHASE}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = (await res.json()) as { killed?: unknown[] };
      toast.success(`Stopped ${d.killed?.length ?? 0} process(es)`);
      setAlive(false);
      setAwaitingAgent(false);
      setRuns([]);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [slug]);

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

  // Treat a just-launched harness (and one with live runs) as active for
  // display, so the bar flips immediately rather than waiting for a poll.
  const effectivelyAlive = alive === true || awaitingAgent || runs.length > 0;
  const isLoading = alive === null && !awaitingAgent;
  const stateClass = isLoading ? 'is-checking' : effectivelyAlive ? 'is-active' : 'is-stopped';

  return (
    <div className={`pc-advshell__harness-bar pc-advshell__harness-bar--${stateClass}`} aria-label="Harness status">
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
              <button
                key={r.runId}
                type="button"
                className="pc-advshell__pill"
                title="Hover for live thinking"
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
            );
          })}
        </div>
      )}

      {/* Nudge: started plans exist but the harness isn't running to pick
          them up. Click → Plans tab, Running filter. */}
      {!effectivelyAlive && waitingCount > 0 && (
        <button
          type="button"
          className="pc-advshell__action pc-advshell__action--waiting"
          onClick={showWaitingPlans}
          title="These plans are started but the harness isn't running — click to view them"
        >
          <AlertTriangle size={11} aria-hidden />
          {waitingLabel(waitingCount)}
        </button>
      )}

      {/* Start (when stopped) / Stop (when active) */}
      {!effectivelyAlive && (
        <button
          type="button"
          className="pc-advshell__action pc-advshell__action--start"
          onClick={launchHarness}
          disabled={starting || isLoading}
          title="Start harness (staging phase)"
        >
          <Play size={11} aria-hidden />
          {starting ? 'Starting…' : 'Start harness'}
        </button>
      )}
      {effectivelyAlive && (
        <button
          type="button"
          className="pc-advshell__action pc-advshell__action--stop"
          onClick={stopHarness}
          title="Stop harness (SIGTERM)"
        >
          <Square size={11} aria-hidden />
          Stop harness
        </button>
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
  );
}

function parseRun(r: { runId: string; role: string; ts: number }): AgentRun {
  const after = r.runId.split('-').slice(1).join('-');
  const remainder = after.startsWith(`${r.role}-`)
    ? after.slice(r.role.length + 1)
    : after === r.role ? '' : after;
  return { runId: r.runId, role: r.role, featureId: remainder || null, ts: r.ts };
}
