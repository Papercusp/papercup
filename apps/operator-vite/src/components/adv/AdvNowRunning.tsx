import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, Play } from 'lucide-react';
import { toast } from 'sonner';
import AgentThinkingPopover from '@/app/harness/AgentThinkingPopover';

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
        setRuns(live.map(parseRun).sort((a, b) => a.ts - b.ts));
        setAlive(status ? !!status.alive : null);
      });
    };
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [slug]);

  useEffect(() => {
    if (runs.length === 0) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [runs.length]);

  const launchHarness = useCallback(async () => {
    if (!slug || starting) return;
    setStarting(true);
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/launch?phase=${PHASE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const d = await res.json();
      toast.success('Harness launched', { description: d.logPath });
      setTimeout(() => {
        fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=${PHASE}`)
          .then((r) => r.json())
          .then((s: StatusResponse) => setAlive(!!s.alive))
          .catch(() => {});
      }, 2000);
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
      setRuns([]);
    } catch (e) {
      toast.error('Stop failed', { description: String(e) });
    }
  }, [slug]);

  if (!slug) return null;

  const fmt = (sec: number) => {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
  };

  const isIdle = runs.length === 0;
  const isLoading = alive === null;
  const stateClass = isLoading ? 'is-checking' : alive ? 'is-active' : 'is-stopped';

  return (
    <div className={`pc-advshell__harness-bar pc-advshell__harness-bar--${stateClass}`} aria-label="Harness status">
      {/* Active status indicator — only shown when running */}
      {alive === true && (
        <div className="pc-advshell__harness-status">
          <span className="pc-advshell__harness-dot" aria-hidden />
          <span className="pc-advshell__harness-label">
            {isIdle ? 'Active — idle' : `Active — ${runs.length} agent${runs.length === 1 ? '' : 's'} running`}
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

      {/* Start (when stopped) / Stop (when active) */}
      {alive !== true && (
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
      {alive === true && (
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
