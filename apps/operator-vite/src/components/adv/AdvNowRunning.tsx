import { useCallback, useEffect, useMemo, useState } from 'react';
import { Square, Play, AlertTriangle } from 'lucide-react';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { type PlanListRow } from '@/app/admin/plans/plans-api';
import { useLexicon } from '@/lib/useLexicon';
import { Tooltip } from '@/app/harness/Tooltip';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface Props {
  slug: string | null;
}

/** One row of the `hive.controlState` sync query (per registered hive). */
interface HiveControlRow {
  slug: string;
  started: boolean;
}

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
 * Harness status bar above the tab strip — now purely the hive Start/Stop
 * control + the "N plans waiting" nudge.
 *
 * The per-agent run pills + the "Active — N agents running" label USED to live
 * here; they were removed once the unified, workspace-wide agent roster shipped
 * (AgentsRunningPill in the header) — that is now the single place agents are
 * listed, so per-Pot pills here were redundant.
 *
 * The Start/Stop button IS the hive control (replaced the retired global-header
 * HiveStartPauseButton): Start boots the brain (`hive:start`); Stop pauses it
 * (`hive:pause { drainBees:true }`). "Active" = the persisted per-hive
 * `started` bit (live via the hive.controlState invalidation) or a just-clicked
 * Start. Hidden when no hive is registered.
 */
export default function AdvNowRunning({ slug }: Props) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [starting, setStarting] = useState(false);
  // Optimistic post-launch state: the started bit arrives a beat after
  // hive:start (via the hive.controlState invalidation); a 20s safety net clears
  // this flag if it doesn't.
  const [awaitingAgent, setAwaitingAgent] = useState(false);

  // Navigation targets for the nudge — jump to the Plans tab filtered to the
  // Running bucket (= started plans).
  const [, setAdvTab] = useQueryState('tab', parseAsString);
  const [, setPlansView] = useQueryState('view', parseAsString);
  const [, setPlanBuckets] = useQueryState('pBuckets', parseAsArrayOf(parseAsString));

  // The registered hive. The hive control tools key on the HIVE's home slug, not
  // the selected harness; `started` is the bar's active/paused state, live via
  // the hive:start / hive:pause invalidation.
  const { data: hiveData } = useSyncQuery({ queryName: 'hive.controlState', args: {} });
  const hive = (hiveData as HiveControlRow[] | undefined)?.[0];
  const started = hive?.started === true;

  // Active = the persisted per-hive started bit, or a just-clicked Start. Per-
  // agent liveness now lives in the unified header roster, not here.
  const effectivelyAlive = started || awaitingAgent;
  const stopped = !effectivelyAlive;

  // While the hive is paused, count started-but-unpicked plans for the "N plans
  // waiting" nudge — push-driven via plans.list. A started hive is already
  // working them, so the query is disabled in that state (no fetch).
  const { data: waitingPlansData } = useSyncQuery({
    queryName: 'plans.list',
    args: { harness_slugs: slug ? [slug] : [] },
    enabled: !!slug && stopped,
  });
  const waitingCount = useMemo(
    () => (stopped ? countWaitingPlans((waitingPlansData as PlanListRow[] | undefined) ?? []) : 0),
    [waitingPlansData, stopped],
  );

  // Safety net: clear the optimistic "just started" flag after 20s (by then the
  // real started bit has arrived via the hive.controlState invalidation, or the
  // hive genuinely had nothing to start).
  useEffect(() => {
    if (!awaitingAgent) return;
    const id = window.setTimeout(() => setAwaitingAgent(false), 20_000);
    return () => window.clearTimeout(id);
  }, [awaitingAgent]);

  // START = boot the brain: hive:start persists the started bit, re-affirms the
  // Queen's event-wake subscriptions, flips wake-mode to auto, and wakes her now.
  const startHive = useCallback(async () => {
    if (!hive || starting) return;
    setStarting(true);
    try {
      await runHiveControl('hive:start', hive.slug);
      toast.success(`${t('pot')} started`, { description: `${t('brain')} woken — autonomous wakes enabled` });
      setAwaitingAgent(true);
    } catch (e) {
      toast.error('Start failed', { description: String(e) });
    }
    setStarting(false);
  }, [hive, starting]);

  // STOP = pause the brain: wake-mode manual stages every autonomous wake, the
  // Queen's time wake is cleared, and live bees get the graceful drain cue.
  const stopHive = useCallback(async () => {
    if (!hive) return;
    const ok = await askConfirm({
      title: `Pause ${t('pot', { lower: true })} (${hive.slug})?`,
      body: `Live ${t('contributor', { plural: true, lower: true })} are asked to wrap up; no new wakes fire until Start.`,
      confirmLabel: `Pause ${t('pot', { lower: true })}`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await runHiveControl('hive:pause', hive.slug, { drainBees: true });
      toast.success(`${t('pot')} paused`, { description: `Autonomous wakes staged; ${t('contributor', { plural: true, lower: true })} draining` });
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

  const isLoading = hiveData === undefined && !awaitingAgent;
  const stateClass = isLoading ? 'is-checking' : effectivelyAlive ? 'is-active' : 'is-stopped';

  return (
    <>
    {confirmEl}
    <div className={`pc-advshell__harness-bar pc-advshell__harness-bar--${stateClass}`} aria-label={`${t('pot')} status`}>
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
          Hidden when no hive is registered. */}
      {hive && !effectivelyAlive && (
        <Tooltip label={`Start ${t('pot', { lower: true })} (${hive.slug}) — wake the ${t('brain')} and enable autonomous wakes`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--start"
            onClick={startHive}
            disabled={starting || isLoading}
          >
            <Play size={11} aria-hidden />
            {starting ? 'Starting…' : `Start ${t('pot', { lower: true })}`}
          </button>
        </Tooltip>
      )}
      {hive && effectivelyAlive && (
        <Tooltip label={`Pause ${t('pot', { lower: true })} (${hive.slug}) — stage autonomous wakes and drain live ${t('contributor', { plural: true, lower: true })}`}>
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--stop"
            onClick={stopHive}
          >
            <Square size={11} aria-hidden />
            {`Stop ${t('pot', { lower: true })}`}
          </button>
        </Tooltip>
      )}
    </div>
    </>
  );
}
