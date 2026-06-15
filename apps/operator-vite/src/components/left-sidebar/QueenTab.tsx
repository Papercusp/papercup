/**
 * QueenTab — the owner's Queen steering panel, docked in the Colony left sidebar
 * (queen-steering-panel-2026-06-15 B-04 / P-004; owner-review rounds 1–2, 2026-06-15).
 *
 * The owner steers the workspace's HOME Queen WITHOUT an interactive session.
 * Owner-review layout (top→bottom): Pause new work · Focus directive · Model
 * tiers (session override — #4, lands here once its backend field exists) ·
 * Eligible Hives · Eligible Plans.
 *
 * Two steering axes, both per-hive checkbox multi-selects (D-002 — eligibility is
 * DISTINCT from lifecycle status / membership):
 *  - Eligible PLANS — which plans she may pick up NOW. Empty ⇒ any plan.
 *  - Eligible HIVES — the placement SCOPE (which hives/harnesses she may place
 *    into → the survey's `allowedHarnesses`, enforced by C-2). Empty ⇒ anywhere.
 * Empty selection ⇒ NO restriction (today's behaviour) — surfaced loudly so an
 * empty list never reads as "nothing is eligible".
 *
 * There is NO "which hive to steer" picker (owner-review round 2): the tab always
 * steers the workspace's HOME Queen. The hive set is rendered as the Eligible
 * Hives SCOPE checkboxes instead of a confusing dropdown.
 *
 * Lives in the Colony left sidebar (LeftSidebar.tsx) — a narrow, collapsible
 * rail — as the DEFAULT-OPEN, leftmost tab. Rendered only while active.
 *
 * Data (CONTRACT C-1, su-81fe / B-01 + the round-2 `eligibleHives` extension):
 *  - hive set ← `/api/harness/projects/lite` (the SAME set the main AdvShell
 *    selector shows — buildHarnessSelectOptions).
 *  - steering ← `hive.steering` via useSyncQuery (the home hive's row).
 *  - writes   → `hive:set-steering` via /api/agent-mcp/run-tool (invalidates
 *    `hive.steering` + wakes the Queen).
 */
import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Crown, ListChecks, Network, Pause, Play, RotateCcw } from 'lucide-react';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';
import { buildHarnessSelectOptions } from '../adv/AdvShell';
import { ALL_HARNESSES_OPTION } from '../adv/adv-harness-selection';

/** One row of the `hive.steering` sync query (C-1, B-01 + round-2 eligibleHives). */
export interface HiveSteeringRow {
  slug: string;
  directive: string | null;
  eligiblePlans: string[];
  eligibleHives: string[];
  pauseNewWork: boolean;
  pausedUntil: number | null;
}

const DEFAULT_STEERING: Omit<HiveSteeringRow, 'slug'> = {
  directive: null,
  eligiblePlans: [],
  eligibleHives: [],
  pauseNewWork: false,
  pausedUntil: null,
};

type LiteProject = { slug: string; parent_slug?: string | null; harness_kind?: string | null };

export interface SteerPlanRow {
  slug: string;
  title: string;
  status: string | null;
  startStatus: string | null;
  inActive: boolean;
  eligible: boolean;
}

function planRank(p: PlanListRow): number {
  return p.startStatus === 'started' ? 0 : p.status === 'active' ? 1 : p.status === 'ready' ? 2 : 3;
}

/** Eligibility CANDIDATES: non-terminal plans (draft/ready/active), in-flight first. Pure. */
export function selectSteerablePlans(rows: readonly PlanListRow[]): PlanListRow[] {
  return rows
    .filter((p) => p.status !== 'shipped' && p.status !== 'superseded' && !p.archived)
    .slice()
    .sort((a, b) => planRank(a) - planRank(b) || (b.updated ?? '').localeCompare(a.updated ?? ''));
}

/** Candidates merged with the eligible set (+ stale eligible slugs not in the list). Pure. */
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
    if (!seen.has(slug)) out.push({ slug, title: slug, status: null, startStatus: null, inActive: false, eligible: true });
  }
  return out;
}

/** Add/remove a slug from an eligible set (the checkbox toggle). Pure. */
export function toggleEligible(current: readonly string[], slug: string): string[] {
  return current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
}

/** The steerable hive set as checkbox options — the SAME set the main AdvShell
 *  selector shows, minus the non-steering "All" + loading rows. Pure. */
export function steerHiveOptions(projects: LiteProject[]): Array<{ value: string; label: string }> {
  return buildHarnessSelectOptions(projects, null)
    .filter((o) => o.value !== ALL_HARNESSES_OPTION && o.value !== '__loading')
    .map((o) => ({ value: o.value, label: o.label }));
}

/** The HOME Queen's hive: the first formal hive (kind:'hive'), else the first
 *  steering row. The tab always steers this one (owner-review round 2). Pure. */
export function resolveHomeHive(projects: LiteProject[], rows: readonly HiveSteeringRow[]): string {
  return projects.find((p) => p.harness_kind === 'hive')?.slug || rows[0]?.slug || '';
}

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
  if (row.pauseNewWork) return { active: true, label: 'New work PAUSED' };
  if (row.pausedUntil != null && nowMs < row.pausedUntil) {
    const mins = Math.max(1, Math.round((row.pausedUntil - nowMs) / 60000));
    return { active: true, label: `Paused ~${mins}m` };
  }
  return { active: false, label: 'New work flowing' };
}

export default function QueenTab({ active }: { active: boolean }) {
  const steeringQ = useSyncQuery<HiveSteeringRow>({ queryName: 'hive.steering', args: {}, staleTime: 15_000 });
  const plansQ = usePlanList({ includeArchived: false, includeLegacy: false });

  const [projects, setProjects] = useState<LiteProject[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [pauseMins, setPauseMins] = useState('30');

  useEffect(() => {
    if (!active) return;
    let cancel = false;
    fetch('/api/harness/projects/lite', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancel) setProjects(Array.isArray(d?.projects) ? d.projects : []);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [active]);

  const rows = (steeringQ.data ?? []) as HiveSteeringRow[];
  const home = resolveHomeHive(projects, rows);
  const current: HiveSteeringRow = rows.find((r) => r.slug === home) ?? { slug: home, ...DEFAULT_STEERING };

  const hiveOptions = useMemo(() => steerHiveOptions(projects), [projects]);
  const candidates = selectSteerablePlans(plansQ.data?.plans ?? []);
  const planRows = buildSteerRows(candidates, current.eligiblePlans);
  const planRestricted = current.eligiblePlans.length > 0;
  const hiveRestricted = current.eligibleHives.length > 0;
  const pause = pauseStateLabel(current, Date.now());

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const write = async (key: string, args: Record<string, unknown>) => {
    if (!home) {
      setErr('No home hive found — start a hive first.');
      return;
    }
    setBusyKey(key, true);
    setErr(null);
    try {
      await runSetSteering({ hive: home, ...args });
      void steeringQ.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(key, false);
    }
  };

  const togglePlan = (slug: string) =>
    void write(`plan:${slug}`, { eligiblePlans: toggleEligible(current.eligiblePlans, slug) });
  const toggleHive = (slug: string) =>
    void write(`hive:${slug}`, { eligibleHives: toggleEligible(current.eligibleHives, slug) });
  const togglePause = () => void write('pause', { pauseNewWork: !current.pauseNewWork, pausedUntil: null });
  const pauseForMinutes = () => {
    const n = Number(pauseMins);
    if (!Number.isFinite(n) || n <= 0) {
      setErr('Enter a positive number of minutes.');
      return;
    }
    void write('until', { pauseNewWork: false, pausedUntil: Date.now() + Math.round(n) * 60_000 });
  };
  const clearPause = () => void write('until', { pauseNewWork: false, pausedUntil: null });
  const clearAll = () => void write('clear', { clear: true });

  return (
    <div className="pc-queen">
      <header className="pc-queen__bar">
        <Crown size={14} aria-hidden />
        <span className="pc-queen__title">Steering</span>
        {home && <span className="pc-queen__hive" title="The home Queen this steers">{home}</span>}
        <span className="pc-queen__spacer" />
        <button type="button" className="pc-queen__reset" onClick={clearAll} disabled={busy.has('clear')} title="Clear ALL steering back to default">
          <RotateCcw size={11} aria-hidden /> reset
        </button>
      </header>

      {err && (
        <div className="pc-queen__err" role="alert">
          <AlertTriangle size={12} aria-hidden /> {err}
        </div>
      )}

      {/* 1 — Pause new work (TOPMOST, owner-review round 2) */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <span className="pc-queen__section-title">Pause new work</span>
          <span className={`pc-queen__pausebadge${pause.active ? ' pc-queen__pausebadge--on' : ''}`}>{pause.label}</span>
        </div>
        <button
          type="button"
          className={`pc-queen__btn pc-queen__btn--block${current.pauseNewWork ? ' pc-queen__btn--stop' : ' pc-queen__btn--go'}`}
          onClick={togglePause}
          disabled={busy.has('pause')}
        >
          {current.pauseNewWork ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
          {current.pauseNewWork ? 'Resume new work' : 'Pause indefinitely'}
        </button>
        <div className="pc-queen__pausefor">
          <span className="pc-queen__presetlabel">pause for</span>
          <input type="number" min={1} className="pc-queen__mins" value={pauseMins} onChange={(e) => setPauseMins(e.target.value)} aria-label="Pause duration in minutes" />
          <span className="pc-queen__presetlabel">min</span>
          <button type="button" className="pc-queen__chip" onClick={pauseForMinutes} disabled={busy.has('until')}>apply</button>
          {current.pausedUntil != null && (
            <button type="button" className="pc-queen__chip" onClick={clearPause} disabled={busy.has('until')}>clear</button>
          )}
        </div>
        <span className="pc-queen__hint">drives existing placements to terminal, starts nothing new</span>
      </section>

      {/* 2 — Focus directive */}
      <DirectiveEditor
        key={home}
        initial={current.directive ?? ''}
        busy={busy.has('directive')}
        onSave={(text) => void write('directive', { directive: text.trim() ? text : null })}
      />

      {/* 3 — Model tiers (session override, D-006) lands here — #4, pending its backend override field. */}

      {/* 4 — Eligible Hives (placement scope, owner-review round 2) */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <Network size={12} aria-hidden />
          <span className="pc-queen__section-title">Eligible hives</span>
          <span className="pc-queen__count">{hiveRestricted ? `${current.eligibleHives.length} selected` : 'no restriction'}</span>
        </div>
        <div className={`pc-queen__scope${hiveRestricted ? ' pc-queen__scope--restricted' : ''}`}>
          {hiveRestricted
            ? 'Queen may place ONLY into the checked hives. Uncheck all to remove the scope.'
            : 'Nothing checked → Queen may place into ANY hive. Check hives to scope where she places work.'}
        </div>
        {hiveOptions.length === 0 ? (
          <div className="pc-queen__placeholder">Loading hives…</div>
        ) : (
          <ul className="pc-queen__plans">
            {hiveOptions.map((h) => {
              const on = current.eligibleHives.includes(h.value);
              return (
                <li key={h.value} className={`pc-queen__plan${on ? ' pc-queen__plan--on' : ''}`}>
                  <label className="pc-queen__planlabel">
                    <input type="checkbox" className="pc-queen__check" checked={on} disabled={busy.has(`hive:${h.value}`)} onChange={() => toggleHive(h.value)} />
                    <span className="pc-queen__planslug" title={h.value}>{h.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 5 — Eligible Plans */}
      <section className="pc-queen__section">
        <div className="pc-queen__section-head">
          <ListChecks size={12} aria-hidden />
          <span className="pc-queen__section-title">Eligible plans</span>
          <span className="pc-queen__count">{planRestricted ? `${current.eligiblePlans.length} selected` : 'no restriction'}</span>
        </div>
        <div className={`pc-queen__scope${planRestricted ? ' pc-queen__scope--restricted' : ''}`}>
          {planRestricted
            ? 'Queen works ONLY the checked plans. Uncheck all to remove the restriction.'
            : 'Nothing selected → Queen may work ANY plan. Check plans to focus her (eligibility ≠ lifecycle status).'}
        </div>
        {plansQ.loading && !plansQ.data ? (
          <div className="pc-queen__placeholder">Loading plans…</div>
        ) : planRows.length === 0 ? (
          <div className="pc-queen__placeholder">No steerable plans.</div>
        ) : (
          <ul className="pc-queen__plans">
            {planRows.map((p) => (
              <li key={p.slug} className={`pc-queen__plan${p.eligible ? ' pc-queen__plan--on' : ''}`}>
                <label className="pc-queen__planlabel">
                  <input type="checkbox" className="pc-queen__check" checked={p.eligible} disabled={busy.has(`plan:${p.slug}`)} onChange={() => togglePlan(p.slug)} />
                  <span className="pc-queen__planslug" title={p.slug}>{p.title}</span>
                </label>
                <span className="pc-queen__planstatus" data-status={p.inActive ? (p.startStatus === 'started' ? 'started' : p.status ?? '') : 'stale'}>
                  {p.inActive ? (p.startStatus === 'started' ? 'live' : p.status ?? '') : 'not active'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <QueenStyles />
    </div>
  );
}

/** Focus-directive editor — a mid-edit draft (useState) seeded from the saved value; keyed per-hive. */
function DirectiveEditor({ initial, onSave, busy }: { initial: string; onSave: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState(initial);
  const dirty = text !== initial;
  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <span className="pc-queen__section-title">Focus directive</span>
        <span className="pc-queen__count">in every wake brief</span>
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
          <button type="button" className="pc-queen__chip" onClick={() => setText(initial)} disabled={busy}>revert</button>
        )}
      </div>
    </section>
  );
}

function QueenStyles() {
  return (
    <style>{`
      .pc-queen { display: flex; flex-direction: column; gap: 9px; padding: 10px 10px 16px; min-height: 0; }
      .pc-queen__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11.5px; padding: 8px 2px; }
      .pc-queen__bar { display: flex; align-items: center; gap: 7px; }
      .pc-queen__bar svg { color: #fbbf24; }
      .pc-queen__title { font-size: 12px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-queen__hive {
        font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4);
        padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
      }
      .pc-queen__spacer { flex: 1; }
      .pc-queen__reset {
        display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.04em; padding: 3px 7px; border-radius: 6px; cursor: pointer; color: var(--fg-mute, #7f9bb4);
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-queen__reset:disabled { opacity: 0.5; cursor: default; }

      .pc-queen__err {
        display: flex; align-items: center; gap: 6px; font-size: 11px; color: #fca5a5;
        padding: 6px 9px; border-radius: 7px; border: 1px solid rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.1);
      }

      .pc-queen__section {
        display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-queen__section-head { display: flex; align-items: center; gap: 6px; }
      .pc-queen__section-head svg { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__section-title { font-size: 10.5px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg, #e7f7ff); }
      .pc-queen__count { margin-left: auto; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); text-align: right; }

      .pc-queen__btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; font-weight: 700;
        padding: 7px 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent;
      }
      .pc-queen__btn--block { width: 100%; }
      .pc-queen__btn:disabled { opacity: 0.55; cursor: default; }
      .pc-queen__btn--go { background: rgba(251, 191, 36, 0.16); color: #fcd34d; border-color: rgba(251, 191, 36, 0.4); }
      .pc-queen__btn--stop { background: rgba(34, 197, 94, 0.16); color: #86efac; border-color: rgba(34, 197, 94, 0.4); }
      .pc-queen__btn--save { background: rgba(99, 102, 241, 0.18); color: #c7d2fe; border-color: rgba(99, 102, 241, 0.45); }
      .pc-queen__chip {
        font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8);
        background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
      }
      .pc-queen__chip:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-queen__chip:disabled { opacity: 0.5; cursor: default; }

      .pc-queen__pausebadge {
        margin-left: auto; font-size: 9.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
        color: #6ee7b7; border: 1px solid rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1);
      }
      .pc-queen__pausebadge--on { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-queen__pausefor { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .pc-queen__presetlabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-mute, #7f9bb4); }
      .pc-queen__mins {
        width: 56px; font: inherit; font-size: 12px; padding: 4px 7px; border-radius: 6px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3));
      }
      .pc-queen__hint { font-size: 10px; color: var(--fg-mute, #7f9bb4); }

      .pc-queen__scope { font-size: 10.5px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); padding: 6px 8px; border-radius: 7px; background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.18); }
      .pc-queen__scope--restricted { color: #fcd34d; background: rgba(251, 191, 36, 0.08); border-color: rgba(251, 191, 36, 0.3); }

      .pc-queen__plans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; }
      .pc-queen__plan {
        display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02);
      }
      .pc-queen__plan--on { border-color: rgba(251, 191, 36, 0.45); background: rgba(251, 191, 36, 0.07); }
      .pc-queen__planlabel { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer; }
      .pc-queen__check { width: 14px; height: 14px; cursor: pointer; accent-color: #fbbf24; flex-shrink: 0; }
      .pc-queen__planslug { font-size: 11.5px; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pc-queen__planstatus {
        flex-shrink: 0; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 1px 6px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-queen__planstatus[data-status='started'] { color: #86efac; border-color: rgba(34, 197, 94, 0.4); }
      .pc-queen__planstatus[data-status='active'] { color: #7dd3fc; border-color: rgba(56, 189, 248, 0.4); }
      .pc-queen__planstatus[data-status='stale'] { color: #fca5a5; border-color: rgba(244, 63, 94, 0.4); }

      .pc-queen__directive {
        width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 11.5px; line-height: 1.4;
        padding: 7px 9px; border-radius: 8px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3));
      }
      .pc-queen__directive::placeholder { color: var(--fg-mute, #7f9bb4); }
      .pc-queen__directive:focus { outline: none; border-color: rgba(99, 102, 241, 0.6); }
      .pc-queen__directive-actions { display: flex; align-items: center; gap: 7px; }
    `}</style>
  );
}
