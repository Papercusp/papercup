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
import { AlertTriangle, CalendarClock, Coins, Lock, Pause, Play, Shield } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import type {
  AutomationCatalog,
  AutomationCategory,
  AutomationGymArm,
  AutomationLaneArm,
  AutomationRoutine,
} from '@papercusp/operator-core/lib/automation/catalog';

/** budgetEdit key for the workspace-ceiling row (not a pot/lane arm — its own save path). */
const SCOUT_CEILING_KEY = 'scout/workspace-ceiling';

/** Fire a routine control tool through the gated/audited run-tool bridge (mirrors OverwatchTab). */
async function runRoutineTool(
  name: 'routines:set' | 'routines:group-set' | 'gym:arm' | 'governor:arm' | 'learning:set-scout-budget',
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
 *
 * ⚠ This counter is about MONEY, not about running-ness — it only ever looks at
 * `spawnsAgent` rows. The zero case therefore must NOT say "All paused": seen
 * live on the Docs pane (2026-07-25), it read "All paused" while
 * knowledge-pack-delivery had fired 75m earlier and knowledge-pack-hygiene 15h
 * earlier — both genuinely running, neither a spender. "All paused" is the one
 * phrasing that invites the false global reading; "None can spend" keeps the
 * column's single money meaning, stays parallel with the `N can spend` and
 * `None scheduled` branches, and still avoids the robotic literal "0 can spend"
 * this branch was originally written to dodge.
 */
export function scheduleLaneValue(rows: readonly AutomationRoutine[]): string {
  if (rows.length === 0) return 'None scheduled';
  const spending = rows.filter((r) => r.active && r.spawnsAgent).length;
  if (spending > 0) return `${spending} can spend`;
  const spenders = rows.filter((r) => r.spawnsAgent).length;
  return spenders > 0 ? 'None can spend' : `${rows.length} scheduled`;
}

/**
 * The Arming section's headline — how many spend gates are OPEN right now.
 * Distinct from `scheduleLaneValue` on purpose: that one counts schedules that
 * can fire, this one counts pots/lanes allowed to SPEND when something fires.
 * Pure.
 */
export function armingLaneValue(gymPots: readonly AutomationGymArm[], lanes: readonly AutomationLaneArm[]): string {
  const total = gymPots.length + lanes.length;
  if (total === 0) return 'None registered';
  const armed = gymPots.filter((g) => g.enabled).length + lanes.filter((l) => l.enabled).length;
  return armed > 0 ? `${armed} armed` : 'All disarmed';
}

/** "$12.89 of $50" / "$0 · no budget" — one honest money label per arming row. Pure. */
export function armBudgetLabel(spentUsd: number, budgetUsd: number | null): string {
  const money = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, '')}`;
  return budgetUsd === null ? `${money(spentUsd)} · no budget` : `${money(spentUsd)} of ${money(budgetUsd)}`;
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
  // Budget click-to-edit: which arming row is being edited, and the draft text.
  // Draft state is render-local (mid-edit), so useState is correct here, not nuqs.
  const [budgetEdit, setBudgetEdit] = useState<{ key: string; value: string } | null>(null);

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
    const nextActive = !r.active;
    setBusy(key);
    setErr(null);
    try {
      await runRoutineTool('routines:set', {
        name: r.name,
        installSlug: r.installSlug,
        active: nextActive,
        // routines:set requires `reason` when pausing (EI-18654017982759582 — an
        // unattributed pause has twice stayed silently off for days). This pane's
        // whole point is a ONE-CLICK pause (see header comment), so a text prompt
        // would defeat the design — attribute it to the pane itself instead of
        // leaving the click to structurally fail every time (EI-18680916805234639,
        // 3/14 = 21% of routines:set calls in a 24h window, all coord_owner_id
        // 'loopback' from this exact call site).
        ...(nextActive ? {} : { reason: `Paused via Automation pane (${title})` }),
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
          // Same reason-on-pause requirement as toggleRoutine above.
          ...(nextActive ? {} : { reason: `Paused via Automation pane "Pause all" (${title})` }),
        });
      }
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ── Arming (spend gates) — Blender only ────────────────────────────────────
  // The schedule rows above gate WHEN things fire; these gate whether a fire may
  // SPEND. Rendered only for the learning category (the owner ask that created
  // this section: "it should be in the blender tab").
  const showArming = categories.includes('learning');
  const arming = data?.arming ?? null;

  async function runArm(
    key: string,
    tool: 'gym:arm' | 'governor:arm' | 'learning:set-scout-budget',
    args: Record<string, unknown>,
  ): Promise<void> {
    setBusy(key);
    setErr(null);
    try {
      await runRoutineTool(tool, args);
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Commit a budget draft: '' clears the budget (null), otherwise a finite ≥0 number. */
  async function saveBudget(row: { key: string; tool: 'gym:arm' | 'governor:arm'; idArgs: Record<string, unknown> }): Promise<void> {
    if (!budgetEdit || budgetEdit.key !== row.key) return;
    const raw = budgetEdit.value.trim();
    const budgetUsd = raw === '' ? null : Number(raw);
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      setErr(`"${raw}" is not a valid budget — enter a dollar amount, or clear to remove the cap`);
      return;
    }
    setBudgetEdit(null);
    await runArm(row.key, row.tool, { ...row.idArgs, budgetUsd });
  }

  /** Commit the workspace-ceiling draft: '' clears the override (env/default resumes), otherwise a finite ≥0 number sets it. */
  async function saveScoutCeiling(): Promise<void> {
    if (!budgetEdit || budgetEdit.key !== SCOUT_CEILING_KEY) return;
    const raw = budgetEdit.value.trim();
    if (raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      setErr(`"${raw}" is not a valid ceiling — enter a dollar amount, or clear to revert to the default`);
      return;
    }
    setBudgetEdit(null);
    await runArm(
      SCOUT_CEILING_KEY,
      'learning:set-scout-budget',
      raw === '' ? { op: 'clear' } : { op: 'set', workspaceCeilingUsd: Number(raw) },
    );
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

          {/* 3 — the Arming section (P-011, Blender only): the SPEND gates.
              A schedule row above can be active while its pot/lane here is
              disarmed — the routine fires and spends nothing. This section is
              the switch the owner asked for ("it should be in the blender
              tab"): per-pot gym arming (gym:arm writes BOTH the autoloop config
              and the gym:<slug> governor row) and per-lane governor arming
              (governor:arm). */}
          {showArming && arming && (arming.gymPots.length > 0 || arming.lanes.length > 0 || arming.scoutCeiling != null) && (
            <section className="pc-auto__section" data-testid="automation-arming">
              <div className="pc-auto__section-head">
                <Shield size={12} aria-hidden />
                <span className="pc-auto__section-title">Arming — spend gates</span>
                <span className="pc-auto__count" data-testid="automation-arming-status">
                  {armingLaneValue(arming.gymPots, arming.lanes)}
                </span>
              </div>
              <div className="pc-auto__list" role="list">
                {arming.scoutCeiling && (
                  <div
                    role="listitem"
                    className="pc-auto__row is-active"
                    data-testid="arming-row-scout-workspace-ceiling"
                  >
                    <div className="pc-auto__row-main">
                      <span
                        className="pc-auto__name"
                        title="Workspace-wide learning spend ceiling — caps ALL Blender/Scout spend above the per-pot and per-lane budgets below. 0 = no learning spend allowed. Empty reverts to the built-in default."
                      >
                        workspace ceiling
                      </span>
                      <span className="pc-auto__meta">
                        {budgetEdit?.key === SCOUT_CEILING_KEY ? (
                          <input
                            className="pc-auto__budget-input"
                            style={{ width: 64, font: 'inherit' }}
                            autoFocus
                            inputMode="decimal"
                            aria-label="Workspace learning spend ceiling (USD; empty reverts to the default)"
                            value={budgetEdit.value}
                            onChange={(e) => setBudgetEdit({ key: SCOUT_CEILING_KEY, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveScoutCeiling();
                              if (e.key === 'Escape') setBudgetEdit(null);
                            }}
                            onBlur={() => setBudgetEdit(null)}
                            data-testid="arming-budget-input-scout-workspace-ceiling"
                          />
                        ) : (
                          <Tooltip label="Click to edit the workspace ceiling (Enter saves, Esc cancels; empty reverts to the default)">
                            <button
                              type="button"
                              className="pc-auto__budget"
                              style={{ all: 'unset', cursor: 'pointer' }}
                              disabled={busy !== null}
                              onClick={() =>
                                setBudgetEdit({
                                  key: SCOUT_CEILING_KEY,
                                  value:
                                    arming.scoutCeiling!.overrideUsd === null
                                      ? ''
                                      : String(arming.scoutCeiling!.overrideUsd),
                                })
                              }
                              data-testid="arming-budget-scout-workspace-ceiling"
                            >
                              <Coins size={10} aria-hidden /> ${arming.scoutCeiling.effectiveUsd} ceiling
                            </button>
                          </Tooltip>
                        )}
                      </span>
                      <span className="pc-auto__when">
                        {arming.scoutCeiling.overrideUsd === null ? 'default' : 'override'}
                      </span>
                    </div>
                  </div>
                )}
                {[
                  ...arming.gymPots.map((g) => ({
                    key: `gym/${g.harnessSlug}`,
                    tool: 'gym:arm' as const,
                    idArgs: { harness: g.harnessSlug },
                    name: `gym · ${g.harnessSlug}`,
                    hint: `Gym autoloop for the ${g.harnessSlug} pot — arming writes the autoloop config AND its governor row together`,
                    enabled: g.enabled,
                    budgetUsd: g.budgetUsd,
                    spentUsd: g.spentUsd,
                    meta: g.status,
                  })),
                  ...arming.lanes.map((l) => ({
                    key: `lane/${l.loopId}`,
                    tool: 'governor:arm' as const,
                    idArgs: { loopId: l.loopId },
                    name: l.displayName,
                    hint: l.loopId + (l.potSlug ? ` · pot ${l.potSlug}` : ''),
                    enabled: l.enabled,
                    budgetUsd: l.budgetUsd,
                    spentUsd: l.spentUsd,
                    meta: l.enforcement,
                  })),
                ].map((row) => (
                  <div
                    key={row.key}
                    role="listitem"
                    className={`pc-auto__row${row.enabled ? ' is-active' : ''}`}
                    data-testid={`arming-row-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                  >
                    <div className="pc-auto__row-main">
                      <span className="pc-auto__name" title={row.hint}>
                        {row.name}
                      </span>
                      <span className="pc-auto__meta">
                        {budgetEdit?.key === row.key ? (
                          <input
                            className="pc-auto__budget-input"
                            style={{ width: 64, font: 'inherit' }}
                            autoFocus
                            inputMode="decimal"
                            aria-label={`Budget for ${row.name} (USD; empty clears)`}
                            value={budgetEdit.value}
                            onChange={(e) => setBudgetEdit({ key: row.key, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveBudget(row);
                              if (e.key === 'Escape') setBudgetEdit(null);
                            }}
                            onBlur={() => setBudgetEdit(null)}
                            data-testid={`arming-budget-input-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                          />
                        ) : (
                          <Tooltip label="Click to edit the budget (Enter saves, Esc cancels; empty clears the cap)">
                            <button
                              type="button"
                              className="pc-auto__budget"
                              style={{ all: 'unset', cursor: 'pointer' }}
                              disabled={busy !== null}
                              onClick={() =>
                                setBudgetEdit({ key: row.key, value: row.budgetUsd === null ? '' : String(row.budgetUsd) })
                              }
                              data-testid={`arming-budget-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                            >
                              <Coins size={10} aria-hidden /> {armBudgetLabel(row.spentUsd, row.budgetUsd)}
                            </button>
                          </Tooltip>
                        )}
                      </span>
                      <span className="pc-auto__when">{row.meta}</span>
                    </div>
                    <button
                      type="button"
                      className={`pc-auto__toggle${row.enabled ? ' is-on' : ''}`}
                      disabled={busy !== null}
                      aria-pressed={row.enabled}
                      aria-label={`${row.enabled ? 'Disarm' : 'Arm'} ${row.name}`}
                      onClick={() => void runArm(row.key, row.tool, { ...row.idArgs, enabled: !row.enabled })}
                      data-testid={`arming-toggle-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                    >
                      {busy === row.key ? '…' : row.enabled ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
