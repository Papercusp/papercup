/**
 * AutomationPane — the shared body behind the Blender (learning), Docs and
 * Agents tabs.
 *
 * WHY (owner ask 2026-07-25): cron-spawned agents were consuming the owner's
 * weekly Claude limit with no surface to see or stop them. They are EPHEMERAL —
 * spawn, take a few turns, exit — so the agents-running roster reads empty while
 * spend is continuous, and there was nothing to click. This pane is that surface:
 * every scheduled routine in a category, which ones can COST TOKENS, and a
 * one-click pause for each (and for the whole pane).
 *
 * LAYOUT (owner ask 2026-07-25 round 2 — "make Blender and Docs more closely
 * model the Mug tab"): this pane is now built from the SAME three-part structure
 * MugTab uses, because the owner reads them as siblings in one rail:
 *   1. a header BAR — icon · title · subtitle · scope chip · whole-pane action,
 *   2. a titled SECTION holding the routine list.
 * Before this it was one long scroll with no header identity at all.
 *
 * Writes go through the audited run-tool bridge (`routines:set`), and — like every
 * other pane in this rail — the pane INVALIDATES ITS OWN READ after its own write
 * rather than waiting for the server's SSE push (see OverwatchTab's header comment
 * for what depending on that push costs).
 *
 * ⚠ THERE IS NO SPEND SECTION HERE, deliberately (owner correction 2026-07-25:
 * "Why is the spend tab inside blender? is that showing only blender related
 * spend? It looks like not."). It wasn't — and could not be. Spend is recorded per
 * agent ROLE with no FK back to the routine that spawned the agent, so the old
 * per-pane lane just filtered roles by hand: Blender claimed
 * ['scout','gym','worker','mug','kettle'] while Agents claimed
 * ['worker','mug','kettle','release-fixer','cup'], and the same worker/mug/kettle
 * dollars were counted in BOTH panes and presented as each one's own. Cost now
 * lives in exactly one honest place, the workspace-wide SpendTab. Do not add a
 * per-pane spend readout back: any role filter here is a guess rendered as fact.
 * See lib/automation/catalog.ts.
 */
import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, CalendarClock, Coins, Lock, Pause, Play } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import type {
  AutomationCatalog,
  AutomationCategory,
  AutomationRoutine,
} from '@papercusp/operator-core/lib/automation/catalog';

/** Fire a routine control tool through the gated/audited run-tool bridge (mirrors OverwatchTab). */
async function runRoutineTool(
  name: 'routines:set' | 'routines:group-set',
  args: Record<string, unknown>,
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  if (text) {
    const payload = JSON.parse(text) as { ok?: boolean; message?: string };
    if (payload.ok === false) throw new Error(payload.message ?? `${name} refused`);
  }
}

function agoLabel(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'now';
  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 36) return `${Math.round(hr)}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * The header's headline status — what the owner needs to know before reading a
 * single row: how many of this pane's scheduled agents can spend money right now.
 * Pure.
 */
export function scheduleLaneValue(rows: readonly AutomationRoutine[]): string {
  if (rows.length === 0) return 'None scheduled';
  const spending = rows.filter((r) => r.active && r.spawnsAgent).length;
  if (spending > 0) return `${spending} can spend`;
  const paused = rows.filter((r) => r.spawnsAgent).length;
  return paused > 0 ? 'All paused' : `${rows.length} scheduled`;
}

export interface AutomationPaneProps {
  active: boolean;
  /** Which categories this pane owns. Blender → ['learning'], Docs → ['docs']. */
  categories: readonly AutomationCategory[];
  title: string;
  /** One-line identity beside the title (the Mug bar's subtitle slot). */
  subtitle: string;
  /** lucide icon for the header bar. */
  icon: ComponentType<{ size?: number | string; 'aria-hidden'?: boolean }>;
  blurb: string;
}

export default function AutomationPane({
  active,
  categories,
  title,
  subtitle,
  icon: Icon,
  blurb,
}: AutomationPaneProps) {
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // useSyncQuery always yields an ARRAY (SyncQueryResult<T>.data is T[]); the
  // resolver returns a single catalog row, so unwrap it.
  const data = cat.data?.[0] ?? null;

  const rows: AutomationRoutine[] = useMemo(() => {
    if (!data) return [];
    return data.routines
      .filter((r) => categories.includes(r.category))
      // Agent-spawning (costly) first, then active, then name — the owner is here
      // to find what is spending money, so it must never be below the noise.
      .sort(
        (a, b) =>
          Number(b.spawnsAgent) - Number(a.spawnsAgent) ||
          Number(b.active) - Number(a.active) ||
          a.name.localeCompare(b.name),
      );
  }, [data, categories]);

  // What "Pause all" can ACTUALLY stop. Counting uncontrollable schedules here
  // would put a number on the button that the click cannot deliver — the pane
  // must never again promise an action it can't perform. The lane value above
  // still counts every spender, controllable or not, so the owner sees the true
  // spend picture even where the switch lives elsewhere.
  const activeSpawning = rows.filter((r) => r.active && r.spawnsAgent && r.controllable).length;

  async function toggleRoutine(r: AutomationRoutine) {
    const key = `${r.installSlug}/${r.name}`;
    setBusy(key);
    setErr(null);
    try {
      await runRoutineTool('routines:set', {
        name: r.name,
        installSlug: r.installSlug,
        active: !r.active,
      });
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pauseAll(nextActive: boolean) {
    setBusy('__all__');
    setErr(null);
    try {
      // No group-set here: this pane's categories are an owner-facing grouping that
      // does NOT map 1:1 to a routine group_slug (a docs routine can be filed under
      // health). Pausing each member by name is the only way the button does exactly
      // what its label says — and it never touches a routine outside this pane.
      // `controllable` guard: a non-routine schedule has no switch this tool can
      // throw, so including it would make the loop throw on a row it can never
      // change and abort the rest of the batch.
      for (const r of rows.filter((x) => x.controllable && x.spawnsAgent && x.active !== nextActive)) {
        await runRoutineTool('routines:set', {
          name: r.name,
          installSlug: r.installSlug,
          active: nextActive,
        });
      }
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!active) return null;

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-auto" data-testid={`automation-pane-${title.toLowerCase()}`}>
        {/* 1 — header bar (mirrors pc-queen__bar) */}
        <header className="pc-auto__bar">
          <Icon size={14} aria-hidden />
          <span className="pc-auto__identity">
            <span className="pc-auto__title">{title}</span>
            <span className="pc-auto__subtitle">{subtitle}</span>
          </span>
          {/* These are SCHEDULES, not per-pot agents — say so, for the same reason
              the Mug + Kettle headers now do (owner question 2026-07-25: "what do
              those pot labels mean if they operate at the workspace level?"). */}
          <Tooltip label="Scheduled agents run for the whole workspace, not one pot">
            <span className="pc-auto__scope">workspace</span>
          </Tooltip>
          <span className="pc-auto__spacer" />
          {activeSpawning > 0 ? (
            <Tooltip label={`Pause all ${activeSpawning} token-spending ${title} agent${activeSpawning === 1 ? '' : 's'}`}>
              <button
                type="button"
                className="pc-auto__action pc-auto__action--danger"
                disabled={busy !== null}
                onClick={() => void pauseAll(false)}
                data-testid="automation-pause-all"
              >
                <Pause size={11} aria-hidden /> Pause all
              </button>
            </Tooltip>
          ) : (
            rows.some((r) => r.spawnsAgent && r.controllable) && (
              <Tooltip label={`Resume the scheduled ${title} agents`}>
                <button
                  type="button"
                  className="pc-auto__action"
                  disabled={busy !== null}
                  onClick={() => void pauseAll(true)}
                  data-testid="automation-resume-all"
                >
                  <Play size={11} aria-hidden /> Resume all
                </button>
              </Tooltip>
            )
          )}
        </header>

        {err && (
          <div className="pc-auto__err" role="alert">
            <AlertTriangle size={12} aria-hidden /> {err}
          </div>
        )}
        {cat.error && <div className="pc-auto__err" role="alert">{String(cat.error)}</div>}

        {/* 2 — the routine section (mirrors pc-queen__panel + pc-queen__section) */}
        <div className="pc-auto__panel">
          <p className="pc-auto__blurb">{blurb}</p>
          <section className="pc-auto__section">
            <div className="pc-auto__section-head">
              <CalendarClock size={12} aria-hidden />
              <span className="pc-auto__section-title">Scheduled agents</span>
              <span className="pc-auto__count" data-testid="automation-status">
                {scheduleLaneValue(rows)}
              </span>
            </div>

              {cat.loading && !data && <div className="pc-auto__placeholder">Loading…</div>}

              {data && rows.length === 0 && (
                <div className="pc-auto__placeholder">
                  No scheduled agents in this category. Nothing here is consuming tokens.
                </div>
              )}

              {rows.length > 0 && (
                <div className="pc-auto__list" role="list">
                  {rows.map((r) => {
                    const key = `${r.installSlug}/${r.name}`;
                    return (
                      <div
                        key={key}
                        role="listitem"
                        className={`pc-auto__row${r.active ? ' is-active' : ''}`}
                        data-testid={`automation-row-${r.name}`}
                      >
                        <div className="pc-auto__row-main">
                          <span className="pc-auto__name" title={key}>
                            {r.name}
                          </span>
                          <span className="pc-auto__meta">
                            {r.cadence ?? 'event-driven'}
                            {r.spawnsAgent && (
                              <Tooltip label="This routine spawns a model-backed agent — it costs tokens when it fires">
                                <span className="pc-auto__tokenflag">
                                  <Coins size={10} aria-hidden /> tokens
                                </span>
                              </Tooltip>
                            )}
                          </span>
                          <span className="pc-auto__when">last {agoLabel(r.lastFiredAt)}</span>
                        </div>
                        {r.controllable ? (
                          <button
                            type="button"
                            className={`pc-auto__toggle${r.active ? ' is-on' : ''}`}
                            disabled={busy !== null}
                            aria-pressed={r.active}
                            aria-label={`${r.active ? 'Pause' : 'Resume'} ${r.name}`}
                            onClick={() => void toggleRoutine(r)}
                            data-testid={`automation-toggle-${r.name}`}
                          >
                            {busy === key ? '…' : r.active ? <Pause size={12} /> : <Play size={12} />}
                          </button>
                        ) : (
                          /* Listed for visibility, but NOT pausable from here:
                             `routines:set` writes harness_shared.routines and
                             nothing else, so a DBOS workflow / managed timer /
                             in-process sweep has no switch on this surface.
                             Render a plain marker, never a button — this pane's
                             original sin was offering controls that could not
                             act, and an inert-but-clickable toggle would repeat
                             that lie in a new place. */
                          <Tooltip
                            label={`Runs as a ${r.source} schedule, not a routine — visible here but paused from its own subsystem`}
                          >
                            <span
                              className="pc-auto__nocontrol"
                              data-testid={`automation-nocontrol-${r.name}`}
                              aria-label={`${r.name} cannot be paused from this pane`}
                            >
                              <Lock size={11} aria-hidden />
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
          </section>
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
