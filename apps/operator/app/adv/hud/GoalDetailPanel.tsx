'use client';

/**
 * GoalDetailPanel (goal-mode-2026-08-07 P-021) — the goal opened from a HUD
 * goal card. The rail tab answers "is anything on fire"; this answers "I have
 * not looked in three days, what happened and what needs me".
 *
 * ── One query, one param ──────────────────────────────────────────────────
 * Everything on this page comes from `goals.detail` (resolveGoalDetail), which
 * already returns each section pre-shaped. A second query would be a second
 * clock: the projects grid and the spend chart are two readings of the same
 * ledger, and fetching them separately lets them disagree on screen.
 *
 * The open-state param is `hudgoal` — the SAME param the board uses for "the
 * selected goal", not a second `hudgoaldetail` key. Two params would let the
 * board sit scoped to goal A while this panel shows goal B, and there is no
 * reading of that screen that is not a lie about one of them. Closing the panel
 * therefore clears the selection, which is also what a second click on the card
 * does — the two exits agree.
 *
 * ⚠ `workspaceId` is REQUIRED and non-null here on purpose. `goals.detail`
 * defaults an absent workspace to the `'default'` tenant, which returns a goal
 * that renders as a healthy-looking empty page pointed at the wrong tenant (the
 * WI-5125 shape). HudView resolves the real id (`goalWorkspaceId`) for exactly
 * this reason; the type makes passing its nullable prop straight through a
 * compile error rather than a silent empty view.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '@/app/harness/Modal';
import {
  agoText,
  ceilingLine,
  killCriterionLine,
  partitionProjects,
  spendStack,
  tripwireBars,
  type GoalDetailInput,
  type GoalDetailProject,
  type TripwireBar,
} from './goal-detail-model';

export default function GoalDetailPanel({
  goalId,
  workspaceId,
  nowMs,
  onClose,
  onOpenWorkItem,
}: {
  /** The open goal — null renders nothing (closed). */
  goalId: string | null;
  /** The REAL workspace — never the nullable prop. See the docblock. */
  workspaceId: string;
  nowMs: number;
  onClose: () => void;
  /** Opens a work item in the HUD's existing popup, so the waiting-on-you and
   *  activity rows are destinations rather than dead text. */
  onOpenWorkItem?: (id: string) => void;
}) {
  const open = goalId !== null;
  const detail = useSyncQuery<GoalDetailInput>({
    queryName: 'goals.detail',
    args: { workspaceId, goalId: goalId ?? '' },
    enabled: open,
  });

  // Single row wrapping the object — the shape goals.list and
  // automation.catalog already use.
  const data = detail.data?.[0] ?? null;
  const goal = data?.goal ?? null;

  const bars = useMemo(() => tripwireBars(goal), [goal]);
  const criterion = useMemo(() => killCriterionLine(goal), [goal]);
  const ceiling = useMemo(() => ceilingLine(goal), [goal]);
  const projects = useMemo(() => partitionProjects(data?.projects), [data?.projects]);
  const stack = useMemo(() => spendStack(data?.spendByDay), [data?.spendByDay]);

  const waiting = data?.waitingOnYou ?? [];
  const activity = data?.activity ?? [];

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={goal?.title?.trim() || goalId || 'Goal'}
      description="Goal detail"
      srOnlyTitle
      contentStyle={{ width: 'min(920px, 100%)' }}
    >
      <div className="hud-goal" data-testid="goal-detail">
        <header className="hud-goal__head">
          <div className="hud-goal__title-row">
            <h2 className="hud-goal__title">{goal?.title?.trim() || goalId}</h2>
            {goal?.status ? <span className="hud__chip hud__chip--mode">{goal.status}</span> : null}
          </div>
          {goal?.body?.trim() ? <p className="hud-goal__body">{goal.body.trim()}</p> : null}
        </header>

        {detail.loading && !data ? <p className="hud__state">Loading goal…</p> : null}
        {detail.error ? (
          <p className="hud__state hud__state--error">Could not load this goal: {String(detail.error)}</p>
        ) : null}
        {!detail.loading && !detail.error && data && !goal ? (
          <p className="hud__state">
            This goal no longer exists. It may have been deleted since the board last loaded.
          </p>
        ) : null}

        {goal ? (
          <>
            {/* ── 1. THIS GOAL ENDS WHEN ──────────────────────────────────
                First, and first for a reason: it is the only section that says
                when the goal STOPS. Everything below it describes activity,
                which a goal with no stopping condition will produce forever. */}
            <section className="hud-goal__section hud-goal__section--ends">
              <h3 className="hud-goal__h">This goal ends when</h3>
              <p
                className={`hud-goal__criterion${criterion.missing ? ' hud-goal__criterion--missing' : ''}`}
                data-testid="goal-kill-criterion"
              >
                {criterion.text}
              </p>

              {/* Bars are OPTIONAL. A free-text criterion with none is the
                  normal case and renders as prose alone — no empty chart, no
                  "0 tripwires" placeholder implying something is missing. */}
              {bars.length > 0 ? (
                <ul className="hud-goal__bars" data-testid="goal-tripwires">
                  {bars.map((b) => (
                    <TripwireRow key={b.key} bar={b} />
                  ))}
                </ul>
              ) : null}

              <div className="hud-goal__ceiling" title={data?.spendNote ?? undefined}>
                <span className="hud-goal__ceiling-label">{data?.spendLabel ?? 'fleet spend'}</span>
                <span
                  className={`hud-goal__ceiling-value${ceiling.over ? ' hud-goal__ceiling-value--over' : ''}`}
                >
                  {ceiling.text}
                </span>
              </div>
            </section>

            {/* ── 2. WAITING ON YOU ───────────────────────────────────────
                Above projects and activity because it is the only section the
                owner can ACT on — the rest is read-only reporting. */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">
                Waiting on you
                {waiting.length > 0 ? <span className="hud__chip hud__chip--warn">{waiting.length}</span> : null}
              </h3>
              {waiting.length === 0 ? (
                <p className="hud-goal__empty">Nothing is parked on you.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {waiting.map((w) => (
                    <li key={w.id} className="hud-goal__row">
                      <RowButton id={w.id} title={w.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {w.harnessSlug ?? '—'} · {agoText(w.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 3. PROJECTS ─────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">Projects</h3>
              {projects.active.length === 0 && projects.removed.length === 0 ? (
                <p className="hud-goal__empty">No projects serve this goal yet.</p>
              ) : null}
              {projects.active.length > 0 ? (
                <div className="hud-goal__grid" data-testid="goal-projects">
                  {projects.active.map((p) => (
                    <ProjectCard key={p.harnessSlug} project={p} />
                  ))}
                </div>
              ) : null}

              {/* Killed projects STAY, greyed. If they vanished, the page would
                  only ever show growth — and "the agent actually closes things"
                  is the one behaviour the owner most needs to confirm, so it
                  must stay visible exactly when it is working. */}
              {projects.removed.length > 0 ? (
                <>
                  <h4 className="hud-goal__h4">Closed ({projects.removed.length})</h4>
                  <div className="hud-goal__grid" data-testid="goal-projects-closed">
                    {projects.removed.map((p) => (
                      <ProjectCard key={p.harnessSlug} project={p} nowMs={nowMs} />
                    ))}
                  </div>
                </>
              ) : null}
            </section>

            {/* ── 4. ACTIVITY ─────────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">Activity</h3>
              {activity.length === 0 ? (
                <p className="hud-goal__empty">Nothing has moved under this goal yet.</p>
              ) : (
                <ul className="hud-goal__rows">
                  {activity.map((a) => (
                    <li key={a.id} className="hud-goal__row">
                      <span
                        className={`hud__dot hud__dot--${a.closedAt ? 'done' : 'working'}`}
                        aria-hidden="true"
                      />
                      <RowButton id={a.id} title={a.title} onOpen={onOpenWorkItem} />
                      <span className="hud-goal__row-meta">
                        {a.closedAt ? 'closed' : (a.status ?? 'open')} ·{' '}
                        {agoText(a.updatedAt, nowMs) ?? 'unknown age'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── 5. SPEND BY DAY ─────────────────────────────────────────── */}
            <section className="hud-goal__section">
              <h3 className="hud-goal__h">{data?.spendLabel ?? 'fleet spend'} by day</h3>
              {/* D-021: per-goal spend figures do NOT sum across goals — a
                  shared project counts in full against each. The caveat rides
                  with the chart because this is the section most likely to be
                  screenshotted into a report. */}
              {data?.spendNote ? <p className="hud-goal__note">{data.spendNote}</p> : null}
              {stack.days.length === 0 ? (
                <p className="hud-goal__empty">No spend recorded for this goal yet.</p>
              ) : (
                <div className="hud-goal__chart" data-testid="goal-spend-chart">
                  {stack.days.map((d) => (
                    <div
                      key={d.day}
                      className="hud-goal__col"
                      title={`${d.day} · $${d.totalUsd.toFixed(2)}`}
                    >
                      <div className="hud-goal__col-track">
                        <div className="hud-goal__col-fill" style={{ height: `${d.heightPct}%` }}>
                          {d.slices.map((s) => (
                            <span
                              key={s.harnessSlug}
                              className="hud-goal__slice"
                              style={{ height: `${s.pct}%` }}
                              title={`${s.harnessSlug} · $${s.costUsd.toFixed(2)}`}
                            />
                          ))}
                        </div>
                      </div>
                      <span className="hud-goal__col-label">{d.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        <footer className="hud-goal__foot">
          <button type="button" className="hud-goal__close" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}

/** A work-item row. A button only when there is somewhere to go — the dead
 *  `<button>` WI-6742 filed was a card rendered clickable with no handler. */
function RowButton({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen?: (id: string) => void;
}) {
  if (!onOpen) return <span className="hud-goal__row-title">{title}</span>;
  return (
    <button type="button" className="hud-goal__row-title hud-goal__row-title--link" onClick={() => onOpen(id)}>
      {title}
    </button>
  );
}

function TripwireRow({ bar }: { bar: TripwireBar }) {
  return (
    <li className={`hud-goal__bar hud-goal__bar--${bar.tone}`} title={bar.title}>
      <span className="hud-goal__bar-label">{bar.label}</span>
      <span className="hud-goal__bar-track">
        {/* An unread tripwire gets NO fill at all — not a zero-width one. A
            0% bar and "nobody measured this" must not look identical. */}
        {bar.pct == null ? (
          <span className="hud-goal__bar-unread" />
        ) : (
          <span className="hud-goal__bar-fill" style={{ width: `${bar.pct}%` }} />
        )}
      </span>
      <span className="hud-goal__bar-value">{bar.valueText}</span>
    </li>
  );
}

function ProjectCard({ project, nowMs }: { project: GoalDetailProject; nowMs?: number }) {
  const removedAgo = nowMs != null ? agoText(project.removedAt, nowMs) : null;
  return (
    <article className={`hud-goal__proj${project.removed ? ' hud-goal__proj--removed' : ''}`}>
      <div className="hud-goal__proj-head">
        <span className="hud-goal__proj-slug">{project.harnessSlug}</span>
        {project.role === 'owner' ? <span className="hud__chip hud__role">main</span> : null}
        {project.sharedBadge ? <span className="hud__chip">{project.sharedBadge}</span> : null}
      </div>
      <p
        className={`hud-goal__proj-crit${project.killCriterionMissing ? ' hud-goal__proj-crit--missing' : ''}`}
      >
        {project.killCriterionText}
      </p>
      <div className="hud-goal__proj-meta">
        <span>${Math.round(project.spendUsd ?? 0).toLocaleString('en-US')}</span>
        <span>{project.openWorkItems ?? 0} open</span>
        {project.removed ? <span>closed{removedAgo ? ` ${removedAgo}` : ''}</span> : null}
      </div>
      {/* The note is the REASON a project was closed — the whole value of
          keeping killed projects on the page. */}
      {project.removed && project.note?.trim() ? (
        <p className="hud-goal__proj-note">{project.note.trim()}</p>
      ) : null}
    </article>
  );
}
