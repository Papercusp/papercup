'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * HiveWorkspaceCards — the all-mode (`?scope=all`) workspace view for the
 * Harnesses tab (harnesses-tab-hive-model-2026-06-07 P-003 / D-003).
 *
 * Under "All Pots" the tab used to keep rendering one stale single-harness
 * dock (the shell deliberately left `?slug=` holding the last harness). This
 * replaces that with a hive-grouped overview: one card per hive (root +
 * members, from `groupByHive`). Clicking a member drills in — the caller sets
 * BOTH axes (`?slug=` hive, `?harness=` member) sequentially and exits
 * all-mode (the documented nuqs same-tick collision pattern).
 *
 * Presentational; labels route through `useLexicon` (D-006). The liveness dot
 * reuses the `hasState` flag already in the projects/lite payload — no new
 * poller.
 */

import { Boxes, Home, Plus, Share2 } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import { HIVE_KIND, type HiveGroup } from './harness-hive-groups';

export interface HiveWorkspaceCardsProps {
  /** One group per hive (root + members), from `groupByHive`. */
  groups: readonly HiveGroup[];
  /** The active workspace's display name — the root header above the hive cards (mirrors the selector tree). */
  workspaceLabel?: string;
  /** Drill into a member — caller writes `?slug=`(hive) + `?harness=`(member) and exits all-mode. */
  onDrill: (hiveSlug: string, memberSlug: string) => void;
  /** Open the create flow from the empty state. */
  onCreate?: () => void;
}

export default function HiveWorkspaceCards({ groups, workspaceLabel, onDrill, onCreate }: HiveWorkspaceCardsProps) {
  const t = useLexicon();
  const hiveLabel = t('pot');
  const hivesLabel = t('pot', { plural: true });
  const membersLabel = t('harness', { plural: true });

  if (groups.length === 0) {
    return (
      <div className="pc-hive-cards pc-hive-cards--empty" data-testid="hive-workspace-cards">
        <div>No {hivesLabel.toLowerCase()} yet.</div>
        {onCreate && (
          <button type="button" className="pc-hive-cards__create" onClick={onCreate}>
            <Plus size={14} aria-hidden /> Create new {hiveLabel.toLowerCase()}
          </button>
        )}
        <CardStyles />
      </div>
    );
  }

  return (
    <div className="pc-hive-cards" data-testid="hive-workspace-cards">
      {workspaceLabel && (
        <div className="pc-hive-cards__ws-header" title={`Workspace: ${workspaceLabel}`}>
          <Boxes size={13} aria-hidden />
          <span className="pc-hive-cards__ws-name">{workspaceLabel}</span>
          <span className="pc-hive-cards__ws-count">{groups.length} {hivesLabel.toLowerCase()}</span>
        </div>
      )}
      <div className="pc-hive-cards__grid">
        {groups.map((g) => {
          // The hive HOME (`harness_kind:'hive'`) is the card itself — its name is
          // the header. It must NOT also render as a member row, or a hive + its
          // one harness read as two flat siblings. List only the real member
          // harnesses; a LEGACY root (a real harness that's its own root) stays.
          const rootIsHiveHome = g.root.harness_kind === HIVE_KIND;
          const memberRows = rootIsHiveHome
            ? g.members.filter((m) => m.slug !== g.root.slug)
            : g.members;
          const memberCount = memberRows.length;
          return (
            <section
              key={g.root.slug}
              className="pc-hive-cards__card"
              data-testid={`hive-card-${g.root.slug}`}
            >
              <Tooltip label={`Open ${g.root.slug}`}><button
                type="button"
                className="pc-hive-cards__card-head"

                onClick={() => onDrill(g.root.slug, g.root.slug)}
              >
                <Boxes size={15} className="pc-hive-cards__card-icon" aria-hidden />
                <span className="pc-hive-cards__card-name">{g.root.slug}</span>
                {g.root.is_shared && (
                  <Share2 size={12} className="pc-hive-cards__shared" aria-label="Shared" />
                )}
                <span className="pc-hive-cards__card-count" title={`${memberCount} ${membersLabel.toLowerCase()}`}>
                  {memberCount}
                </span>
              </button></Tooltip>
              <ul className="pc-hive-cards__members" role="list">
                {memberRows.map((m) => {
                  const isRoot = m.slug === g.root.slug;
                  const live = !!m.hasState;
                  return (
                    <li key={m.slug}>
                      <Tooltip label={m.slug}><button
                        type="button"
                        data-testid={`hive-member-${m.slug}`}
                        className="pc-hive-cards__member"

                        onClick={() => onDrill(g.root.slug, m.slug)}
                      >
                        <span
                          className={`pc-hive-cards__dot${live ? ' is-live' : ''}`}
                          title={live ? 'Harness has state' : 'Not set up yet'}
                          aria-hidden
                        />
                        <span className="pc-hive-cards__member-name">{m.slug}</span>
                        {isRoot && (
                          <Home size={11} className="pc-hive-cards__root" aria-label={`${hiveLabel} root`} />
                        )}
                        {m.harness_kind && m.harness_kind !== 'harness' && (
                          <span className="pc-hive-cards__kind">{m.harness_kind}</span>
                        )}
                      </button></Tooltip>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <CardStyles />
    </div>
  );
}

function CardStyles() {
  return (
    <style>{`
      .pc-hive-cards {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 16px;
      }
      .pc-hive-cards--empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        color: var(--fg-mute, #7f9bb4);
        font-size: 13px;
        text-align: center;
      }
      .pc-hive-cards__create {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
        color: var(--fg, #e7f7ff);
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .pc-hive-cards__create:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 65%); }
      .pc-hive-cards__ws-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--fg-mute, #7f9bb4);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .pc-hive-cards__ws-name {
        color: var(--fg, #e7f7ff);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-hive-cards__ws-count {
        margin-left: auto;
        font-weight: 600;
        text-transform: none;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
        font-variant-numeric: tabular-nums;
      }
      .pc-hive-cards__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
        gap: 14px;
        align-content: start;
      }
      .pc-hive-cards__card {
        display: flex;
        flex-direction: column;
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
        border-radius: 10px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 93%);
        overflow: hidden;
      }
      .pc-hive-cards__card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        border: none;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--fg, #e7f7ff);
        font-size: 13.5px;
        font-weight: 700;
        text-align: left;
        cursor: pointer;
      }
      .pc-hive-cards__card-head:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 76%); }
      .pc-hive-cards__card-icon { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-hive-cards__card-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-hive-cards__shared { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-hive-cards__card-count {
        flex: 0 0 auto;
        font-size: 10.5px;
        font-weight: 700;
        padding: 1px 7px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-hive-cards__members {
        list-style: none;
        margin: 0;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .pc-hive-cards__member {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 6px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        color: var(--fg-dim, #b9d4e8);
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }
      .pc-hive-cards__member:hover {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--fg, #e7f7ff);
      }
      .pc-hive-cards__dot {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--fg-dim, #b9d4e8), transparent 72%);
        box-shadow: inset 0 0 0 1px var(--bg-3, rgba(255, 255, 255, 0.075));
      }
      .pc-hive-cards__dot.is-live {
        background: var(--good, #34d399);
        box-shadow: 0 0 6px color-mix(in srgb, var(--good, #34d399), transparent 40%);
      }
      .pc-hive-cards__member-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-hive-cards__root { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-hive-cards__kind {
        flex: 0 0 auto;
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
    `}</style>
  );
}
