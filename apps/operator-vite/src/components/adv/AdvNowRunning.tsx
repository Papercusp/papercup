import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, Play, AlertTriangle } from 'lucide-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
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
async function runHiveControl(tool: 'hive:start' | 'hive:pause', slug: string): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tool, args: { harness: slug }, confirmed: true }),
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
 * Shows harness active/stopped state, the Start/Stop hive control, and one
 * pill per in-flight agent run. Ported from ActiveAgentsBar in HarnessDashboard.
 *
 * The Start/Stop button here IS the hive control (it replaced the global
 * header's HiveStartPauseButton, start-hive-wake-orchestration P-006):
 * Start launches this harness's run loop AND boots the brain (`hive:start` —
 * persisted started bit, Queen wake subscriptions, wake-mode auto); Stop
 * stops the harness processes AND pauses the brain (`hive:pause`). The hive
 * half is best-effort — skipped when no hive is registered.
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

  // The registered hive (N=1 build — local-hive scope). The hive control
  // tools key on the HIVE's home slug, not the selected harness, so we read
  // it from the same sync query the old header button used. Invalidated live
  // by hive:start / hive:pause.
  const { data: hiveData } = useSyncQuery({ queryName: 'hive.controlState', args: {} });
  const hive = (hiveData as HiveControlRow[] | undefined)?.[0];

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

  const startHive = useCallback(async () => {
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
      toast.success('Hive started', { description: d.logPath });
      // Optimistic: flip to active + "waiting for agent…" immediately; the
      // faster poll (driven by the awaitingAgent dep) takes over from here.
      setAlive(true);
      setAwaitingAgent(true);
    } catch (e) {
      toast.error('Start failed', { description: String(e) });
      setStarting(false);
      return;
    }
    // The brain half: persisted started bit + Queen wake subscriptions +
    // wake-mode auto + immediate Queen wake. Best-effort — the harness run
    // loop is already up; a hive-control failure shouldn't read as a failed
    // start, so it gets its own (non-blocking) error toast.
    if (hive) {
      try {
        await runHiveControl('hive:start', hive.slug);
      } catch (e) {
        toast.error(`Hive wake-orchestration failed (${hive.slug})`, { description: String(e) });
      }
    }
    setStarting(false);
  }, [slug, starting, hive]);

  const stopHive = useCallback(async () => {
    if (!slug) return;
    if (!window.confirm(`Stop the hive (${slug})? In-flight work will be interrupted.`)) return;
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
      return;
    }
    // Pause the brain too — wake-mode manual stages every autonomous wake, so
    // the colony actually goes quiet instead of the watchdog re-waking it.
    if (hive) {
      try {
        await runHiveControl('hive:pause', hive.slug);
      } catch (e) {
        toast.error(`Hive pause failed (${hive.slug})`, { description: String(e) });
      }
    }
  }, [slug, hive]);

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

      {/* Start (when stopped) / Stop (when active) — THE hive control */}
      {!effectivelyAlive && (
        <button
          type="button"
          className="pc-advshell__action pc-advshell__action--start"
          onClick={startHive}
          disabled={starting || isLoading}
          title="Start hive — launch this harness (staging phase) and wake the Queen"
        >
          <Play size={11} aria-hidden />
          {starting ? 'Starting…' : 'Start hive'}
        </button>
      )}
      {effectivelyAlive && (
        <button
          type="button"
          className="pc-advshell__action pc-advshell__action--stop"
          onClick={stopHive}
          title="Stop hive — stop harness processes (SIGTERM) and pause autonomous wakes"
        >
          <Square size={11} aria-hidden />
          Stop hive
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
