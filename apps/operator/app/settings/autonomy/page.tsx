'use client';

/**
 * /settings/autonomy — the owner control surface for the Queen autonomy policy
 * (queen-autonomy-policy-2026-06-13 B-15 / P-030).
 *
 * A table of the 13 autonomy categories; per row a risk-ceiling slider, the
 * earned graduated level (read-only), the derived effective level, and a lock
 * toggle. Reads the live policy via `useSyncQuery('autonomy.policy')`; writes one
 * category at a time through the loopback `autonomy-policy-set` route (which
 * re-invalidates the query). nuqs holds the filter + selected category.
 *
 * Scope note: the page CORE ships here. The "recent auto-decisions" feed (P-031)
 * is now live — <RecentAutoDecisions/> renders the decision ledger's disposition
 * layer via the `decision.ledger` sync query (queen-autonomy B-13 / P-113);
 * per-row one-click undo lights up once B-16's tripwire records a revert handle.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { Checkbox } from '../../harness/Checkbox';
import { CeilingSlider, CEILING_LEVELS, CEILING_SHORT_LABEL, type Ceiling } from './CeilingSlider';
import RecentAutoDecisions from './RecentAutoDecisions';

/* ── Wire type — mirrors AutonomyPolicyView (operator-core/lib/autonomy/policy-view.ts),
 *    kept local per the client wire-type decoupling convention. ── */
interface PolicyRow {
  category: string;
  ceiling: Ceiling;
  locked: boolean;
  graduatedLevel: Ceiling;
  effectiveCeiling: Ceiling;
  ownerOverride: Record<string, unknown> | null;
  label: string;
  protected: boolean;
  suggestedPosture: string;
  covers: string;
}

interface PolicySetArgs {
  category: string;
  ceiling?: Ceiling;
  locked?: boolean;
  graduatedLevel?: Ceiling;
  reason: string;
}

/** REST fallback the sync-mutate hook calls (every transport on desktop SSE). */
async function autonomyPolicySetRest(args: PolicySetArgs): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent-mcp/autonomy-policy-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) {
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return { ok: true };
}

const FILTERS = ['all', 'configurable', 'protected'] as const;
type Filter = (typeof FILTERS)[number];

const POSTURE_LABEL: Record<string, string> = {
  'early-autonomy': 'Early autonomy',
  'low-risk': 'Low risk',
  'risk-graded': 'Risk-graded',
  mixed: 'Mixed',
  protected: 'Protected',
};

/** Plain-language summary of why `effective` is what it is (D-005 — the
 *  ceiling/graduated/effective split that must not read as a bug). */
function effectiveSummary(row: PolicyRow): string {
  if (row.locked) return 'Locked — nothing in this category auto-runs.';
  if (row.effectiveCeiling === 'never-auto') {
    if (row.ceiling === 'never-auto') return 'No ceiling set — nothing auto-runs.';
    return `Ceiling is ${CEILING_SHORT_LABEL[row.ceiling]}, but nothing auto-runs until this category earns a graduated level (currently none).`;
  }
  return `Auto-runs ${CEILING_SHORT_LABEL[row.effectiveCeiling]}-risk and below — the lower of your ceiling (${CEILING_SHORT_LABEL[row.ceiling]}) and the earned level (${CEILING_SHORT_LABEL[row.graduatedLevel]}).`;
}

/** Lower-of-two ceilings by ordinal (mirrors operator-core `minCeiling`). */
function minCeiling(a: Ceiling, b: Ceiling): Ceiling {
  return CEILING_LEVELS.indexOf(a) <= CEILING_LEVELS.indexOf(b) ? a : b;
}
/** Effective ceiling = min(ceiling, graduated); never-auto when locked (B-03). */
function deriveEffective(ceiling: Ceiling, graduated: Ceiling, locked: boolean): Ceiling {
  return locked ? 'never-auto' : minCeiling(ceiling, graduated);
}

function levelChipStyle(level: Ceiling): CSSProperties {
  const off = level === 'never-auto';
  return {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    color: off ? 'var(--fg-mute)' : 'var(--accent)',
    background: off
      ? 'color-mix(in srgb, var(--fg-mute), transparent 88%)'
      : 'color-mix(in srgb, var(--accent), transparent 85%)',
  };
}

/* Shared column template so the header row and every category row line up as a
 * single-line table (B-15 compact pass): Category | Ceiling | Graduated |
 * Effective | Never-auto. box-sizing keeps the header (no border) aligned with
 * the bordered rows. */
const GRID_COLUMNS = 'minmax(140px, 1fr) 210px 62px 62px 56px';
/** Floor so the row stays a single line on narrow panes (the section scrolls
 *  horizontally instead of wrapping — the whole point of the compact pass). */
const ROW_MIN_WIDTH = 620;
const ROW_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID_COLUMNS,
  columnGap: 14,
  alignItems: 'center',
};

export default function AutonomySettingsPage() {
  const { data, loading, error } = useSyncQuery<PolicyRow>({ queryName: 'autonomy.policy' });
  const rows = useMemo<PolicyRow[]>(() => data ?? [], [data]);
  // The master switch (P-092). The whole policy is dormant unless this is on, so
  // the page must SHOW it — a stale "armed is pending" claim is what hid that
  // autonomy was already live. Owner flips it via /admin/features, not here.
  const armed = useFlag(FLAGS.QUEEN_AUTONOMY_ARMED);

  const [filter, setFilter] = useQueryState(
    'filter',
    parseAsStringEnum<Filter>([...FILTERS]).withDefault('all'),
  );
  const [selected, setSelected] = useQueryState('cat', parseAsString);

  const setPolicy = useSyncMutate<PolicySetArgs, { ok: boolean; error?: string }>(
    'autonomy.policySet',
    autonomyPolicySetRest,
  );
  const [savingCat, setSavingCat] = useState<string | null>(null);

  // Optimistic overlay — the slider/lock must move on CLICK, not on the SSE
  // round-trip. Each patch is applied locally the instant the owner clicks, then
  // reconciled away once the server's autonomy.policy refetch reports the same
  // value (the effect below); a failed write drops the entry so the row snaps back
  // to server truth. Without this the dot only moves after the invalidation push,
  // and a slow/dropped SSE event leaves it stuck until the 180s drift-repair poll —
  // the "doesn't always work" flakiness.
  const [optimistic, setOptimistic] = useState<
    Record<string, Partial<Pick<PolicyRow, 'ceiling' | 'locked'>>>
  >({});

  // Reconcile: once server rows reflect an optimistic patch, drop it so later
  // server-driven changes (e.g. a graduation demotion) aren't masked by stale local state.
  useEffect(() => {
    setOptimistic((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const r of rows) {
        const o = next[r.category];
        if (!o) continue;
        const ceilingOk = o.ceiling === undefined || o.ceiling === r.ceiling;
        const lockedOk = o.locked === undefined || o.locked === r.locked;
        if (ceilingOk && lockedOk) {
          delete next[r.category];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const applyChange = useCallback(
    async (row: PolicyRow, patch: Partial<Pick<PolicySetArgs, 'ceiling' | 'locked'>>, reason: string) => {
      // Apply optimistically first so the control moves on click.
      setOptimistic((o) => ({ ...o, [row.category]: { ...o[row.category], ...patch } }));
      setSavingCat(row.category);
      try {
        await setPolicy({ category: row.category, reason, ...patch });
        // The server fires notifySyncInvalidate('autonomy.policy'); the refetch
        // reconciles (and clears) the optimistic entry via the effect above.
      } catch (err) {
        // Roll back to server truth on failure.
        setOptimistic((o) => {
          const next = { ...o };
          delete next[row.category];
          return next;
        });
        toast.error(`Couldn't update ${row.label}: ${err instanceof Error ? err.message : 'failed'}`);
      } finally {
        setSavingCat(null);
      }
    },
    [setPolicy],
  );

  const onCeiling = (row: PolicyRow, next: Ceiling) =>
    applyChange(row, { ceiling: next }, `Owner set ${row.label} ceiling to ${next}`);

  const onLock = (row: PolicyRow, checked: boolean) => {
    if (row.protected && !checked) {
      // Unlocking a never-auto protected category is a heavy, deliberate authority
      // action (D-005/D-010) — confirm before it leaves the protected set.
      toast(`Unlock protected category “${row.label}”? It will no longer be never-auto.`, {
        action: {
          label: 'Unlock',
          onClick: () =>
            void applyChange(row, { locked: false }, `Owner unlocked protected category ${row.label}`),
        },
      });
      return;
    }
    void applyChange(row, { locked: checked }, `Owner ${checked ? 'locked' : 'unlocked'} ${row.label}`);
  };

  // Server rows with any pending optimistic patch applied (ceiling/lock + the
  // derived effective level), so the table reflects clicks immediately.
  const mergedRows = useMemo<PolicyRow[]>(
    () =>
      rows.map((r) => {
        const o = optimistic[r.category];
        if (!o) return r;
        const ceiling = o.ceiling ?? r.ceiling;
        const locked = o.locked ?? r.locked;
        return { ...r, ceiling, locked, effectiveCeiling: deriveEffective(ceiling, r.graduatedLevel, locked) };
      }),
    [rows, optimistic],
  );

  const visible = useMemo(
    () =>
      mergedRows.filter((r) =>
        filter === 'all' ? true : filter === 'protected' ? r.protected : !r.protected,
      ),
    [mergedRows, filter],
  );

  return (
    <div>
      <h1>Autonomy</h1>
      <p className="pc-settings-intro">
        Per-category ceilings for what the Papercup Queen may decide on her own versus escalate to
        you. Nothing auto-runs until you raise a category’s ceiling <em>and</em> it earns a track
        record within that cap — and the whole policy only takes effect while autonomy is armed.
        Protected categories (release &amp; deploy, spend, credentials, system control) are locked at
        never-auto.
      </p>

      <div
        role="status"
        style={{
          marginBottom: 16,
          padding: '10px 14px',
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.45,
          border: `1px solid ${armed ? 'var(--accent)' : 'var(--border)'}`,
          background: armed
            ? 'color-mix(in srgb, var(--accent), transparent 88%)'
            : 'var(--bg-2)',
          color: 'var(--fg)',
        }}
      >
        {armed ? (
          <>
            <strong>Autonomy is armed.</strong> Categories whose <em>Effective</em> level is above{' '}
            <em>None</em> can auto-run now (decisions at that risk and below, reversible, not
            owner-only). Lower a ceiling or lock a category to pull it back.
          </>
        ) : (
          <>
            <strong>Autonomy is not armed.</strong> Nothing auto-runs regardless of the ceilings
            below — every decision still routes to you. Arming is the master switch (flag{' '}
            <code>papercusp-queen-autonomy-armed</code>, set in <code>/admin/features</code>).
          </>
        )}
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', marginBottom: 16, fontSize: 13 }}>
          Couldn’t load the policy: {error.message}
        </p>
      )}
      {loading && rows.length === 0 && (
        <p role="status" style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 13 }}>
          Loading autonomy policy…
        </p>
      )}

      <div role="tablist" aria-label="Filter categories" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void setFilter(f === 'all' ? null : f)}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 13,
                textTransform: 'capitalize',
                cursor: 'pointer',
                border: '1px solid var(--border)',
                background: active ? 'var(--accent)' : 'var(--bg-2)',
                color: active ? 'var(--accent-fg, #fff)' : 'var(--fg)',
              }}
            >
              {f}
            </button>
          );
        })}
      </div>

      <section className="pc-settings-section" aria-label="Autonomy categories" style={{ overflowX: 'auto' }}>
        {visible.length > 0 && (
          <div
            aria-hidden="true"
            style={{
              ...ROW_GRID,
              boxSizing: 'border-box',
              minWidth: ROW_MIN_WIDTH,
              padding: '0 13px 6px',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0',
              textTransform: 'uppercase',
              color: 'var(--fg-mute)',
            }}
          >
            <span>Category</span>
            <span>Ceiling</span>
            <span style={{ textAlign: 'center' }}>Graduated</span>
            <span style={{ textAlign: 'center' }}>Effective</span>
            <span style={{ textAlign: 'center' }}>Never-auto</span>
          </div>
        )}

        {visible.map((row) => {
          const isSelected = selected === row.category;
          const saving = savingCat === row.category;
          return (
            <div
              key={row.category}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '6px 12px',
                marginBottom: 6,
                background: 'var(--bg)',
                opacity: saving ? 0.7 : 1,
                boxSizing: 'border-box',
                minWidth: ROW_MIN_WIDTH,
              }}
            >
              <div style={ROW_GRID}>
                {/* Category identity — label + (protected badge | posture) on one line */}
                <button
                  type="button"
                  onClick={() => void setSelected(isSelected ? null : row.category)}
                  aria-expanded={isSelected}
                  style={{
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      fontWeight: 600,
                      color: 'var(--fg)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {row.label}
                  </span>
                  {row.protected ? (
                    <span
                      style={{
                        flex: '0 0 auto',
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--warn)',
                        border: '1px solid var(--warn)',
                        borderRadius: 4,
                        padding: '0 5px',
                      }}
                    >
                      Protected
                    </span>
                  ) : (
                    <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--fg-mute)', whiteSpace: 'nowrap' }}>
                      {POSTURE_LABEL[row.suggestedPosture] ?? row.suggestedPosture}
                    </span>
                  )}
                </button>

                {/* Ceiling — compact dots + current level name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CeilingSlider
                    compact
                    value={row.ceiling}
                    disabled={saving}
                    ariaLabel={`${row.label} risk ceiling`}
                    onChange={(next) => void onCeiling(row, next)}
                  />
                  <span style={{ fontSize: 12, color: 'var(--fg-dim)', minWidth: 56, whiteSpace: 'nowrap' }}>
                    {CEILING_SHORT_LABEL[row.ceiling]}
                  </span>
                </div>

                {/* Graduated (read-only) */}
                <div style={{ textAlign: 'center' }}>
                  <span style={levelChipStyle(row.graduatedLevel)} title="Earned level — read-only (rises via graduation, B-16)">
                    {CEILING_SHORT_LABEL[row.graduatedLevel]}
                  </span>
                </div>

                {/* Effective */}
                <div style={{ textAlign: 'center' }}>
                  <span style={levelChipStyle(row.effectiveCeiling)} title={effectiveSummary(row)}>
                    {row.effectiveCeiling === 'never-auto' ? 'None' : CEILING_SHORT_LABEL[row.effectiveCeiling]}
                  </span>
                </div>

                {/* Lock toggle */}
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Checkbox
                    checked={row.locked}
                    disabled={saving}
                    ariaLabel={`Lock ${row.label} (never auto)`}
                    onChange={(checked) => onLock(row, checked)}
                  />
                </div>
              </div>

              {/* Selected-row detail */}
              {isSelected && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--fg-mute)' }}>
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ color: 'var(--fg)' }}>Covers: </span>
                    {row.covers || '—'}
                  </div>
                  <div>{effectiveSummary(row)}</div>
                </div>
              )}
            </div>
          );
        })}
        {!loading && visible.length === 0 && (
          <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>No categories match this filter.</p>
        )}
      </section>

      {/* P-031 recent-auto-decisions feed — a filtered view of the decision ledger's
          disposition layer (queen-autonomy B-13 / P-113). One-click undo per row
          lights up once B-16's tripwire records a revert handle. */}
      <RecentAutoDecisions />

    </div>
  );
}
