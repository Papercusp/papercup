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
 * Inline graduation-eligible prompts (P-032) still need the graduation engine
 * (B-16) and stay a labelled placeholder until that lands.
 */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { Checkbox } from '../../harness/Checkbox';
import { CeilingSlider, CEILING_SHORT_LABEL, type Ceiling } from './CeilingSlider';
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

export default function AutonomySettingsPage() {
  const { data, loading, error } = useSyncQuery<PolicyRow>({ queryName: 'autonomy.policy' });
  const rows = useMemo<PolicyRow[]>(() => data ?? [], [data]);

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

  const applyChange = useCallback(
    async (row: PolicyRow, patch: Partial<Pick<PolicySetArgs, 'ceiling' | 'locked'>>, reason: string) => {
      setSavingCat(row.category);
      try {
        await setPolicy({ category: row.category, reason, ...patch });
        // The write fires notifySyncInvalidate('autonomy.policy') server-side, so
        // useSyncQuery refetches the new row — no optimistic local state needed.
      } catch (err) {
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

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        filter === 'all' ? true : filter === 'protected' ? r.protected : !r.protected,
      ),
    [rows, filter],
  );

  return (
    <div>
      <h1>Autonomy</h1>
      <p className="pc-settings-intro">
        Per-category ceilings for what the Papercup Queen may decide on her own versus escalate to
        you. Nothing auto-runs until you raise a category’s ceiling <em>and</em> it earns a track
        record within that cap — and the whole policy stays off until autonomy is armed (still
        pending). Protected categories (release &amp; deploy, spend, credentials, system control) are
        locked at never-auto.
      </p>

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

      <section className="pc-settings-section" aria-label="Autonomy categories">
        {visible.map((row) => {
          const isSelected = selected === row.category;
          const saving = savingCat === row.category;
          return (
            <div
              key={row.category}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 8,
                background: 'var(--bg)',
                opacity: saving ? 0.7 : 1,
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
                {/* Category identity */}
                <button
                  type="button"
                  onClick={() => void setSelected(isSelected ? null : row.category)}
                  aria-expanded={isSelected}
                  style={{
                    flex: '1 1 200px',
                    minWidth: 180,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{row.label}</span>
                  {row.protected && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--warn)',
                        border: '1px solid var(--warn)',
                        borderRadius: 4,
                        padding: '0 5px',
                      }}
                    >
                      Protected
                    </span>
                  )}
                  {!row.protected && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-mute)', marginTop: 2 }}>
                      {POSTURE_LABEL[row.suggestedPosture] ?? row.suggestedPosture}
                    </span>
                  )}
                </button>

                {/* Ceiling slider */}
                <div style={{ flex: '0 0 auto' }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 2 }}>Ceiling</div>
                  <CeilingSlider
                    value={row.ceiling}
                    disabled={saving}
                    ariaLabel={`${row.label} risk ceiling`}
                    onChange={(next) => void onCeiling(row, next)}
                  />
                </div>

                {/* Graduated (read-only) */}
                <div style={{ flex: '0 0 auto', minWidth: 78 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 4 }}>Graduated</div>
                  <span style={levelChipStyle(row.graduatedLevel)} title="Earned level — read-only (rises via graduation, B-16)">
                    {CEILING_SHORT_LABEL[row.graduatedLevel]}
                  </span>
                </div>

                {/* Effective */}
                <div style={{ flex: '0 0 auto', minWidth: 78 }}>
                  <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 4 }}>Effective</div>
                  <span style={levelChipStyle(row.effectiveCeiling)} title={effectiveSummary(row)}>
                    {row.effectiveCeiling === 'never-auto' ? 'None' : CEILING_SHORT_LABEL[row.effectiveCeiling]}
                  </span>
                </div>

                {/* Lock toggle */}
                <label
                  style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}
                >
                  <Checkbox
                    checked={row.locked}
                    disabled={saving}
                    ariaLabel={`Lock ${row.label} (never auto)`}
                    onChange={(checked) => onLock(row, checked)}
                  />
                  <span style={{ color: 'var(--fg-mute)' }}>Never-auto</span>
                </label>
              </div>

              {/* Selected-row detail */}
              {isSelected && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--fg-mute)' }}>
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

      {/* ── Deferred: P-032 inline graduation-eligible prompts (needs B-16 graduation engine) ── */}
      <section className="pc-settings-section" aria-label="Graduation" style={{ marginTop: 8 }}>
        <h2>Graduation</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Graduation-eligible prompts — where you ratify a category earning a higher level — arrive
          with the graduation engine (B-16 · P-032).{' '}
          <span style={{ fontStyle: 'italic' }}>Coming soon.</span>
        </p>
      </section>
    </div>
  );
}
