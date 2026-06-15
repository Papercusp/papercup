/**
 * AdvQueenTab — the 👑 owner steering panel for the Queen
 * (queen-steering-panel-2026-06-15 B-04 / P-004, D-002/D-003).
 *
 * The owner's surface for steering the autonomous Queen WITHOUT an interactive
 * session: which plans she may pick up NOW (eligibility — DISTINCT from a plan's
 * lifecycle status, D-002), a free-text focus directive, and a new-work pause
 * (immediate or until a timestamp). Phase 1 = focus + pause + the tab shell; the
 * Phase-2 throttle knobs (cadence/concurrency/model-tier) come in a later brief.
 *
 * Data (CONTRACT C-1, su-81fe / B-01):
 *  - reads  `hive.steering`  via useSyncQuery → one row per hive
 *           { slug, directive, eligiblePlans, pauseNewWork, pausedUntil }.
 *  - reads  the active-plans list via `usePlanList` (the same plans API the
 *           Overview tab uses) — the eligibility candidates.
 *  - writes `hive:set-steering` via /api/agent-mcp/run-tool; the tool invalidates
 *           `hive.steering` AND wakes the Queen, so a change lands on her next
 *           survey immediately (no client-side resolver — that is su-81fe's B-01).
 *
 * Eligibility semantics (D-002): `eligiblePlans` EMPTY ⇒ NO restriction (the
 * Queen may work any plan — today's behaviour). Non-empty ⇒ she works ONLY those.
 * The UI surfaces that distinction loudly so an empty selection never reads as
 * "nothing is eligible".
 *
 * Theming = the operator-vite adv design system (pc-* classes + the CSS-var
 * tokens, like Overview/Health/Overwatch) — NOT the design-phase react-tailwind
 * store (that store is for a different surface). Themed Radix Select for the hive
 * picker; native controls carry explicit frost tokens so they don't render OS-default.
 */
import { parseAsString, useQueryState } from 'nuqs';
import { useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Crown, ListChecks, Pause, Play, RotateCcw } from 'lucide-react';
import { Select } from '@/app/harness/Select';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';

/** One row of the `hive.steering` sync query (C-1, B-01) — per registered hive. */
export interface HiveSteeringRow {
  slug: string;
  directive: string | null;
  eligiblePlans: string[];
  pauseNewWork: boolean;
  pausedUntil: number | null;
}

/** A plan row rendered with its eligibility checkbox state. */
export interface SteerPlanRow {
  slug: string;
  title: string;
  status: string | null;
  startStatus: string | null;
  /** True when the plan is in the live active-plans list (vs a stale eligible slug). */
  inActive: boolean;
  /** True when the Queen is currently allowed to pick this plan up. */
  eligible: boolean;
}

/** In-flight first, then active/ready, then most-recently-updated. Mirrors
 *  AdvOverviewTab.selectActivePlans' rank (kept local to avoid importing a tab). */
function planRank(p: PlanListRow): number {
  return p.startStatus === 'started' ? 0 : p.status === 'active' ? 1 : p.status === 'ready' ? 2 : 3;
}

/** The eligibility CANDIDATES: non-terminal plans (draft/ready/active), in-flight
 *  first. Pure — exported for unit tests. */
export function selectSteerablePlans(rows: readonly PlanListRow[]): PlanListRow[] {
  return rows
    .filter((p) => p.status !== 'shipped' && p.status !== 'superseded' && !p.archived)
    .slice()
    .sort((a, b) => planRank(a) - planRank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''));
}

/**
 * Merge the candidate plans with the currently-eligible slugs: every candidate
 * (checkbox reflecting whether it's eligible), PLUS any eligible slug NOT in the
 * candidate list (a stale/shipped pick the owner can still un-check). Pure.
 */
export function buildSteerRows(active: readonly PlanListRow[], eligible: readonly string[]): SteerPlanRow[] {
  const eligibleSet = new Set(eligible);
  const seen = new Set<string>();
  const out: SteerPlanRow[] = [];
  for (const p of active) {
    seen.add(p.slug);
    out.push({
      slug: p.slug,
      title: p.title ?? p.slug,
      status: p.status ?? null,
      startStatus: p.startStatus ?? null,
      inActive: true,
      eligible: eligibleSet.has(p.slug),
    });
  }
  for (const slug of eligible) {
    if (!seen.has(slug)) {
      out.push({ slug, title: slug, status: null, startStatus: null, inActive: false, eligible: true });
    }
  }
  return out;
}

/** Add/remove a slug from the eligible set (the checkbox toggle). Pure. */
export function toggleEligible(current: readonly string[], slug: string): string[] {
  return current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
}

/** Fire hive:set-steering through the gated/audited run-tool bridge (the same
 *  path runHiveControl uses for hive:start/pause). Throws so callers can surface. */
async function runSetSteering(args: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hive:set-steering', args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? 'hive:set-steering refused');
}

function pauseStateLabel(row: HiveSteeringRow, nowMs: number): { active: boolean; label: string } {
  if (row.pauseNewWork) return { active: true, label: 'New work PAUSED (indefinite)' };
  if (row.pausedUntil != null && nowMs < row.pausedUntil) {
    const mins = Math.round((row.pausedUntil - nowMs) / 60000);
    const until = new Date(row.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { active: true, label: `New work paused until ${until} (~${mins}m)` };
  }
  return { active: false, label: 'New work flowing' };
}

export default function AdvQueenTab() {
  const steeringQ = useSyncQuery<HiveSteeringRow>({ queryName: 'hive.steering', args: {}, staleTime: 15_000 });
  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });
  const [qhive, setQhive] = useQueryState('qhive', parseAsString);

  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const rows = (steeringQ.data ?? []) as HiveSteeringRow[];
  const current = rows.find((r) => r.slug === qhive) ?? rows[0];

  if (!current) {
    return (
      <div className="pc-queen pc-queen--empty">
        <div className="pc-queen__placeholder">
          {steeringQ.error
            ? `Steering unavailable — ${String(steeringQ.error)}`
            : steeringQ.loading
              ? 'Loading Queen steering…'
              : 'No hive to steer — start a hive first.'}
        </div>
        <QueenStyles />
      </div>
    );
  }

  const candidates = selectSteerablePlans(plansQ.data?.plans ?? []);
  const steerRows = buildSteerRows(candidates, current.eligiblePlans);
  const restricted = current.eligiblePlans.length > 0;
  const pause = pauseStateLabel(current, Date.now());

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /** Run a steering write, manage the busy/error state, and refresh the panel. */
  const write = async (key: string, args: Record<string, unknown>) => {
    setBusyKey(key, true);
    setErr(null);
    try {
      await runSetSteering({ hive: current.slug, ...args });
      // The tool invalidates hive.steering server-side; nudge a refetch for snappiness.
      void steeringQ.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(key, false);
    }
  };

  const togglePlan = (slug: string) =>
    void write(`plan:${slug}`, { eligiblePlans: toggleEligible(current.eligiblePlans, slug) });
  const togglePause = () => void write('pause', { pauseNewWork: !current.pauseNewWork, pausedUntil: null });
  const pauseFor = (hours: number) =>
    void write('until', { pauseNewWork: false, pausedUntil: Date.now() + hours * 3_600_000 });
  const clearPause = () => void write('until', { pauseNewWork: false, pausedUntil: null });
  const clearAll = () => void write('clear', { clear: true });

  return (
    <div className="pc-queen">
      <header className="pc-queen__bar">
        <Crown size={16} aria-hidden />
        <span className="pc-queen__title">Queen steering</span>
        {rows.length > 1 ? (
          <Select
            value={current.slug}
            onChange={(v: string) => void setQhive(v)}
            options={rows.map((r) => ({ value: r.slug, label: r.slug }))}
            ariaLabel="Select hive to steer"
          />
        ) : (
          <span className="pc-queen__hive" title="Supervised hive">{current.slug}</span>
        )}
        <span className="pc-queen__spacer" />
        <button
          type="button"
          className="pc-queen__reset"
          onClick={clearAll}
          disabled={busy.has('clear')}
          title="Clear ALL steering back to the default (no restriction, not paused)"
        >
          <RotateCcw size={12} aria-hidden /> reset all
        </button>
      </header>

      {err && (
        <div className="pc-queen__err" role="alert">
          <AlertTriangle size={13} aria-hidden /> {err}
        </div>
      )}

      {/* ── Pause new work ─────────────────────────────────────────────── */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <span className="pc-queen__section-title">Pause new work</span>
          <span className={`pc-queen__pausebadge${pause.active ? ' pc-queen__pausebadge--on' : ''}`}>{pause.label}</span>
        </div>
        <div className="pc-queen__pauserow">
          <button
            type="button"
            className={`pc-queen__btn${current.pauseNewWork ? ' pc-queen__btn--stop' : ' pc-queen__btn--go'}`}
            onClick={togglePause}
            disabled={busy.has('pause')}
          >
            {current.pauseNewWork ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
            {current.pauseNewWork ? 'Resume new work' : 'Pause new work'}
          </button>
          <span className="pc-queen__hint">drives existing placements to terminal, starts nothing new</span>
          <span className="pc-queen__spacer" />
          <span className="pc-queen__presetlabel">pause for:</span>
          <button type="button" className="pc-queen__chip" onClick={() => pauseFor(1)} disabled={busy.has('until')}>1h</button>
          <button type="button" className="pc-queen__chip" onClick={() => pauseFor(4)} disabled={busy.has('until')}>4h</button>
          <button type="button" className="pc-queen__chip" onClick={() => pauseFor(12)} disabled={busy.has('until')}>12h</button>
          {current.pausedUntil != null && (
            <button type="button" className="pc-queen__chip" onClick={clearPause} disabled={busy.has('until')}>clear</button>
          )}
        </div>
      </section>

      {/* ── Plan eligibility ───────────────────────────────────────────── */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <ListChecks size={13} aria-hidden />
          <span className="pc-queen__section-title">Eligible plans</span>
          <span className="pc-queen__count">{restricted ? `${current.eligiblePlans.length} selected` : 'no restriction'}</span>
        </div>
        <div className={`pc-queen__scope${restricted ? ' pc-queen__scope--restricted' : ''}`}>
          {restricted
            ? 'The Queen may pick up ONLY the checked plans. Uncheck all to remove the restriction.'
            : 'No plans selected → the Queen may pick up ANY plan (today’s behaviour). Check plans to focus her on only those. Eligibility is separate from a plan’s lifecycle status.'}
        </div>
        {plansQ.loading && !plansQ.data ? (
          <div className="pc-queen__placeholder">Loading plans…</div>
        ) : steerRows.length === 0 ? (
          <div className="pc-queen__placeholder">No steerable plans.</div>
        ) : (
          <ul className="pc-queen__plans">
            {steerRows.map((p) => (
              <li key={p.slug} className={`pc-queen__plan${p.eligible ? ' pc-queen__plan--on' : ''}`}>
                <label className="pc-queen__planlabel">
                  <input
                    type="checkbox"
                    className="pc-queen__check"
                    checked={p.eligible}
                    disabled={busy.has(`plan:${p.slug}`)}
                    onChange={() => togglePlan(p.slug)}
                  />
                  <span className="pc-queen__planslug" title={p.slug}>{p.title}</span>
                </label>
                {p.inActive ? (
                  <span className="pc-queen__planstatus" data-status={p.startStatus === 'started' ? 'started' : p.status}>
                    {p.startStatus === 'started' ? 'in flight' : (p.status ?? '')}
                  </span>
                ) : (
                  <span className="pc-queen__planstatus" data-status="stale" title="Eligible but not in the active plan list">
                    not active
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DirectiveEditor
        key={current.slug}
        initial={current.directive ?? ''}
        busy={busy.has('directive')}
        onSave={(text) => void write('directive', { directive: text.trim() ? text : null })}
      />

      <QueenStyles />
    </div>
  );
}

/** The focus-directive editor — a mid-edit draft (useState, not nuqs) seeded from
 *  the saved value; remounted per-hive via a `key`. */
function DirectiveEditor({ initial, onSave, busy }: { initial: string; onSave: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState(initial);
  const dirty = text !== initial;
  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <span className="pc-queen__section-title">Focus directive</span>
        <span className="pc-queen__count">surfaced in every Queen wake brief</span>
      </div>
      <textarea
        className="pc-queen__directive"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Only work the steering + benchmark plans; convert their items to work-items, place those, start nothing new."
        rows={3}
      />
      <div className="pc-queen__directive-actions">
        <button type="button" className="pc-queen__btn pc-queen__btn--save" onClick={() => onSave(text)} disabled={busy || !dirty}>
          {busy ? 'Saving…' : dirty ? 'Save directive' : 'Saved'}
        </button>
        {dirty && (
          <button type="button" className="pc-queen__chip" onClick={() => setText(initial)} disabled={busy}>
            revert
          </button>
        )}
      </div>
    </section>
  );
}

function QueenStyles() {
  return (
    <style>{`
      .pc-queen { display: flex; flex-direction: column; gap: 12px; min-height: 0; flex: 1; padding: 14px 16px 18px; overflow-y: auto; }
      .pc-queen--empty { align-items: center; justify-content: center; }
      .pc-queen__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 12.5px; padding: 14px; }

      .pc-queen__bar {
        display: flex; align-items: center; gap: 9px; padding: 10px 14px; border-radius: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-queen__bar svg { color: #fbbf24; }
      .pc-queen__title { font-size: 13px; font-weight: 760; letter-spacing: 0.02em; color: var(--fg, #e7f7ff); }
      .pc-queen__hive {
        font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4);
        padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__spacer { flex: 1; }
      .pc-queen__reset {
        display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; padding: 4px 9px; border-radius: 7px; cursor: pointer; color: var(--fg-mute, #7f9bb4);
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-queen__reset:disabled { opacity: 0.5; cursor: default; }

      .pc-queen__err {
        display: flex; align-items: center; gap: 7px; font-size: 12px; color: #fca5a5;
        padding: 8px 12px; border-radius: 9px; border: 1px solid rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.1);
      }

      .pc-queen__section {
        display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-queen__section-head { display: flex; align-items: center; gap: 7px; }
      .pc-queen__section-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__section-title { font-size: 11.5px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-queen__count { margin-left: auto; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }

      .pc-queen__pausebadge {
        margin-left: auto; font-size: 10.5px; font-weight: 700; padding: 2px 9px; border-radius: 999px;
        color: #6ee7b7; border: 1px solid rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1);
      }
      .pc-queen__pausebadge--on { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-queen__pauserow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pc-queen__hint { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-queen__presetlabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-mute, #7f9bb4); }

      .pc-queen__btn {
        display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700;
        padding: 6px 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent;
      }
      .pc-queen__btn:disabled { opacity: 0.55; cursor: default; }
      .pc-queen__btn--go { background: rgba(251, 191, 36, 0.16); color: #fcd34d; border-color: rgba(251, 191, 36, 0.4); }
      .pc-queen__btn--stop { background: rgba(34, 197, 94, 0.16); color: #86efac; border-color: rgba(34, 197, 94, 0.4); }
      .pc-queen__btn--save { background: rgba(99, 102, 241, 0.18); color: #c7d2fe; border-color: rgba(99, 102, 241, 0.45); }
      .pc-queen__chip {
        font-size: 10.5px; font-weight: 700; padding: 4px 9px; border-radius: 7px; cursor: pointer; color: var(--fg-dim, #b9d4e8);
        background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
      }
      .pc-queen__chip:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: rgba(125, 211, 252, 0.4); }
      .pc-queen__chip:disabled { opacity: 0.5; cursor: default; }

      .pc-queen__scope { font-size: 11.5px; line-height: 1.4; color: var(--fg-dim, #b9d4e8); padding: 7px 10px; border-radius: 8px; background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.18); }
      .pc-queen__scope--restricted { color: #fcd34d; background: rgba(251, 191, 36, 0.08); border-color: rgba(251, 191, 36, 0.3); }

      .pc-queen__plans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
      .pc-queen__plan {
        display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02);
      }
      .pc-queen__plan--on { border-color: rgba(251, 191, 36, 0.45); background: rgba(251, 191, 36, 0.07); }
      .pc-queen__planlabel { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; cursor: pointer; }
      .pc-queen__check { width: 15px; height: 15px; cursor: pointer; accent-color: #fbbf24; flex-shrink: 0; }
      .pc-queen__planslug { font-size: 12px; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pc-queen__planstatus {
        flex-shrink: 0; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 1px 7px; border-radius: 999px; color: var(--fg-mute, #7f9bb4);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__planstatus[data-status='started'] { color: #86efac; border-color: rgba(34, 197, 94, 0.4); }
      .pc-queen__planstatus[data-status='active'] { color: #7dd3fc; border-color: rgba(56, 189, 248, 0.4); }
      .pc-queen__planstatus[data-status='stale'] { color: #fca5a5; border-color: rgba(244, 63, 94, 0.4); }

      .pc-queen__directive {
        width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 12px; line-height: 1.45;
        padding: 9px 11px; border-radius: 9px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3));
      }
      .pc-queen__directive::placeholder { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__directive:focus { outline: none; border-color: rgba(99, 102, 241, 0.6); }
      .pc-queen__directive-actions { display: flex; align-items: center; gap: 8px; }
    `}</style>
  );
}
